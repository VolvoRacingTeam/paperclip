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

export function backoffFor429(res: Response, nowMs?: number): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  const state = parseRateLimitHeaders(res.headers);
  return computeBackoffMs(state, { threshold: Number.MAX_SAFE_INTEGER, nowMs });
}
