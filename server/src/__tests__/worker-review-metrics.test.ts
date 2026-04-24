import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KILL_CRITERIA_MIN_DECISIONS,
  KILL_ESCALATION_VOLUME_THRESHOLD,
  KILL_LATENCY_MS_THRESHOLD,
  KILL_REJECTION_RATE_THRESHOLD,
  KILL_STALE_PENDING_THRESHOLD_MS,
  workerReviewMetricsService,
} from "../services/worker-review-metrics.js";

/**
 * Pakke B unit-tester:
 *   - rejection_rate_high
 *   - latency_high
 *   - escalation_volume_high
 *   - stale_pending_over_1h
 *   + env-var guard og at ingen alerts fyrer naar totalDecisions <= 5.
 *
 * Vi mocker logActivity til aa fange opp alle activity_log-skriv slik at vi
 * kan verifisere antall + payload uten en ekte database.
 */

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
}));

import { logActivity } from "../services/activity-log.js";

const COMPANY_UUID = "00000000-0000-0000-0000-0000000000c1";
const MANAGER_UUID = "00000000-0000-0000-0000-0000000000a1";

const NOW = new Date("2026-04-24T12:00:00Z");
const WINDOW_START = new Date(NOW.getTime() - 10 * 60 * 1000);

function makeRow(overrides: Partial<any> = {}): any {
  return {
    id: overrides.id ?? "row-1",
    companyId: COMPANY_UUID,
    workerAgentId: "worker-1",
    managerAgentId: MANAGER_UUID,
    taskType: "bookkeeping_post",
    taskPayload: {},
    workerOutput: {},
    workerAttempt: 1,
    managerDecision: overrides.managerDecision ?? "GODKJENT",
    managerFeedback: null,
    managerReasoning: null,
    managerDecidedAt:
      overrides.managerDecidedAt ?? new Date(NOW.getTime() - 60_000),
    humanDecision: null,
    humanFeedback: null,
    humanEditedOutput: null,
    humanDecidedAt: null,
    patternTags: [],
    synthesized: false,
    synthesizedAt: null,
    approvalId: null,
    attemptCount: 0,
    parentReviewId: null,
    payloadHash: "hash",
    idempotencyKey: null,
    createdAt: overrides.createdAt ?? new Date(NOW.getTime() - 5 * 60_000),
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDb(opts: {
  windowRows: any[];
  oldestPendingRow?: any | null;
}) {
  let selectCount = 0;
  return {
    select: vi.fn((arg?: any) => {
      // First call (no arg) -> windowed rows query.
      // Second call (with shape) -> evaluateGlobalStalePending oldest pending.
      const isWindowQuery = !arg;
      selectCount += 1;
      if (isWindowQuery) {
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          then: (cb: any) => Promise.resolve(opts.windowRows).then(cb),
        };
      }
      const oldest = opts.oldestPendingRow ? [opts.oldestPendingRow] : [];
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: (cb: any) => Promise.resolve(oldest).then(cb),
      };
    }),
  } as any;
}

beforeEach(() => {
  vi.mocked(logActivity).mockClear();
  process.env.PAPERCLIP_MANAGER_REVIEW_METRICS_ENABLED = "true";
});

afterEach(() => {
  delete process.env.PAPERCLIP_MANAGER_REVIEW_METRICS_ENABLED;
});

describe("workerReviewMetricsService (Pakke B)", () => {
  it("fyrer rejection_rate_high naar > 50% rejections med > 5 decisions", async () => {
    // 4 AVVIST + 3 GODKJENT = 7 decisions, 4/7 = 0.57 > 0.5
    const rows = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeRow({ id: `r-${i}`, managerDecision: "AVVIST" }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeRow({ id: `g-${i}`, managerDecision: "GODKJENT" }),
      ),
    ];
    const db = makeDb({ windowRows: rows });
    const svc = workerReviewMetricsService(db, { now: () => NOW });
    const summary = await svc.tick();
    expect(summary.metricsLogged).toBe(1);
    expect(summary.alertsLogged).toBeGreaterThanOrEqual(1);
    const alerts = vi
      .mocked(logActivity)
      .mock.calls.filter(
        (c) => (c[1] as any).action === "worker_review.kill_criteria_alert",
      );
    const types = alerts.map((c) => (c[1] as any).details.alertType);
    expect(types).toContain("rejection_rate_high");
    const rejectionAlert = alerts.find(
      (c) => (c[1] as any).details.alertType === "rejection_rate_high",
    );
    expect((rejectionAlert![1] as any).details.threshold).toBe(
      KILL_REJECTION_RATE_THRESHOLD,
    );
  });

  it("fyrer latency_high naar avg-latency > 5 min med > 5 decisions", async () => {
    // 6 GODKJENT alle med 6 min latency. 6 > 5 decisions, > 5 min latency.
    const created = new Date(NOW.getTime() - 6 * 60_000); // 6 min ago
    const decided = NOW;
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeRow({
        id: `r-${i}`,
        managerDecision: "GODKJENT",
        createdAt: created,
        managerDecidedAt: decided,
      }),
    );
    const db = makeDb({ windowRows: rows });
    const svc = workerReviewMetricsService(db, { now: () => NOW });
    await svc.tick();
    const alerts = vi
      .mocked(logActivity)
      .mock.calls.filter(
        (c) => (c[1] as any).action === "worker_review.kill_criteria_alert",
      );
    const latencyAlert = alerts.find(
      (c) => (c[1] as any).details.alertType === "latency_high",
    );
    expect(latencyAlert).toBeTruthy();
    expect((latencyAlert![1] as any).details.thresholdMs).toBe(
      KILL_LATENCY_MS_THRESHOLD,
    );
    expect(
      (latencyAlert![1] as any).details.avgDecisionLatencyMs,
    ).toBeGreaterThan(KILL_LATENCY_MS_THRESHOLD);
  });

  it("fyrer escalation_volume_high naar >= 5 escalations i vinduet", async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow({ id: `e-${i}`, managerDecision: "ESKALERT" }),
      ),
      // legg til 1 GODKJENT slik at totalDecisions = 6 > 5
      makeRow({ id: "g-1", managerDecision: "GODKJENT" }),
    ];
    const db = makeDb({ windowRows: rows });
    const svc = workerReviewMetricsService(db, { now: () => NOW });
    await svc.tick();
    const alerts = vi
      .mocked(logActivity)
      .mock.calls.filter(
        (c) => (c[1] as any).action === "worker_review.kill_criteria_alert",
      );
    const escalationAlert = alerts.find(
      (c) => (c[1] as any).details.alertType === "escalation_volume_high",
    );
    expect(escalationAlert).toBeTruthy();
    expect((escalationAlert![1] as any).details.threshold).toBe(
      KILL_ESCALATION_VOLUME_THRESHOLD,
    );
    expect((escalationAlert![1] as any).details.escalations).toBe(5);
  });

  it("fyrer stale_pending_over_1h naar oldest pending > 3600s", async () => {
    // Tom window (ingen activity siste 10 min) men en gammel PENDING-rad
    // globalt eldre enn 1 time skal trigge stale_pending_over_1h.
    const oldestRow = {
      id: "old-pending-1",
      companyId: COMPANY_UUID,
      managerAgentId: MANAGER_UUID,
      createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), // 2h ago
    };
    const db = makeDb({ windowRows: [], oldestPendingRow: oldestRow });
    const svc = workerReviewMetricsService(db, { now: () => NOW });
    const summary = await svc.tick();
    expect(summary.alertsLogged).toBe(1);
    const alerts = vi
      .mocked(logActivity)
      .mock.calls.filter(
        (c) => (c[1] as any).action === "worker_review.kill_criteria_alert",
      );
    const staleAlert = alerts.find(
      (c) => (c[1] as any).details.alertType === "stale_pending_over_1h",
    );
    expect(staleAlert).toBeTruthy();
    expect((staleAlert![1] as any).details.thresholdMs).toBe(
      KILL_STALE_PENDING_THRESHOLD_MS,
    );
    expect((staleAlert![1] as any).details.ageMs).toBeGreaterThan(
      KILL_STALE_PENDING_THRESHOLD_MS,
    );
  });

  it("fyrer ingen alerts naar totalDecisions <= 5", async () => {
    // 3 AVVIST + 2 GODKJENT = 5 decisions (terskel er > 5).
    const rows = [
      ...Array.from({ length: 3 }, (_, i) =>
        makeRow({ id: `r-${i}`, managerDecision: "AVVIST" }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeRow({ id: `g-${i}`, managerDecision: "GODKJENT" }),
      ),
    ];
    const db = makeDb({ windowRows: rows });
    const svc = workerReviewMetricsService(db, { now: () => NOW });
    const summary = await svc.tick();
    expect(summary.metricsLogged).toBe(1);
    expect(summary.alertsLogged).toBe(0);
    expect(KILL_CRITERIA_MIN_DECISIONS).toBe(5);
  });

  it("logger ingenting og returnerer tomt summary naar env-flag er off", async () => {
    process.env.PAPERCLIP_MANAGER_REVIEW_METRICS_ENABLED = "false";
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeRow({ id: `r-${i}`, managerDecision: "AVVIST" }),
    );
    const db = makeDb({ windowRows: rows });
    const svc = workerReviewMetricsService(db, { now: () => NOW });
    const summary = await svc.tick();
    expect(summary.managersScanned).toBe(0);
    expect(summary.metricsLogged).toBe(0);
    expect(summary.alertsLogged).toBe(0);
    expect(logActivity).not.toHaveBeenCalled();
    expect(svc.isEnabled()).toBe(false);
  });

  it("isEnabled defaulter til true naar env-var ikke er satt", () => {
    delete process.env.PAPERCLIP_MANAGER_REVIEW_METRICS_ENABLED;
    const svc = workerReviewMetricsService(makeDb({ windowRows: [] }), {
      now: () => NOW,
    });
    expect(svc.isEnabled()).toBe(true);
  });

  it("metrics_10min logges med korrekt action og window-marker", async () => {
    const rows = [makeRow({ managerDecision: "GODKJENT" })];
    const db = makeDb({ windowRows: rows });
    const svc = workerReviewMetricsService(db, { now: () => NOW });
    await svc.tick();
    const metricsCalls = vi
      .mocked(logActivity)
      .mock.calls.filter(
        (c) => (c[1] as any).action === "worker_review.metrics_10min",
      );
    expect(metricsCalls.length).toBe(1);
    const details = (metricsCalls[0]![1] as any).details;
    expect(details.windowStart).toBe(WINDOW_START.toISOString());
    expect(details.windowEnd).toBe(NOW.toISOString());
    expect(details.totalDecisions).toBe(1);
    expect(details.approvals).toBe(1);
  });
});
