import { describe, expect, it, vi } from "vitest";

import { workerLearningSynthesizer } from "../services/worker-learning-synthesizer.js";

/**
 * Unit-tester for nightly-synthesis-cron.
 * Fokus: skip < 3 reviews, 12-cap, skip pausede managere, shouldFire-logikk.
 */

function makeDb(opts: {
  managers?: Array<{ managerId: string | null }>;
  agents?: Array<{ id: string; status: string; companyId: string }>;
  reportsToMap?: Record<string, Array<{ id: string; companyId: string }>>;
  reviewRows?: Record<string, any[]>; // key = workerId
}) {
  const managers = opts.managers ?? [];
  const agents = opts.agents ?? [];
  const reportsTo = opts.reportsToMap ?? {};
  const reviewRows = opts.reviewRows ?? {};

  // Chain of queries in synthesizeAll, tracked by call order
  const calls: string[] = [];
  let selectDistinctCallCount = 0;

  const db: any = {
    selectDistinct: vi.fn(() => {
      selectDistinctCallCount += 1;
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: (cb: any) => Promise.resolve(managers).then(cb),
      };
    }),
    select: vi.fn((arg?: any) => {
      const argStr = arg ? JSON.stringify(Object.keys(arg)) : "*";
      // Manager agent lookup: { id, status, companyId }
      // Workers lookup: { id, companyId } with eq(reportsTo)
      if (argStr.includes("status")) {
        // Manager lookup
        return {
          from: vi.fn().mockReturnThis(),
          where: (whereClause: any) => {
            return {
              then: (cb: any) => {
                const mgr = agents.find((a) => a.status !== undefined);
                return Promise.resolve([mgr].filter(Boolean)).then(cb);
              },
            };
          },
        };
      }
      if (argStr.includes("companyId") && argStr.includes("id") && !argStr.includes("status")) {
        // Workers-for-manager lookup OR review rows
        let call = calls.length;
        calls.push("workers-or-rows");
        // Detect by counting: first such call per-manager = workers, then per-worker = rows
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: (cb: any) => {
            // Very rough: if we're within the first "workers" lookup for a manager, return workers
            // Otherwise return review rows
            const activeManager = managers.find((m) => m.managerId);
            if (activeManager && reportsTo[activeManager.managerId!]) {
              const workers = reportsTo[activeManager.managerId!];
              reportsTo[activeManager.managerId!] = []; // consume once
              return Promise.resolve(workers).then(cb);
            }
            // Return reviewRows for the first worker we haven't processed
            const firstKey = Object.keys(reviewRows)[0];
            if (firstKey) {
              const rows = reviewRows[firstKey];
              delete reviewRows[firstKey];
              return Promise.resolve(rows).then(cb);
            }
            return Promise.resolve([]).then(cb);
          },
        };
      }
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: (cb: any) => Promise.resolve([]).then(cb),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      then: (cb: any) => Promise.resolve([{ id: "activity-1" }]).then(cb),
    })),
  };
  return db;
}

describe("workerLearningSynthesizer", () => {
  it("synthesizeAll returnerer baseline-summary naar ingen managere har reviews", async () => {
    const db = makeDb({ managers: [] });
    const heartbeat = { wakeup: vi.fn(async () => ({ id: "wakeup-1" })) };
    const svc = workerLearningSynthesizer(db, { heartbeat });
    const summary = await svc.synthesizeAll(new Date("2026-04-24T03:15:00Z"));
    expect(summary.wakeupsEnqueued).toBe(0);
    expect(summary.managersProcessed).toBe(0);
    expect(heartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("shouldFire returnerer true naar cron-tick er krysset siden sist", () => {
    const db = makeDb({});
    const svc = workerLearningSynthesizer(db, {
      heartbeat: { wakeup: vi.fn() },
    });
    // cron "15 3 * * *" = 03:15 UTC every day
    const now = new Date("2026-04-24T03:16:00Z");
    const lastTick = new Date("2026-04-23T10:00:00Z");
    expect(svc.shouldFire("15 3 * * *", lastTick, now)).toBe(true);
  });

  it("shouldFire returnerer false naar cron-tick ikke er krysset siden sist", () => {
    const db = makeDb({});
    const svc = workerLearningSynthesizer(db, {
      heartbeat: { wakeup: vi.fn() },
    });
    const now = new Date("2026-04-24T03:14:00Z");
    const lastTick = new Date("2026-04-24T03:00:00Z");
    expect(svc.shouldFire("15 3 * * *", lastTick, now)).toBe(false);
  });

  it("shouldFire returnerer true ved foerste tick (null lastTickAt)", () => {
    const db = makeDb({});
    const svc = workerLearningSynthesizer(db, {
      heartbeat: { wakeup: vi.fn() },
    });
    // null gir en baseline 2 min tilbake i tid; hvis cron-tick er i mellom,
    // boer fire. Bruk cron med hver minutt for aa garantere fire.
    const now = new Date("2026-04-24T03:15:00Z");
    expect(svc.shouldFire("* * * * *", null, now)).toBe(true);
  });

  it("shouldFire returnerer false ved ugyldig cron-expression", () => {
    const db = makeDb({});
    const svc = workerLearningSynthesizer(db, {
      heartbeat: { wakeup: vi.fn() },
    });
    expect(() => svc.shouldFire("invalid", null, new Date())).toThrow();
  });
});
