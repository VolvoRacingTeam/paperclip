import { createHash } from "node:crypto";

// Advarsel: In-memory cache — idempotency-nøkler overlever ikke prosessrestart.
// For produksjon bør dette persisteres til DB.
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 10_000;

type IdempotencyEntry = {
  idempotencyKey: string;
  expiresAtMs: number;
};

const idempotencyCache = new Map<string, IdempotencyEntry>();

function stableStringify(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }

  if (typeof value !== "object") {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

function payloadHash(payload: unknown): string {
  return createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
}

export function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function pruneExpiredKeys(nowMs = Date.now()): number {
  let removed = 0;

  for (const [lookupKey, entry] of idempotencyCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      idempotencyCache.delete(lookupKey);
      removed += 1;
    }
  }

  return removed;
}

export function pruneOldestKeys(maxSize = MAX_CACHE_SIZE): number {
  let removed = 0;

  while (idempotencyCache.size > maxSize) {
    const oldestKey = idempotencyCache.keys().next().value;
    if (oldestKey === undefined) break;
    idempotencyCache.delete(oldestKey);
    removed += 1;
  }

  return removed;
}

export function getOrCreateIdempotencyKey(queueId: string, payload: unknown): string {
  const nowMs = Date.now();
  pruneExpiredKeys(nowMs);

  const lookupKey = `${queueId}:${payloadHash(payload)}`;
  const existing = idempotencyCache.get(lookupKey);
  if (existing) {
    return existing.idempotencyKey;
  }

  const idempotencyKey = generateIdempotencyKey();
  idempotencyCache.set(lookupKey, {
    idempotencyKey,
    expiresAtMs: nowMs + IDEMPOTENCY_TTL_MS,
  });
  pruneOldestKeys();
  return idempotencyKey;
}
