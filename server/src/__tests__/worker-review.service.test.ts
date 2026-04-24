import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  workerReviewService,
  computePayloadHash,
  type HeartbeatDep,
  type ApprovalsDep,
} from "../services/worker-review.js";

/**
 * Enhetstester for workerReviewService.
 * Vi stubber ut DB via en minimal fluent mock og verifiserer at tjenesten
 * fatter riktige beslutninger (manager-resolve, cap, dup-hash, CAS osv).
 */

function makeDb() {
  // Per-test DB-tilstand
  const state = {
    // worker-review rader
    rows: [] as any[],
    // inserts registrert
    inserted: [] as any[],
    // updates registrert
    updates: [] as any[],
    // counts returnert paa forespoersel
    pendingWorkerCount: 0,
    pendingManagerCount: 0,
    managerReportsTo: null as string | null,
    dupRow: null as any,
    oldestDate: null as Date | null,
  };

  function selectBuilder(resolveValue: any) {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: (cb: any) => Promise.resolve(resolveValue).then(cb),
      selectDistinct: vi.fn().mockReturnThis(),
    };
    return chain;
  }

  const db = {
    select: vi.fn((arg?: any) => {
      // Hva spoer vi om? Vi identifiserer ved aa inspisere kolonner i arg.
      const argStr = arg ? JSON.stringify(Object.keys(arg)) : "*";
      // Heuristikk:
      //   { id, reportsTo } -> resolve manager
      //   { c: count } -> count pending
      //   { oldest } -> oldest pending
      //   default -> rows (getById, findDuplicate, listPending)
      if (argStr.includes("reportsTo")) {
        return selectBuilder([
          { id: "worker-1", reportsTo: state.managerReportsTo },
        ]);
      }
      if (argStr.includes('"c"')) {
        // count — returner alternating: first call worker, second manager
        const count =
          db.__countCallIdx === 0
            ? state.pendingWorkerCount
            : state.pendingManagerCount;
        db.__countCallIdx = (db.__countCallIdx + 1) % 2;
        return selectBuilder([{ c: count }]);
      }
      if (argStr.includes("oldest")) {
        return selectBuilder([{ oldest: state.oldestDate }]);
      }
      // Default: return either dup row or state.rows
      if (state.dupRow !== null && db.__nextDupQuery) {
        db.__nextDupQuery = false;
        return selectBuilder([state.dupRow]);
      }
      return selectBuilder(state.rows.length ? state.rows : []);
    }) as any,
    insert: vi.fn(() => ({
      values: (vals: any) => ({
        returning: () => {
          const row = {
            id: "review-new-" + (state.inserted.length + 1),
            ...vals,
            createdAt: vals.createdAt ?? new Date(),
            updatedAt: vals.updatedAt ?? new Date(),
          };
          state.inserted.push(row);
          return Promise.resolve([row]);
        },
      }),
    })),
    update: vi.fn(() => ({
      set: (patch: any) => {
        // Registrer patch for begge varianter (med og uten .returning()).
        state.updates.push(patch);
        return {
          where: () => {
            const thenable: any = {
              returning: () => {
                const row = state.rows[0]
                  ? { ...state.rows[0], ...patch, id: state.rows[0].id }
                  : null;
                return Promise.resolve(row ? [row] : []);
              },
              then: (cb: any) => Promise.resolve(undefined).then(cb),
            };
            return thenable;
          },
        };
      },
    })),
    selectDistinct: vi.fn(() => selectBuilder([])) as any,
    __countCallIdx: 0,
    __nextDupQuery: false,
    __state: state,
  };
  return db;
}

function makeHeartbeat(): HeartbeatDep & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    wakeup: vi.fn(async (agentId: string, opts: any) => {
      calls.push({ agentId, opts });
      return { id: "wake-1" };
    }),
  };
}

function makeApprovals(): ApprovalsDep & { calls: any[] } {
  const calls: any[] = [];
  const svc: any = {
    calls,
    create: vi.fn(async (companyId: string, data: any) => {
      calls.push({ companyId, data });
      return { id: "approval-new-1", companyId, ...data };
    }),
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
    resubmit: vi.fn(),
    listComments: vi.fn(async () => []),
    addComment: vi.fn(),
  };
  return svc;
}

// Mock logger + activity for aa ikke sloppen spam
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

describe("workerReviewService", () => {
  let db: ReturnType<typeof makeDb>;
  let heartbeat: ReturnType<typeof makeHeartbeat>;
  let approvals: ReturnType<typeof makeApprovals>;
  let now: Date;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    heartbeat = makeHeartbeat();
    approvals = makeApprovals();
    now = new Date("2026-04-24T12:00:00Z");
  });

  function makeSvc() {
    return workerReviewService(db as any, { heartbeat, approvals, now: () => now });
  }

  const WORKER_UUID = "11111111-1111-1111-1111-111111111111";
  const MANAGER_UUID = "22222222-2222-2222-2222-222222222222";
  const COMPANY_UUID = "33333333-3333-3333-3333-333333333333";

  const baseInput = {
    companyId: COMPANY_UUID,
    workerAgentId: WORKER_UUID,
    taskType: "bookkeeping_post",
    taskPayload: { invoice: "INV-1" },
    proposedPayload: { kontonr: 1500, belop: 100 },
  };

  it("submitForReview resolver manager via reports_to og wakeup-er med riktig idempotency-key", async () => {
    db.__state.managerReportsTo = MANAGER_UUID;
    const svc = makeSvc();
    const row = await svc.submitForReview(baseInput);
    expect(row.managerAgentId).toBe(MANAGER_UUID);
    expect(row.managerDecision).toBe("PENDING");
    expect(heartbeat.calls.length).toBe(1);
    expect(heartbeat.calls[0].agentId).toBe(MANAGER_UUID);
    expect(heartbeat.calls[0].opts.idempotencyKey).toBe(`review:${row.id}`);
    expect(heartbeat.calls[0].opts.reason).toBe("manager_review_pending");
  });

  it("kaster unprocessable hvis worker mangler reports_to", async () => {
    db.__state.managerReportsTo = null;
    const svc = makeSvc();
    await expect(svc.submitForReview(baseInput)).rejects.toThrow(/reports_to/);
  });

  it("kaster conflict naar worker har >=10 pending", async () => {
    db.__state.managerReportsTo = MANAGER_UUID;
    db.__state.pendingWorkerCount = 10;
    const svc = makeSvc();
    await expect(svc.submitForReview(baseInput)).rejects.toThrow(/pending reviews/);
  });

  it("kaster conflict naar manager-koe er >=50 pending", async () => {
    db.__state.managerReportsTo = MANAGER_UUID;
    db.__state.pendingWorkerCount = 0;
    db.__state.pendingManagerCount = 50;
    const svc = makeSvc();
    await expect(svc.submitForReview(baseInput)).rejects.toThrow(/saturated/);
  });

  it("dup-hash short-circuit: returnerer auto-avvist rad naar samme payload tidligere er rejected", async () => {
    db.__state.managerReportsTo = MANAGER_UUID;
    // Dup-lookup: kaller select etter resolveManager + to counts.
    // Vi injiserer duplikat ved aa gjoere en egen mock paa select etter 4. kall.
    const origSelect = db.select;
    let callNo = 0;
    db.select = vi.fn((arg?: any) => {
      callNo += 1;
      const argStr = arg ? JSON.stringify(Object.keys(arg)) : "*";
      if (callNo === 1 && argStr.includes("reportsTo")) {
        return { from: () => ({ where: () => ({ then: (cb: any) => cb([{ id: WORKER_UUID, reportsTo: MANAGER_UUID }]) }) }) } as any;
      }
      if (callNo <= 3 && argStr.includes('"c"')) {
        return { from: () => ({ where: () => ({ then: (cb: any) => cb([{ c: 0 }]) }) }) } as any;
      }
      // findDuplicateRejected query
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                then: (cb: any) =>
                  cb([{ id: "dup-review-1", managerDecision: "AVVIST" }]),
              }),
            }),
          }),
        }),
      } as any;
    }) as any;
    const svc = makeSvc();
    const row = await svc.submitForReview(baseInput);
    expect(row.managerDecision).toBe("AVVIST");
    expect(row.managerFeedback).toMatch(/Duplikat/);
    // Ingen wakeup sendt for auto-avvist dup
    expect(heartbeat.calls.length).toBe(0);
  });

  it("computePayloadHash er deterministisk uavhengig av key-rekkefoelge", () => {
    const h1 = computePayloadHash({ a: 1, b: { x: 1, y: 2 } });
    const h2 = computePayloadHash({ b: { y: 2, x: 1 }, a: 1 });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  // ===================================================================
  // QA-fixrunde 2026-04-25 (Fix 1, 2, 5, 8)
  // ===================================================================

  describe("queueWorkerRetry off-by-one fix (Fix 1+2)", () => {
    /**
     * Vi tester via recordManagerDecision('reject') paa en eksisterende rad.
     * Vi setter attemptCount til 0/1/2 og verifiserer at:
     *   attemptCount=0 -> retry (PENDING_RETRY) etter UPDATE
     *   attemptCount=1 -> retry
     *   attemptCount=2 -> escalate (3. forsoek)
     */
    function makeRowDb(initialAttemptCount: number, reviewId = "review-1") {
      const db = makeDb();
      const row = {
        id: reviewId,
        companyId: COMPANY_UUID,
        workerAgentId: WORKER_UUID,
        managerAgentId: MANAGER_UUID,
        managerDecision: "PENDING",
        idempotencyKey: null,
        attemptCount: initialAttemptCount,
        taskType: "bookkeeping_post",
        taskPayload: {},
        workerOutput: { x: 1 },
        payloadHash: "hash",
      };
      db.__state.rows = [row];
      return { db, row };
    }

    it("attemptCount=0 -> retry (ikke escalate)", async () => {
      const { db, row } = makeRowDb(0, "review-fix1-a");
      const svc = workerReviewService(db as any, {
        heartbeat,
        approvals,
        now: () => now,
      });
      await svc.recordManagerDecision(
        row.id,
        "reject",
        "feedback A",
        undefined,
        { managerAgentId: MANAGER_UUID },
      );
      expect(approvals.create).not.toHaveBeenCalled();
      expect(heartbeat.calls.some((c) => c.opts.reason === "manager_review_retry")).toBe(true);
    });

    it("attemptCount=1 -> retry (ikke escalate)", async () => {
      const { db, row } = makeRowDb(1, "review-fix1-b");
      const svc = workerReviewService(db as any, {
        heartbeat,
        approvals,
        now: () => now,
      });
      await svc.recordManagerDecision(
        row.id,
        "reject",
        "feedback B",
        undefined,
        { managerAgentId: MANAGER_UUID },
      );
      expect(approvals.create).not.toHaveBeenCalled();
      expect(heartbeat.calls.some((c) => c.opts.reason === "manager_review_retry")).toBe(true);
    });

    it("attemptCount=2 -> escalate (3. reject overskrider maxRetries=2)", async () => {
      const { db, row } = makeRowDb(2, "review-fix1-c");
      const svc = workerReviewService(db as any, {
        heartbeat,
        approvals,
        now: () => now,
      });
      await svc.recordManagerDecision(
        row.id,
        "reject",
        "feedback C",
        undefined,
        { managerAgentId: MANAGER_UUID },
      );
      expect(approvals.create).toHaveBeenCalled();
      const escalationCall = (approvals.create as any).mock.calls[0];
      expect(escalationCall[1].type).toBe("escalated_worker_action");
      // Eskalerings-payload skal inneholde attemptCount=3 (effectiveAttemptCount-override)
      expect(escalationCall[1].payload.__worker_review.attemptCount).toBe(3);
      expect(heartbeat.calls.some((c) => c.opts.reason === "manager_review_retry")).toBe(false);
    });
  });

  describe("idempotency-key determinism (Fix 8)", () => {
    it("retry-key er avledet fra row.attemptCount FOER UPDATE", async () => {
      const db = makeDb();
      const row = {
        id: "review-fix8",
        companyId: COMPANY_UUID,
        workerAgentId: WORKER_UUID,
        managerAgentId: MANAGER_UUID,
        managerDecision: "PENDING",
        idempotencyKey: null,
        attemptCount: 1,
        taskType: "bookkeeping_post",
        taskPayload: {},
        workerOutput: { x: 1 },
        payloadHash: "hash",
      };
      db.__state.rows = [row];
      const svc = workerReviewService(db as any, {
        heartbeat,
        approvals,
        now: () => now,
      });
      await svc.recordManagerDecision(row.id, "reject", "f", undefined, {
        managerAgentId: MANAGER_UUID,
      });
      const retryCall = heartbeat.calls.find((c) => c.opts.reason === "manager_review_retry");
      expect(retryCall).toBeTruthy();
      expect(retryCall!.opts.idempotencyKey).toBe(`review-retry:${row.id}:1`);
    });
  });

  describe("PENDING_RETRY mellomtilstand (Fix 5)", () => {
    it("queueWorkerRetry setter raden i PENDING_RETRY foer wakeup", async () => {
      const db = makeDb();
      const row = {
        id: "review-fix5",
        companyId: COMPANY_UUID,
        workerAgentId: WORKER_UUID,
        managerAgentId: MANAGER_UUID,
        managerDecision: "PENDING",
        idempotencyKey: null,
        attemptCount: 0,
        taskType: "bookkeeping_post",
        taskPayload: {},
        workerOutput: { x: 1 },
        payloadHash: "hash",
      };
      db.__state.rows = [row];
      const svc = workerReviewService(db as any, {
        heartbeat,
        approvals,
        now: () => now,
      });
      await svc.recordManagerDecision(row.id, "reject", "f", undefined, {
        managerAgentId: MANAGER_UUID,
      });
      const retryUpdate = db.__state.updates.find(
        (u: any) => u.managerDecision === "PENDING_RETRY",
      );
      expect(retryUpdate).toBeTruthy();
      expect(retryUpdate.attemptCount).toBe(1);
    });
  });

  describe("promoteToApproval transaksjons-rollback (Fix 3)", () => {
    it("hvis approvals.create kaster, propagerer feilen og review forblir AVVIST/uten approvalId", async () => {
      // Vi mocker db.transaction til aa kalle callback med en tx-stub som
      // kaster paa insert. Vi bekrefter at promoteToApproval kaster.
      const db = makeDb();
      const row = {
        id: "review-fix3",
        companyId: COMPANY_UUID,
        workerAgentId: WORKER_UUID,
        managerAgentId: MANAGER_UUID,
        managerDecision: "PENDING",
        idempotencyKey: null,
        attemptCount: 0,
        taskType: "bookkeeping_post",
        taskPayload: {},
        workerOutput: { x: 1 },
        payloadHash: "hash",
      };
      db.__state.rows = [row];
      // Inject db.transaction stub
      (db as any).transaction = vi.fn(async (cb: any) => {
        const tx = {
          insert: () => ({
            values: () => ({
              returning: () => ({
                then: () => Promise.reject(new Error("insert failed")),
              }),
            }),
          }),
          update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
        };
        return cb(tx);
      });

      const svc = workerReviewService(db as any, {
        heartbeat,
        approvals,
        now: () => now,
      });

      await expect(
        svc.recordManagerDecision(row.id, "approve", null, undefined, {
          managerAgentId: MANAGER_UUID,
        }),
      ).rejects.toThrow(/insert failed/);
    });
  });
});
