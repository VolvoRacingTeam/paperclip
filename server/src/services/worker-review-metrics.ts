import { and, gte, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workerReviewLog, type WorkerReviewLog } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

/**
 * Pakke B: observability-cron for worker-review-loopen.
 *
 * Hver 10. min:
 *   1. Aggregerer worker_review_log siste 10 min per manager (alle decision-
 *      statuser, latency, telling per kategori).
 *   2. Skriver et metrics-snapshot til activity_log (action
 *      "worker_review.metrics_10min").
 *   3. Hvis manageren har > 5 decisions i vinduet, evalueres fire kill-
 *      criteria; hver utlost alert skrives som
 *      "worker_review.kill_criteria_alert" til activity_log.
 *   4. Felles "stale_pending_over_1h"-alert dekker hele instansen (oldest
 *      PENDING/PENDING_RETRY-rad globalt eldre enn 3600s).
 *
 * Guard: env-var PAPERCLIP_MANAGER_REVIEW_METRICS_ENABLED (default true).
 *
 * Konsumenter er BMad Dev / kundeoversikt-RAG / dashboards som leser
 * activity_log direkte; vi unngaar a innfore en ny tabell for foerste
 * iterasjon.
 */

export const KILL_CRITERIA_MIN_DECISIONS = 5;
export const KILL_REJECTION_RATE_THRESHOLD = 0.5;
export const KILL_LATENCY_MS_THRESHOLD = 5 * 60 * 1000; // 5 min
export const KILL_ESCALATION_VOLUME_THRESHOLD = 5;
export const KILL_STALE_PENDING_THRESHOLD_MS = 60 * 60 * 1000; // 1h

const DECIDED_STATUSES = ["GODKJENT", "AVVIST", "ESKALERT"] as const;
const PENDING_STATUSES = ["PENDING", "PENDING_RETRY"] as const;

export interface ManagerWindowMetrics {
  managerAgentId: string;
  companyId: string;
  windowStart: string;
  windowEnd: string;
  totalDecisions: number;
  approvals: number;
  rejections: number;
  escalations: number;
  pendingInWindow: number;
  pendingRetryInWindow: number;
  rejectionRate: number;
  avgDecisionLatencyMs: number | null;
  oldestPendingAgeMs: number | null;
}

export interface KillCriteriaAlert {
  alertType:
    | "rejection_rate_high"
    | "latency_high"
    | "escalation_volume_high"
    | "stale_pending_over_1h";
  managerAgentId: string | null;
  companyId: string | null;
  details: Record<string, unknown>;
}

export interface MetricsTickSummary {
  windowStart: string;
  windowEnd: string;
  managersScanned: number;
  metricsLogged: number;
  alertsLogged: number;
  errors: number;
}

export interface WorkerReviewMetricsDeps {
  now?: () => Date;
}

export function workerReviewMetricsService(
  db: Db,
  deps: WorkerReviewMetricsDeps = {},
) {
  const nowFn = deps.now ?? (() => new Date());

  function isEnabled(): boolean {
    const v = process.env.PAPERCLIP_MANAGER_REVIEW_METRICS_ENABLED;
    if (v === undefined) return true;
    return v.toLowerCase() === "true" || v === "1";
  }

  async function computeManagerMetrics(
    rows: WorkerReviewLog[],
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ManagerWindowMetrics[]> {
    const byManager = new Map<string, WorkerReviewLog[]>();
    for (const r of rows) {
      const key = r.managerAgentId ?? "__unassigned__";
      const arr = byManager.get(key) ?? [];
      arr.push(r);
      byManager.set(key, arr);
    }
    const out: ManagerWindowMetrics[] = [];
    for (const [managerAgentId, group] of byManager) {
      if (managerAgentId === "__unassigned__") continue;
      const companyId = group[0]!.companyId;
      const approvals = group.filter((r) => r.managerDecision === "GODKJENT").length;
      const rejections = group.filter((r) => r.managerDecision === "AVVIST").length;
      const escalations = group.filter((r) => r.managerDecision === "ESKALERT").length;
      const pendingInWindow = group.filter(
        (r) => r.managerDecision === "PENDING",
      ).length;
      const pendingRetryInWindow = group.filter(
        (r) => r.managerDecision === "PENDING_RETRY",
      ).length;
      const totalDecisions = approvals + rejections + escalations;
      const rejectionRate = totalDecisions > 0 ? rejections / totalDecisions : 0;
      const decidedRows = group.filter(
        (r) =>
          r.managerDecidedAt &&
          DECIDED_STATUSES.includes(
            r.managerDecision as (typeof DECIDED_STATUSES)[number],
          ),
      );
      let avgDecisionLatencyMs: number | null = null;
      if (decidedRows.length > 0) {
        const sumMs = decidedRows.reduce((acc, r) => {
          const created = new Date(r.createdAt as unknown as string).getTime();
          const decided = new Date(r.managerDecidedAt as unknown as string).getTime();
          return acc + Math.max(0, decided - created);
        }, 0);
        avgDecisionLatencyMs = Math.round(sumMs / decidedRows.length);
      }
      const pendingAges = group
        .filter(
          (r) =>
            r.managerDecision === "PENDING" ||
            r.managerDecision === "PENDING_RETRY",
        )
        .map((r) => {
          const created = new Date(r.createdAt as unknown as string).getTime();
          return windowEnd.getTime() - created;
        });
      const oldestPendingAgeMs =
        pendingAges.length > 0 ? Math.max(...pendingAges) : null;
      out.push({
        managerAgentId,
        companyId,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        totalDecisions,
        approvals,
        rejections,
        escalations,
        pendingInWindow,
        pendingRetryInWindow,
        rejectionRate,
        avgDecisionLatencyMs,
        oldestPendingAgeMs,
      });
    }
    return out;
  }

  function evaluateKillCriteria(
    metrics: ManagerWindowMetrics,
  ): KillCriteriaAlert[] {
    const alerts: KillCriteriaAlert[] = [];
    if (metrics.totalDecisions <= KILL_CRITERIA_MIN_DECISIONS) {
      return alerts;
    }
    if (metrics.rejectionRate > KILL_REJECTION_RATE_THRESHOLD) {
      alerts.push({
        alertType: "rejection_rate_high",
        managerAgentId: metrics.managerAgentId,
        companyId: metrics.companyId,
        details: {
          rejectionRate: metrics.rejectionRate,
          rejections: metrics.rejections,
          totalDecisions: metrics.totalDecisions,
          threshold: KILL_REJECTION_RATE_THRESHOLD,
          windowStart: metrics.windowStart,
          windowEnd: metrics.windowEnd,
        },
      });
    }
    if (
      metrics.avgDecisionLatencyMs !== null &&
      metrics.avgDecisionLatencyMs > KILL_LATENCY_MS_THRESHOLD
    ) {
      alerts.push({
        alertType: "latency_high",
        managerAgentId: metrics.managerAgentId,
        companyId: metrics.companyId,
        details: {
          avgDecisionLatencyMs: metrics.avgDecisionLatencyMs,
          thresholdMs: KILL_LATENCY_MS_THRESHOLD,
          totalDecisions: metrics.totalDecisions,
          windowStart: metrics.windowStart,
          windowEnd: metrics.windowEnd,
        },
      });
    }
    if (metrics.escalations >= KILL_ESCALATION_VOLUME_THRESHOLD) {
      alerts.push({
        alertType: "escalation_volume_high",
        managerAgentId: metrics.managerAgentId,
        companyId: metrics.companyId,
        details: {
          escalations: metrics.escalations,
          threshold: KILL_ESCALATION_VOLUME_THRESHOLD,
          totalDecisions: metrics.totalDecisions,
          windowStart: metrics.windowStart,
          windowEnd: metrics.windowEnd,
        },
      });
    }
    return alerts;
  }

  async function evaluateGlobalStalePending(
    windowEnd: Date,
  ): Promise<KillCriteriaAlert | null> {
    const oldest = await db
      .select({
        id: workerReviewLog.id,
        companyId: workerReviewLog.companyId,
        managerAgentId: workerReviewLog.managerAgentId,
        createdAt: workerReviewLog.createdAt,
      })
      .from(workerReviewLog)
      .where(inArray(workerReviewLog.managerDecision, [...PENDING_STATUSES]))
      .orderBy(workerReviewLog.createdAt)
      .limit(1);
    const oldestRow = oldest[0];
    if (!oldestRow) return null;
    const ageMs =
      windowEnd.getTime() -
      new Date(oldestRow.createdAt as unknown as string).getTime();
    if (ageMs <= KILL_STALE_PENDING_THRESHOLD_MS) return null;
    return {
      alertType: "stale_pending_over_1h",
      managerAgentId: oldestRow.managerAgentId ?? null,
      companyId: oldestRow.companyId ?? null,
      details: {
        reviewId: oldestRow.id,
        ageMs,
        ageSeconds: Math.round(ageMs / 1000),
        thresholdMs: KILL_STALE_PENDING_THRESHOLD_MS,
        windowEnd: windowEnd.toISOString(),
      },
    };
  }

  async function tick(now?: Date): Promise<MetricsTickSummary> {
    const ts = now ?? nowFn();
    const windowEnd = ts;
    const windowStart = new Date(ts.getTime() - 10 * 60 * 1000);

    const summary: MetricsTickSummary = {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      managersScanned: 0,
      metricsLogged: 0,
      alertsLogged: 0,
      errors: 0,
    };

    if (!isEnabled()) {
      return summary;
    }

    try {
      const allowed = [...DECIDED_STATUSES, ...PENDING_STATUSES];
      const rows = await db
        .select()
        .from(workerReviewLog)
        .where(
          and(
            gte(workerReviewLog.createdAt, windowStart),
            isNotNull(workerReviewLog.managerAgentId),
            inArray(workerReviewLog.managerDecision, allowed),
          ),
        );
      const perManager = await computeManagerMetrics(
        rows as WorkerReviewLog[],
        windowStart,
        windowEnd,
      );
      summary.managersScanned = perManager.length;

      for (const m of perManager) {
        try {
          await logActivity(db, {
            companyId: m.companyId,
            actorType: "system",
            actorId: "worker_review_metrics",
            action: "worker_review.metrics_10min",
            entityType: "agent",
            entityId: m.managerAgentId,
            agentId: m.managerAgentId,
            details: {
              ...m,
            },
          });
          summary.metricsLogged += 1;

          const alerts = evaluateKillCriteria(m);
          for (const alert of alerts) {
            await logActivity(db, {
              companyId: alert.companyId ?? m.companyId,
              actorType: "system",
              actorId: "worker_review_metrics",
              action: "worker_review.kill_criteria_alert",
              entityType: "agent",
              entityId: alert.managerAgentId ?? m.managerAgentId,
              agentId: alert.managerAgentId,
              details: {
                alertType: alert.alertType,
                ...alert.details,
              },
            });
            summary.alertsLogged += 1;
          }
        } catch (err) {
          logger.warn(
            { err, managerAgentId: m.managerAgentId },
            "worker_review_metrics: per-manager log failed",
          );
          summary.errors += 1;
        }
      }

      try {
        const stale = await evaluateGlobalStalePending(windowEnd);
        if (stale) {
          await logActivity(db, {
            companyId: stale.companyId ?? "00000000-0000-0000-0000-000000000000",
            actorType: "system",
            actorId: "worker_review_metrics",
            action: "worker_review.kill_criteria_alert",
            entityType: "worker_review",
            entityId: String(stale.details.reviewId ?? ""),
            agentId: stale.managerAgentId,
            details: {
              alertType: stale.alertType,
              ...stale.details,
            },
          });
          summary.alertsLogged += 1;
        }
      } catch (err) {
        logger.warn(
          { err },
          "worker_review_metrics: stale_pending evaluation failed",
        );
        summary.errors += 1;
      }
    } catch (err) {
      logger.error({ err }, "worker_review_metrics tick failed");
      summary.errors += 1;
    }

    if (summary.metricsLogged > 0 || summary.alertsLogged > 0 || summary.errors > 0) {
      logger.info({ ...summary }, "worker_review_metrics tick done");
    }
    return summary;
  }

  return {
    tick,
    isEnabled,
    // exported for tests
    _internals: {
      computeManagerMetrics,
      evaluateKillCriteria,
      evaluateGlobalStalePending,
    },
  };
}

export type WorkerReviewMetricsService = ReturnType<typeof workerReviewMetricsService>;
