import { describe, expect, it, vi } from "vitest";

import { sweepPendingRetryReviews } from "../services/heartbeat.js";

/**
 * Pakke A unit-test: sweepPendingRetryReviews plukker opp PENDING_RETRY-rader
 * eldre enn 5 min og enqueuer wakeup med stabil idempotency-key. Mocker bare
 * den drizzle-query-kjeden som funksjonen faktisk bruker.
 */

function makeDbWithRows(rows: any[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: (cb: any) => Promise.resolve(rows).then(cb),
    })),
  } as any;
}

describe("sweepPendingRetryReviews (Pakke A)", () => {
  const baseRow = {
    id: "review-1",
    workerAgentId: "worker-1",
    managerAgentId: "manager-1",
    companyId: "company-1",
    taskType: "bookkeeping_post",
    taskPayload: { foo: 1 },
    attemptCount: 1,
  };
  const now = new Date("2026-04-24T12:00:00Z");
  const minuteBucket = Math.floor(now.getTime() / 60000);

  it("enqueuer wakeup for hver stale PENDING_RETRY-rad", async () => {
    const db = makeDbWithRows([baseRow]);
    const enqueueWakeup = vi.fn(async () => ({ id: "wakeup-1" }));
    const result = await sweepPendingRetryReviews({
      db,
      now,
      minuteBucket,
      enqueueWakeup,
    });
    expect(result.scanned).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.failed).toBe(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [agentId, opts] = enqueueWakeup.mock.calls[0];
    expect(agentId).toBe("worker-1");
    expect(opts.reason).toBe("pending_retry_sweep");
    expect(opts.idempotencyKey).toBe(`retry-sweep:review-1:${minuteBucket}`);
    expect(opts.contextSnapshot).toMatchObject({
      reviewId: "review-1",
      attemptCount: 1,
      originalTaskType: "bookkeeping_post",
    });
  });

  it("returnerer baseline-resultat naar ingen rader er stale", async () => {
    const db = makeDbWithRows([]);
    const enqueueWakeup = vi.fn();
    const result = await sweepPendingRetryReviews({
      db,
      now,
      minuteBucket,
      enqueueWakeup,
    });
    expect(result).toEqual({ scanned: 0, enqueued: 0, failed: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("teller failed og fortsetter naar enqueueWakeup kaster", async () => {
    const rowA = { ...baseRow, id: "review-A", workerAgentId: "worker-A" };
    const rowB = { ...baseRow, id: "review-B", workerAgentId: "worker-B" };
    const db = makeDbWithRows([rowA, rowB]);
    const enqueueWakeup = vi.fn(async (agentId: string) => {
      if (agentId === "worker-A") throw new Error("dedup-conflict");
      return { id: "wakeup-B" };
    });
    const log = { warn: vi.fn() };
    const result = await sweepPendingRetryReviews({
      db,
      now,
      minuteBucket,
      enqueueWakeup,
      log,
    });
    expect(result.scanned).toBe(2);
    expect(result.enqueued).toBe(1);
    expect(result.failed).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: "review-A" }),
      "pending_retry_sweep failed",
    );
  });

  it("idempotency-key bruker minuteBucket slik at samme minutt ikke spammer", async () => {
    const db = makeDbWithRows([baseRow]);
    const enqueueWakeup = vi.fn(async () => ({ id: "wakeup-1" }));
    await sweepPendingRetryReviews({ db, now, minuteBucket, enqueueWakeup });
    await sweepPendingRetryReviews({ db, now, minuteBucket, enqueueWakeup });
    const keys = enqueueWakeup.mock.calls.map((c: any[]) => c[1].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });
});
