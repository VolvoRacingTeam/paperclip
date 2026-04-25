import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  workerReviewService,
  checkRedlineSizeCap,
  computeJsonMergePatch,
  topLevelChangedFields,
  ORIGINAL_SIZE_RATIO_CAP,
  type HeartbeatDep,
  type ApprovalsDep,
} from "../services/worker-review.js";

/**
 * SON-97: tester for manager-redline guardrail
 *   1) Size-cap (canonical-JSON ratio <= ORIGINAL_SIZE_RATIO_CAP)
 *   2) Sanitized diff-logging via activity_log (event 'worker_review.redlined')
 */

// Capture-bar mock for activity-log
const logActivityCalls: any[] = [];
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async (_db: unknown, input: any) => {
    logActivityCalls.push(input);
  }),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKER_UUID = "11111111-1111-1111-1111-111111111111";
const MANAGER_UUID = "22222222-2222-2222-2222-222222222222";
const COMPANY_UUID = "33333333-3333-3333-3333-333333333333";

function makeBaseRow(workerOutput: Record<string, unknown>) {
  return {
    id: "review-redline-1",
    companyId: COMPANY_UUID,
    workerAgentId: WORKER_UUID,
    managerAgentId: MANAGER_UUID,
    managerDecision: "PENDING",
    idempotencyKey: null,
    attemptCount: 0,
    taskType: "bookkeeping_post",
    taskPayload: {},
    workerOutput,
    payloadHash: "hash-original",
    createdAt: new Date("2026-04-24T10:00:00Z"),
    updatedAt: new Date("2026-04-24T10:00:00Z"),
  };
}

/**
 * Minimalistisk DB-mock som gir tilbake state.rows[0] paa getById,
 * registrerer updates og support db.transaction (for approve-pathen).
 */
function makeDb(initialRow: Record<string, unknown>) {
  const state = {
    rows: [initialRow] as any[],
    updates: [] as any[],
    inserted: [] as any[],
  };

  function selectChain(value: any) {
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => ({ then: (cb: any) => cb(value) }) }),
          limit: () => ({ then: (cb: any) => cb(value) }),
          then: (cb: any) => cb(value),
        }),
        innerJoin: () => ({ then: (cb: any) => cb([]) }),
      }),
    };
  }

  const db: any = {
    __state: state,
    select: vi.fn((arg?: any) => {
      const argStr = arg ? JSON.stringify(Object.keys(arg)) : "*";
      if (argStr.includes("reportsTo")) {
        return selectChain([{ id: WORKER_UUID, reportsTo: MANAGER_UUID }]);
      }
      if (argStr.includes('"c"')) return selectChain([{ c: 0 }]);
      if (argStr.includes("oldest")) return selectChain([{ oldest: null }]);
      // getById / list / dup
      return selectChain(state.rows);
    }),
    update: vi.fn(() => ({
      set: (patch: any) => {
        state.updates.push(patch);
        return {
          where: () => ({
            returning: () => {
              const merged = state.rows[0]
                ? { ...state.rows[0], ...patch }
                : null;
              if (merged) state.rows[0] = merged;
              return Promise.resolve(merged ? [merged] : []);
            },
            then: (cb: any) => Promise.resolve(undefined).then(cb),
          }),
        };
      },
    })),
    insert: vi.fn(() => ({
      values: (vals: any) => ({
        returning: () => {
          const row = {
            id: "approval-new-1",
            ...vals,
          };
          state.inserted.push(row);
          return Promise.resolve([row]);
        },
      }),
    })),
    transaction: vi.fn(async (cb: any) => {
      const tx: any = {
        insert: () => ({
          values: (vals: any) => ({
            returning: () => {
              const row = { id: "approval-tx-1", ...vals };
              state.inserted.push(row);
              return Promise.resolve([row]).then((r) => r);
            },
          }),
        }),
        update: () => ({
          set: () => ({ where: () => Promise.resolve([]) }),
        }),
      };
      // Approve-pathen bruker .then(rows => rows[0] ?? null)
      // Vi simulerer dette ved aa lage en thenable-wrapper.
      const insertedHolder = { last: null as any };
      tx.insert = () => ({
        values: (vals: any) => ({
          returning: () => ({
            then: (resolveCb: any) => {
              const row = { id: "approval-tx-1", ...vals };
              state.inserted.push(row);
              insertedHolder.last = row;
              return Promise.resolve(resolveCb([row]));
            },
          }),
        }),
      });
      return cb(tx);
    }),
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
  return {
    calls,
    create: vi.fn(async (companyId: string, data: any) => {
      calls.push({ companyId, data });
      return { id: "approval-x", companyId, ...data };
    }),
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
    resubmit: vi.fn(),
    listComments: vi.fn(async () => []),
    addComment: vi.fn(),
  } as any;
}

describe("worker-review redline guardrail (SON-97)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logActivityCalls.length = 0;
  });

  // -------------------------------------------------------------------
  // Pure-function tests
  // -------------------------------------------------------------------

  describe("checkRedlineSizeCap()", () => {
    it("aksepterer redline = original (ratio = 1.0)", () => {
      const original = { kontonr: 1500, belop: 100 };
      const r = checkRedlineSizeCap(original, original);
      expect(r.ok).toBe(true);
      expect(r.ratio).toBeCloseTo(1.0);
    });

    it("aksepterer liten endring under 1.2x", () => {
      const original = { kontonr: 1500, belop: 100, kommentar: "salg" };
      const redlined = { kontonr: 1500, belop: 120, kommentar: "salg" };
      const r = checkRedlineSizeCap(original, redlined);
      expect(r.ok).toBe(true);
      expect(r.ratio).toBeLessThanOrEqual(ORIGINAL_SIZE_RATIO_CAP);
    });

    it("avviser redline med ratio > 1.2 (cap)", () => {
      const original = { a: 1 };
      // redlined er ca. 30x stoerre
      const redlined = { a: 1, b: "x".repeat(500) };
      const r = checkRedlineSizeCap(original, redlined);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/redline_too_large/);
      expect(r.ratio).toBeGreaterThan(ORIGINAL_SIZE_RATIO_CAP);
    });

    it("eksponerer ORIGINAL_SIZE_RATIO_CAP = 1.2", () => {
      expect(ORIGINAL_SIZE_RATIO_CAP).toBe(1.2);
    });
  });

  describe("computeJsonMergePatch() (RFC 7396)", () => {
    it("returnerer tomt patch naar identiske objekter", () => {
      const a = { x: 1, y: { z: 2 } };
      const b = { x: 1, y: { z: 2 } };
      expect(computeJsonMergePatch(a, b)).toEqual({});
    });

    it("kun endrede felter er med i patchen", () => {
      const a = { x: 1, y: 2, z: 3 };
      const b = { x: 1, y: 99, z: 3 };
      expect(computeJsonMergePatch(a, b)).toEqual({ y: 99 });
    });

    it("slettede felter representeres som null (RFC 7396)", () => {
      const a = { x: 1, y: 2 };
      const b = { x: 1 };
      expect(computeJsonMergePatch(a, b)).toEqual({ y: null });
    });

    it("nestede objekter rekurserer", () => {
      const a = { meta: { source: "A", count: 1 }, val: 100 };
      const b = { meta: { source: "B", count: 1 }, val: 100 };
      expect(computeJsonMergePatch(a, b)).toEqual({ meta: { source: "B" } });
    });

    it("arrays er atomiske (RFC 7396) - hele nye array tas med", () => {
      const a = { tags: ["x", "y"], v: 1 };
      const b = { tags: ["x", "z"], v: 1 };
      expect(computeJsonMergePatch(a, b)).toEqual({ tags: ["x", "z"] });
    });

    it("nye felter inkluderes med ny verdi", () => {
      const a = { x: 1 };
      const b = { x: 1, y: 2 };
      expect(computeJsonMergePatch(a, b)).toEqual({ y: 2 });
    });
  });

  describe("topLevelChangedFields()", () => {
    it("returnerer kun topp-niva keys som differerer", () => {
      const a = { x: 1, y: 2, z: 3 };
      const b = { x: 1, y: 99, w: 7 };
      expect(topLevelChangedFields(a, b)).toEqual(["w", "y", "z"]);
    });
  });

  // -------------------------------------------------------------------
  // Service-integrasjon: recordManagerDecision med redlinedPayload
  // -------------------------------------------------------------------

  describe("recordManagerDecision: size-cap enforcement", () => {
    it("redline med small change (< 1.2x) -> 200 OK + diff logget", async () => {
      const original = { kontonr: 1500, belop: 100, kommentar: "salg" };
      const redlined = { kontonr: 1500, belop: 120, kommentar: "salg" };
      const row = makeBaseRow(original);
      const db = makeDb(row);
      const svc = workerReviewService(db, {
        heartbeat: makeHeartbeat(),
        approvals: makeApprovals(),
        now: () => new Date("2026-04-24T12:00:00Z"),
      });

      await svc.recordManagerDecision(
        row.id,
        "approve",
        "OK med korreksjon",
        redlined,
        { managerAgentId: MANAGER_UUID },
      );

      const redlineEvt = logActivityCalls.find(
        (c: any) => c.action === "worker_review.redlined",
      );
      expect(redlineEvt).toBeTruthy();
      expect(redlineEvt.entityId).toBe(row.id);
      expect(redlineEvt.actorType).toBe("agent");
      expect(redlineEvt.actorId).toBe(MANAGER_UUID);
      expect(redlineEvt.details.diff).toEqual({ belop: 120 });
      expect(redlineEvt.details.fields_changed).toEqual(["belop"]);
      expect(redlineEvt.details.original_size_bytes).toBeGreaterThan(0);
      expect(redlineEvt.details.redlined_size_bytes).toBeGreaterThan(0);
      expect(redlineEvt.details.ratio).toBeGreaterThan(0);
    });

    it("redline 1.5x size -> kaster HttpError 422 'redline_too_large'", async () => {
      const original = { a: 1 };
      const redlined = { a: 1, fabricated: "x".repeat(500) };
      const row = makeBaseRow(original);
      const db = makeDb(row);
      const svc = workerReviewService(db, {
        heartbeat: makeHeartbeat(),
        approvals: makeApprovals(),
        now: () => new Date("2026-04-24T12:00:00Z"),
      });

      await expect(
        svc.recordManagerDecision(
          row.id,
          "approve",
          null,
          redlined,
          { managerAgentId: MANAGER_UUID },
        ),
      ).rejects.toMatchObject({
        status: 422,
        message: "redline_too_large",
      });

      // Ingen update / ingen redline-event skal vaere logget naar cap brytes
      expect(db.__state.updates.length).toBe(0);
      expect(
        logActivityCalls.find((c: any) => c.action === "worker_review.redlined"),
      ).toBeUndefined();
    });

    it("redline med JWT-aktig string -> diff sanitized i activity-log", async () => {
      // sanitizeRecord (eksisterende helper) redagerer JWT-formede verdier
      // og noekler som matcher SECRET_PAYLOAD_KEY_RE. Vi tester at en JWT i
      // diff-en blir scrubbet foer den treffer activity_log.
      // Original og redlined er ca. samme stoerrelse for aa holde ratio
      // under cap (vi tester sanitizing, ikke size-cap her).
      const original = {
        token: "aaaaaaaaaa.bbbbbbbbbb.cccccccccc",
        kontonr: 1500,
        belop: 1000,
      };
      const redlined = {
        token: "xxxxxxxxxx.yyyyyyyyyy.zzzzzzzzzz",
        kontonr: 1500,
        belop: 1000,
      };
      const row = makeBaseRow(original);
      const db = makeDb(row);
      const svc = workerReviewService(db, {
        heartbeat: makeHeartbeat(),
        approvals: makeApprovals(),
        now: () => new Date("2026-04-24T12:00:00Z"),
      });

      await svc.recordManagerDecision(
        row.id,
        "approve",
        null,
        redlined,
        { managerAgentId: MANAGER_UUID },
      );

      const redlineEvt = logActivityCalls.find(
        (c: any) => c.action === "worker_review.redlined",
      );
      expect(redlineEvt).toBeTruthy();
      // 'token' er ikke en secret-key per regex, men verdien er JWT-formed
      // -> sanitizeRecord erstatter med ***REDACTED***.
      expect(redlineEvt.details.diff.token).toBe("***REDACTED***");
      expect(redlineEvt.details.fields_changed).toEqual(["token"]);
    });

    it("redline = original (ingen endring) -> 200 OK, ratio 1.0, tomt diff", async () => {
      const original = { kontonr: 1500, belop: 100 };
      const redlined = { kontonr: 1500, belop: 100 };
      const row = makeBaseRow(original);
      const db = makeDb(row);
      const svc = workerReviewService(db, {
        heartbeat: makeHeartbeat(),
        approvals: makeApprovals(),
        now: () => new Date("2026-04-24T12:00:00Z"),
      });

      await svc.recordManagerDecision(
        row.id,
        "approve",
        null,
        redlined,
        { managerAgentId: MANAGER_UUID },
      );

      const redlineEvt = logActivityCalls.find(
        (c: any) => c.action === "worker_review.redlined",
      );
      expect(redlineEvt).toBeTruthy();
      expect(redlineEvt.details.diff).toEqual({});
      expect(redlineEvt.details.fields_changed).toEqual([]);
      expect(redlineEvt.details.ratio).toBeCloseTo(1.0);
    });

    it("ingen redline -> ingen redline-event logget (regresjon)", async () => {
      const original = { a: 1 };
      const row = makeBaseRow(original);
      const db = makeDb(row);
      const svc = workerReviewService(db, {
        heartbeat: makeHeartbeat(),
        approvals: makeApprovals(),
        now: () => new Date("2026-04-24T12:00:00Z"),
      });

      await svc.recordManagerDecision(
        row.id,
        "approve",
        null,
        undefined,
        { managerAgentId: MANAGER_UUID },
      );

      const redlineEvt = logActivityCalls.find(
        (c: any) => c.action === "worker_review.redlined",
      );
      expect(redlineEvt).toBeUndefined();
      const decisionEvt = logActivityCalls.find(
        (c: any) => c.action === "worker_review.approve",
      );
      expect(decisionEvt).toBeTruthy();
      expect(decisionEvt.details.hasRedline).toBe(false);
    });
  });
});
