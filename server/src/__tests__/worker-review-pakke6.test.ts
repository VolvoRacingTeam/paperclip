import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock logActivity to avoid unnecessary instance-settings lookups in tests.
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

import {
  workerReviewService,
  type HeartbeatDep,
  type ApprovalsDep,
} from "../services/worker-review.js";

/**
 * Tester for pakke 6: upsertWorkerPattern + hydrateReviewPacket.
 * Bruker minimal DB-stub for aa holde testene hurtige og forutsigbare.
 */

function makeDb() {
  const state = {
    existingPattern: null as any,
    insertedPatterns: [] as any[],
    updatedPatterns: [] as any[],
    reviewRows: new Map<string, any>(),
    agentRows: new Map<string, any>(),
  };

  const chain = (resolveValue: any) => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    then: (cb: any) => Promise.resolve(resolveValue).then(cb),
  });

  let nextSelectMode: "pattern" | "review" | "agent" | "other" = "other";

  const db: any = {
    select: vi.fn((arg?: any) => {
      const argStr = arg ? JSON.stringify(Object.keys(arg)) : "*";
      if (argStr.includes("id") && argStr.includes("name")) {
        // agent lookup
        const agent = Array.from(state.agentRows.values())[0] ?? null;
        return chain(agent ? [agent] : []);
      }
      if (argStr === "*") {
        // pattern or review
        if (nextSelectMode === "pattern") {
          nextSelectMode = "other";
          return chain(state.existingPattern ? [state.existingPattern] : []);
        }
        if (nextSelectMode === "review") {
          nextSelectMode = "other";
          const row = Array.from(state.reviewRows.values())[0] ?? null;
          return chain(row ? [row] : []);
        }
      }
      return chain([]);
    }),
    insert: vi.fn((table: any) => ({
      values: vi.fn(function (this: any, v: any) {
        state.insertedPatterns.push(v);
        return this;
      }),
      returning: vi.fn().mockReturnThis(),
      then: (cb: any) => {
        const last = state.insertedPatterns[state.insertedPatterns.length - 1];
        return Promise.resolve([{ ...last, id: "new-pattern-id" }]).then(cb);
      },
    })),
    update: vi.fn(() => ({
      set: vi.fn(function (this: any, v: any) {
        state.updatedPatterns.push(v);
        return this;
      }),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      then: (cb: any) => {
        const merged = {
          ...(state.existingPattern ?? {}),
          ...(state.updatedPatterns[state.updatedPatterns.length - 1] ?? {}),
          id: state.existingPattern?.id ?? "updated-id",
        };
        return Promise.resolve([merged]).then(cb);
      },
    })),
    __setExistingPattern(p: any) {
      state.existingPattern = p;
      nextSelectMode = "pattern";
    },
    __queuePatternQuery() {
      nextSelectMode = "pattern";
    },
    __queueReviewQuery() {
      nextSelectMode = "review";
    },
    __addReview(row: any) {
      state.reviewRows.set(row.id, row);
    },
    __addAgent(a: any) {
      state.agentRows.set(a.id, a);
    },
    __state: state,
  };
  return db;
}

function makeHeartbeat(): HeartbeatDep {
  return {
    wakeup: vi.fn(async () => ({ id: "wakeup-1" })),
  };
}

function makeApprovals(): ApprovalsDep {
  return {
    create: vi.fn(async () => ({ id: "approval-1" })),
  } as unknown as ApprovalsDep;
}

describe("workerReviewService.upsertWorkerPattern", () => {
  it("insert ny rad hvis eksisterende pattern ikke finnes", async () => {
    const db = makeDb();
    const svc = workerReviewService(db, {
      heartbeat: makeHeartbeat(),
      approvals: makeApprovals(),
    });
    db.__queuePatternQuery(); // first select returns empty
    const result = await svc.upsertWorkerPattern({
      companyId: "c-1",
      workerAgentId: "w-1",
      patternTag: "missing_grounding",
      patternDescription: "Unngaa upaastaaelige krav",
      severity: "warning",
    });
    expect(result.createdOrUpdated).toBe("created");
    expect(db.insert).toHaveBeenCalled();
  });

  it("update eksisterende rad og oeker occurrence_count", async () => {
    const db = makeDb();
    const existing = {
      id: "p-1",
      companyId: "c-1",
      workerAgentId: "w-1",
      patternTag: "missing_grounding",
      patternDescription: "[severity=warning] Old desc",
      occurrenceCount: 3,
      lastSeenAt: new Date("2026-04-01"),
      updatedAt: new Date("2026-04-01"),
    };
    db.__setExistingPattern(existing);
    const svc = workerReviewService(db, {
      heartbeat: makeHeartbeat(),
      approvals: makeApprovals(),
    });
    const result = await svc.upsertWorkerPattern({
      companyId: "c-1",
      workerAgentId: "w-1",
      patternTag: "missing_grounding",
      patternDescription: "New desc",
      severity: "warning",
    });
    expect(result.createdOrUpdated).toBe("updated");
    expect(db.update).toHaveBeenCalled();
    const updateSet = db.__state.updatedPatterns[0];
    expect(updateSet.occurrenceCount).toBe(4); // 3 + 1
  });

  it("bumper severity til strengere verdi ved update", async () => {
    const db = makeDb();
    const existing = {
      id: "p-1",
      patternDescription: "Old desc",
      severity: "info",
      occurrenceCount: 1,
      exampleCorrect: null,
      exampleWrong: null,
      lastSeenAt: new Date(),
    };
    db.__setExistingPattern(existing);
    const svc = workerReviewService(db, {
      heartbeat: makeHeartbeat(),
      approvals: makeApprovals(),
    });
    await svc.upsertWorkerPattern({
      companyId: "c-1",
      workerAgentId: "w-1",
      patternTag: "tag",
      patternDescription: "New desc",
      severity: "critical",
    });
    const updateSet = db.__state.updatedPatterns[0];
    // Fix 11: severity er nu en egen kolonne. Vi sjekker at den oppdateres.
    expect(updateSet.severity).toBe("critical");
    // patternDescription skal ikke lenger ha [severity=..]-prefiks.
    expect(updateSet.patternDescription).not.toMatch(/^\[severity=/u);
  });

  it("beholder strengeste severity ved update naar nytt input er svakere", async () => {
    const db = makeDb();
    const existing = {
      id: "p-1",
      patternDescription: "Old desc",
      severity: "critical",
      occurrenceCount: 1,
      exampleCorrect: null,
      exampleWrong: null,
      lastSeenAt: new Date(),
    };
    db.__setExistingPattern(existing);
    const svc = workerReviewService(db, {
      heartbeat: makeHeartbeat(),
      approvals: makeApprovals(),
    });
    await svc.upsertWorkerPattern({
      companyId: "c-1",
      workerAgentId: "w-1",
      patternTag: "tag",
      patternDescription: "New desc",
      severity: "info",
    });
    const updateSet = db.__state.updatedPatterns[0];
    // Fix 11: severity beholdes som critical naar nytt input er svakere.
    expect(updateSet.severity).toBe("critical");
  });
});

describe("workerReviewService.hydrateReviewPacket", () => {
  it("returnerer normalisert pakke med worker-navn og parent-history", async () => {
    const db = makeDb();
    const root = {
      id: "r-root",
      workerAgentId: "w-1",
      taskType: "bookkeeping_post",
      workerOutput: { account: "6300", amount: 1000 },
      taskPayload: { rationale: "Bokfoer leiekostnad" },
      attemptCount: 0,
      managerDecision: "AVVIST",
      managerFeedback: "feil konto",
      managerDecidedAt: new Date("2026-04-01"),
      parentReviewId: null,
      createdAt: new Date("2026-04-01"),
      payloadHash: "hash-1",
    };
    const child = {
      ...root,
      id: "r-child",
      attemptCount: 1,
      managerDecision: "PENDING",
      parentReviewId: "r-root",
      createdAt: new Date("2026-04-02"),
    };
    db.__addReview(child);
    db.__addAgent({ id: "w-1", name: "Regnskapsfoerer" });

    const svc = workerReviewService(db, {
      heartbeat: makeHeartbeat(),
      approvals: makeApprovals(),
    });

    // getById should return child first, then root
    db.__queueReviewQuery();
    const packet = await svc.hydrateReviewPacket("r-child");
    expect(packet).toBeTruthy();
    expect(packet!.review_id).toBe("r-child");
    expect(packet!.approval_type).toBe("bookkeeping_post");
    expect(packet!.attempt_count).toBe(1);
    expect(packet!.rationale).toBe("Bokfoer leiekostnad");
  });

  it("returnerer null for ukjent reviewId", async () => {
    const db = makeDb();
    const svc = workerReviewService(db, {
      heartbeat: makeHeartbeat(),
      approvals: makeApprovals(),
    });
    const packet = await svc.hydrateReviewPacket("nonexistent");
    expect(packet).toBeNull();
  });
});
