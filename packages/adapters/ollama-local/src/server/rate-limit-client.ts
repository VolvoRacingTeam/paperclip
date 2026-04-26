export interface RateLimitState {
  limit: number;
  remaining: number;
  resetEpoch: number;
}

function parseHeaderInt(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseRateLimitHeaders(headers: Headers): RateLimitState | null {
  const limit = parseHeaderInt(headers.get("X-RateLimit-Limit"));
  const remaining = parseHeaderInt(headers.get("X-RateLimit-Remaining"));
  const resetEpoch = parseHeaderInt(headers.get("X-RateLimit-Reset"));

  if (limit === null || remaining === null || resetEpoch === null) {
    return null;
  }

  return {
    limit,
    remaining,
    resetEpoch,
  };
}

export function computeBackoffMs(
  state: RateLimitState | null,
  opts?: { threshold?: number; nowMs?: number },
): number {
  if (!state) return 0;

  const threshold = opts?.threshold ?? 5;
  if (state.remaining > threshold) return 0;

  const nowMs = opts?.nowMs ?? Date.now();
  const resetMs = state.resetEpoch * 1000;
  return Math.max(0, resetMs - nowMs);
}

/**
 * Floor for any 429-backoff that falls back to header-derived state or to a
 * Retry-After value of 0. Without this, a stale resetEpoch (race condition)
 * or a misbehaving server can trigger a 1s busy-loop that hammers the API
 * for the full bucket window. Quinn finding #4.
 *
 * NOTE: A positive Retry-After header from the server is ALWAYS respected
 * verbatim — that is an explicit, intentional server directive.
 */
export const MIN_FALLBACK_BACKOFF_MS = 5_000;

export function backoffFor429(res: Response, nowMs?: number): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      // Explicit positive directive — respect verbatim.
      return seconds * 1000;
    }
    if (Number.isFinite(seconds) && seconds === 0) {
      // Retry-After: 0 is functionally equivalent to "no guidance" — apply floor.
      return MIN_FALLBACK_BACKOFF_MS;
    }

    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      const wait = Math.max(0, dateMs - (nowMs ?? Date.now()));
      // HTTP-date Retry-After in the past collapses to 0 — apply floor to
      // avoid busy-loop.
      return wait > 0 ? wait : MIN_FALLBACK_BACKOFF_MS;
    }
  }

  const state = parseRateLimitHeaders(res.headers);
  const fallback = computeBackoffMs(state, {
    threshold: Number.MAX_SAFE_INTEGER,
    nowMs,
  });
  // No Retry-After AND no usable header-derived wait → floor.
  // Also: header-derived wait < floor → floor (race-condition guard).
  return Math.max(fallback, MIN_FALLBACK_BACKOFF_MS);
}
