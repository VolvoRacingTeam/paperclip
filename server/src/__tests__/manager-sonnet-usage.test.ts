/**
 * Pakke D (SON-97) - manager-sonnet-usage service tester.
 *
 * Dekker:
 *   - record() insert
 *   - aggregateByAgent() summer/sortering
 *   - hourlyAggregateAndLog() activity-log + daily-alert
 *   - isManagerWakeReason heuristikk
 *   - estimateTokensFromCharCount fallback
 *   - buildUsageRecordFromAdapterResult helper
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  managerSonnetUsageService,
  isManagerWakeReason,
  estimateTokensFromCharCount,
  buildUsageRecordFromAdapterResult,
  MANAGER_WAKE_REASONS,
} from "../services/manager-sonnet-usage.js";

/**
 * Minimal in-memory db-mock som speiler Drizzle fluent-API for managers
 * sonnet-usage og activity-log tabellene.
 */
function makeMockDb() {
  const usageRows: any[] = [];
  const activityRows: any[] = [];

  type Insert = { table: "usage" | "activity"; values: any };
  let pendingInsert: Insert | null = null;

  type SelectShape =
    | "aggregate-by-agent"
    | "company-hourly"
    | "day-totals"
    | "recent-alert";

  function selectChain(rows: any[]): any {
    const chain: any = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.groupBy = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);
    chain.then = (cb: any) => Promise.resolve(rows).then(cb);
    chain.catch = (cb: any) => Promise.resolve(rows).catch(cb);
    chain[Symbol.asyncIterator] = async function* () {
      for (const r of rows) yield r;
    };
    return chain;
  }

  const db: any = {
    select: vi.fn((arg?: any) => {
      const keys = arg ? Object.keys(arg) : [];
      // Heuristic identifikasjon
      if (keys.includes("agentId") && keys.includes("totalInputTokens")) {
        // aggregate-by-agent
        const map = new Map<string, any>();
        for (const r of usageRows) {
          if (!map.has(r.agentId)) {
            map.set(r.agentId, { agentId: r.agentId, totalInputTokens: 0, totalOutputTokens: 0, requestCount: 0, durSum: 0, durN: 0 });
          }
          const m = map.get(r.agentId)!;
          m.totalInputTokens += r.inputTokens ?? 0;
          m.totalOutputTokens += r.outputTokens ?? 0;
          m.requestCount += 1;
          if (r.durationMs != null) { m.durSum += r.durationMs; m.durN += 1; }
        }
        const out = [...map.values()].map((m) => ({
          agentId: m.agentId,
          totalInputTokens: m.totalInputTokens,
          totalOutputTokens: m.totalOutputTokens,
          requestCount: m.requestCount,
          avgDurationMs: m.durN > 0 ? m.durSum / m.durN : null,
        }));
        return selectChain(out);
      }
      if (keys.includes("companyId") && keys.includes("totalInputTokens")) {
        // hourlyAggregate per company
        const map = new Map<string, any>();
        for (const r of usageRows) {
          if (!map.has(r.companyId)) map.set(r.companyId, { companyId: r.companyId, totalInputTokens: 0, totalOutputTokens: 0, requestCount: 0 });
          const m = map.get(r.companyId)!;
          m.totalInputTokens += r.inputTokens ?? 0;
          m.totalOutputTokens += r.outputTokens ?? 0;
          m.requestCount += 1;
        }
        return selectChain([...map.values()]);
      }
      if (keys.includes("totalInput") && keys.includes("totalOutput")) {
        // dayTotals (single row aggregate)
        const totalInput = usageRows.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
        const totalOutput = usageRows.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
        return selectChain([{ totalInput, totalOutput }]);
      }
      if (keys.includes("id")) {
        // recent-alert lookup -> never present in tests by default
        return selectChain([]);
      }
      return selectChain([]);
    }),
    insert: vi.fn((tbl: any) => {
      const isUsage = String(tbl).includes("manager_sonnet_usage") ||
        (tbl?.[Symbol.toStringTag] === "manager_sonnet_usage") ||
        Object.values(tbl ?? {}).some((c: any) => c?.name === "input_tokens");
      pendingInsert = { table: isUsage ? "usage" : "activity", values: null };
      const chain: any = {};
      chain.values = (v: any) => { pendingInsert!.values = v; return chain; };
      chain.onConflictDoUpdate = (_arg: any) => chain;
      chain.onConflictDoNothing = (_arg: any) => chain;
      chain.returning = (_proj?: any) => {
        const row = { id: `row-${(pendingInsert!.table === "usage" ? usageRows : activityRows).length + 1}`, ...(pendingInsert!.values ?? {}) };
        if (pendingInsert!.table === "usage") usageRows.push(row); else activityRows.push(row);
        // Provide minimal fields the production code reads back (e.g. censorUsernameInLogs)
        return Promise.resolve([{ ...row, censorUsernameInLogs: false }]);
      };
      // For inserts without .returning() (logActivity path may use direct await):
      chain.then = (cb: any) => {
        const row = { id: `row-${(pendingInsert!.table === "usage" ? usageRows : activityRows).length + 1}`, ...(pendingInsert!.values ?? {}) };
        if (pendingInsert!.table === "usage") usageRows.push(row); else activityRows.push(row);
        return Promise.resolve(row).then(cb);
      };
      return chain;
    }),
    // logActivity bruker query.* / live-events. Vi stubber felt-mottakerne.
    transaction: async (fn: any) => fn(db),
    query: {} as any,
  };
  return { db, usageRows, activityRows };
}

describe("manager-sonnet-usage helpers", () => {
  it("isManagerWakeReason recognizes manager wake reasons", () => {
    expect(isManagerWakeReason("manager_review_pending")).toBe(true);
    expect(isManagerWakeReason("manager_review")).toBe(true);
    expect(isManagerWakeReason("direct_approval")).toBe(true);
    expect(isManagerWakeReason("issue_assigned")).toBe(false);
    expect(isManagerWakeReason(null)).toBe(false);
    expect(isManagerWakeReason(undefined)).toBe(false);
  });

  it("MANAGER_WAKE_REASONS set is non-empty", () => {
    expect(MANAGER_WAKE_REASONS.size).toBeGreaterThan(0);
  });

  it("estimateTokensFromCharCount uses ~4 chars/token", () => {
    expect(estimateTokensFromCharCount(0)).toBe(0);
    expect(estimateTokensFromCharCount(4)).toBe(1);
    expect(estimateTokensFromCharCount(400)).toBe(100);
    expect(estimateTokensFromCharCount(-5)).toBe(0);
  });

  it("buildUsageRecordFromAdapterResult sums cached + input tokens", () => {
    const r = buildUsageRecordFromAdapterResult({
      companyId: "c1",
      agentId: "a1",
      runId: "r1",
      wakeReason: "manager_review_pending",
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      durationMs: 1234,
    });
    expect(r.companyId).toBe("c1");
    expect(r.agentId).toBe("a1");
    expect(r.runId).toBe("r1");
    expect(r.reason).toBe("manager_review_pending");
    expect(r.inputTokens).toBe(1200);
    expect(r.outputTokens).toBe(500);
    expect(r.durationMs).toBe(1234);
  });

  it("buildUsageRecordFromAdapterResult tolerates missing usage", () => {
    const r = buildUsageRecordFromAdapterResult({
      companyId: "c1",
      agentId: "a1",
      runId: null,
      wakeReason: null,
      inputTokens: null,
      outputTokens: null,
      durationMs: null,
    });
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.runId).toBeNull();
    expect(r.reason).toBeNull();
  });
});

describe("managerSonnetUsageService.record / aggregateByAgent", () => {
  let mock: ReturnType<typeof makeMockDb>;
  beforeEach(() => {
    mock = makeMockDb();
  });

  it("record() persists a row with all fields", async () => {
    const svc = managerSonnetUsageService(mock.db as any);
    const result = await svc.record({
      companyId: "c1",
      agentId: "a1",
      runId: "r1",
      reason: "manager_review_pending",
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 999,
    });
    expect(result.id).toBeDefined();
    expect(mock.usageRows).toHaveLength(1);
    expect(mock.usageRows[0]).toMatchObject({
      companyId: "c1",
      agentId: "a1",
      runId: "r1",
      reason: "manager_review_pending",
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 999,
    });
  });

  it("aggregateByAgent() summerer per agent", async () => {
    const svc = managerSonnetUsageService(mock.db as any);
    await svc.record({ companyId: "c1", agentId: "a1", inputTokens: 100, outputTokens: 50, durationMs: 100 });
    await svc.record({ companyId: "c1", agentId: "a1", inputTokens: 200, outputTokens: 80, durationMs: 200 });
    await svc.record({ companyId: "c1", agentId: "a2", inputTokens: 300, outputTokens: 90, durationMs: 300 });
    const aggs = await svc.aggregateByAgent("c1", "24h");
    const a1 = aggs.find((a) => a.agentId === "a1");
    const a2 = aggs.find((a) => a.agentId === "a2");
    expect(a1).toMatchObject({ totalInputTokens: 300, totalOutputTokens: 130, requestCount: 2 });
    expect(a1!.avgDurationMs).toBe(150);
    expect(a2).toMatchObject({ totalInputTokens: 300, totalOutputTokens: 90, requestCount: 1 });
    expect(a2!.avgDurationMs).toBe(300);
  });
});

describe("managerSonnetUsageService.hourlyAggregateAndLog", () => {
  it("logger hourly_usage og daily_alert ved overskridelse", async () => {
    const mock = makeMockDb();
    const svc = managerSonnetUsageService(mock.db as any);
    // Lag store inputs slik at sum > 500k tokens (default-grense)
    await svc.record({ companyId: "c1", agentId: "a1", inputTokens: 400_000, outputTokens: 200_000, durationMs: 100 });

    const result = await svc.hourlyAggregateAndLog(new Date());
    expect(result.companies).toBeGreaterThanOrEqual(1);
    const hourly = mock.activityRows.filter((r) => r.action === "manager_sonnet.hourly_usage");
    expect(hourly.length).toBeGreaterThanOrEqual(1);
    const alert = mock.activityRows.filter((r) => r.action === "manager_sonnet.daily_alert");
    expect(alert.length).toBeGreaterThanOrEqual(1);
    expect((alert[0]!.details as any).threshold).toBe(500_000);
  });

  it("logger ikke daily_alert under terskelen", async () => {
    const mock = makeMockDb();
    const svc = managerSonnetUsageService(mock.db as any);
    await svc.record({ companyId: "c1", agentId: "a1", inputTokens: 1000, outputTokens: 500, durationMs: 100 });
    await svc.hourlyAggregateAndLog(new Date());
    const alert = mock.activityRows.filter((r) => r.action === "manager_sonnet.daily_alert");
    expect(alert).toHaveLength(0);
  });
});
