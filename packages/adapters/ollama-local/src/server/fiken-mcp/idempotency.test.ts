import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashPayload,
  IdempotencyKeyConflictError,
  InMemoryAgentRunStateStore,
  MissingFikenCompanySlugError,
  ulid,
  ULID_LENGTH,
  _resetUlidState,
} from "./idempotency.js";

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulid", () => {
  beforeEach(() => {
    _resetUlidState();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetUlidState();
  });

  it("returns a 26-character Crockford Base32 string", () => {
    const id = ulid(Date.parse("2026-04-28T20:30:00Z"));
    expect(id).toHaveLength(ULID_LENGTH);
    expect(id).toMatch(ULID_REGEX);
  });

  it("encodes the timestamp in the leading 10 chars (sortable across ms)", () => {
    const earlier = ulid(1700000000000);
    const later = ulid(1700000001000);
    expect(later.slice(0, 10) > earlier.slice(0, 10)).toBe(true);
  });

  it("is monotonic within the same millisecond", () => {
    const ts = Date.parse("2026-04-28T20:30:00Z");
    const a = ulid(ts);
    const b = ulid(ts);
    const c = ulid(ts);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });

  it("rejects invalid timestamps", () => {
    expect(() => ulid(Number.NaN)).toThrow(/invalid timestamp/);
    expect(() => ulid(-1)).toThrow(/invalid timestamp/);
  });
});

describe("hashPayload", () => {
  it("is stable regardless of property order", () => {
    const a = hashPayload({ amount: 1000, accountCode: "6300" });
    const b = hashPayload({ accountCode: "6300", amount: 1000 });
    expect(a).toBe(b);
  });

  it("differs when payload differs", () => {
    const a = hashPayload({ amount: 1000 });
    const b = hashPayload({ amount: 1001 });
    expect(a).not.toBe(b);
  });

  it("treats undefined values as absent", () => {
    const a = hashPayload({ amount: 1000, note: undefined });
    const b = hashPayload({ amount: 1000 });
    expect(a).toBe(b);
  });
});

describe("InMemoryAgentRunStateStore.resolveStep", () => {
  let store: InMemoryAgentRunStateStore;

  beforeEach(() => {
    _resetUlidState();
    store = new InMemoryAgentRunStateStore();
  });

  it("creates a new ULID on first call for a (runId, stepIndex)", async () => {
    const res = await store.resolveStep({
      agentId: "agent-1",
      runId: "run-1",
      stepIndex: 0,
      payload: { amount: 1000 },
    });
    expect(res.isReplay).toBe(false);
    expect(res.isConflict).toBe(false);
    expect(res.step.idempotencyKey).toMatch(ULID_REGEX);
  });

  it("returns isReplay=true when the same payload is resolved again", async () => {
    const first = await store.resolveStep({
      agentId: "agent-1",
      runId: "run-1",
      stepIndex: 0,
      payload: { amount: 1000 },
    });
    const second = await store.resolveStep({
      agentId: "agent-1",
      runId: "run-1",
      stepIndex: 0,
      payload: { amount: 1000 },
    });
    expect(second.isReplay).toBe(true);
    expect(second.isConflict).toBe(false);
    expect(second.step.idempotencyKey).toBe(first.step.idempotencyKey);
  });

  it("returns isConflict=true when the same step has a different payload", async () => {
    await store.resolveStep({
      agentId: "agent-1",
      runId: "run-1",
      stepIndex: 0,
      payload: { amount: 1000 },
    });
    const conflict = await store.resolveStep({
      agentId: "agent-1",
      runId: "run-1",
      stepIndex: 0,
      payload: { amount: 9999 },
    });
    expect(conflict.isConflict).toBe(true);
    expect(conflict.isReplay).toBe(false);
  });

  it("treats different stepIndex as independent steps", async () => {
    const a = await store.resolveStep({
      agentId: "agent-1",
      runId: "run-1",
      stepIndex: 0,
      payload: { amount: 1 },
    });
    const b = await store.resolveStep({
      agentId: "agent-1",
      runId: "run-1",
      stepIndex: 1,
      payload: { amount: 1 },
    });
    expect(a.step.idempotencyKey).not.toBe(b.step.idempotencyKey);
  });

  it("getFikenCompanySlug returns null when unset", async () => {
    expect(await store.getFikenCompanySlug("agent-1")).toBeNull();
  });

  it("setFikenCompanySlug + getFikenCompanySlug round-trip", async () => {
    await store.setFikenCompanySlug?.("agent-1", "fiken-demo-total-blomst-as");
    expect(await store.getFikenCompanySlug("agent-1")).toBe("fiken-demo-total-blomst-as");
  });
});

describe("error types", () => {
  it("IdempotencyKeyConflictError carries diagnostic context", () => {
    const err = new IdempotencyKeyConflictError(
      "boom",
      "01HXYZ0123456789ABCDEFGHJK",
      "run-1",
      3,
    );
    expect(err.name).toBe("IdempotencyKeyConflictError");
    expect(err.idempotencyKey).toBe("01HXYZ0123456789ABCDEFGHJK");
    expect(err.runId).toBe("run-1");
    expect(err.stepIndex).toBe(3);
  });

  it("MissingFikenCompanySlugError mentions the agent", () => {
    const err = new MissingFikenCompanySlugError("agent-1");
    expect(err.message).toContain("agent-1");
    expect(err.name).toBe("MissingFikenCompanySlugError");
  });
});
