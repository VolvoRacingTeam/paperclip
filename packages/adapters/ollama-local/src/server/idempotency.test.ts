import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateIdempotencyKey,
  getOrCreateIdempotencyKey,
  pruneExpiredKeys,
} from "./idempotency.js";

describe("idempotency", () => {
  beforeEach(() => {
    pruneExpiredKeys(Number.MAX_SAFE_INTEGER);
    vi.useRealTimers();
  });

  it("returnerer samme nøkkel for samme payload innenfor TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T08:00:00.000Z"));

    const payload = { amount: 299, accountCode: "6300" };
    const first = getOrCreateIdempotencyKey("queue-1", payload);
    const second = getOrCreateIdempotencyKey("queue-1", payload);

    expect(second).toBe(first);
  });

  it("returnerer ulik nøkkel for ulik payload", () => {
    const first = getOrCreateIdempotencyKey("queue-1", { amount: 299 });
    const second = getOrCreateIdempotencyKey("queue-1", { amount: 300 });

    expect(second).not.toBe(first);
  });

  it("fjerner utløpt entry og genererer ny nøkkel", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T08:00:00.000Z"));

    const payload = { amount: 299, accountCode: "6300" };
    const first = getOrCreateIdempotencyKey("queue-1", payload);

    vi.setSystemTime(new Date("2026-04-18T08:00:01.000Z"));

    const removed = pruneExpiredKeys();
    const second = getOrCreateIdempotencyKey("queue-1", payload);

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(second).not.toBe(first);
  });

  it("genererer UUID v4-format", () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
