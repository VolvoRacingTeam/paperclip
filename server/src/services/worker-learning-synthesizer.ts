import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, workerReviewLog, type WorkerReviewLog } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { parseCron, nextCronTick } from "./cron.js";
import { logActivity } from "./activity-log.js";

/**
 * Nattlig synthesis av manager-review-patterns.
 *
 * For hver manager-agent: for hver underordnet worker, bygg et vindu med de
 * nyeste REVIEW-radene (opptil 12 stk) fra siste 7 dager som ble avgjort
 * av manager ELLER av Tore. Hvis worker har < 3 reviews i vinduet, skip.
 *
 * Manageren vekkes via heartbeat.wakeup med contextSnapshot som identifiserer
 * synthesis-modus (wakeReason=nightly_synthesis) og inkluderer review-pakkene.
 * Manager AGENTS.md-prompt gjenkjenner modusen og skal KUN kalle
 * upsert_worker_pattern (ikke list/decide-review).
 *
 * Idempotency-key: synthesis:<managerId>:<workerId>:<YYYY-MM-DD>.
 * Env-var PAPERCLIP_MANAGER_REVIEW_SYNTHESIS_ENABLED = "true" for aa aktivere;
 * default avslaatt.
 */

export interface WorkerReviewSynthesizerDeps {
  heartbeat: {
    wakeup: (
      agentId: string,
      opts: {
        source?: "timer" | "assignment" | "on_demand" | "automation";
        triggerDetail?: "manual" | "ping" | "callback" | "system";
        reason?: string | null;
        idempotencyKey?: string | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  };
  now?: () => Date;
}

const DECIDED_STATUSES = ["GODKJENT", "AVVIST", "ESKALERT"] as const;
const MAX_PACKETS_PER_WORKER = 12;
const MIN_PACKETS_FOR_SYNTHESIS = 3;
const WINDOW_DAYS = 7;

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export interface SynthesisSummary {
  managersProcessed: number;
  managersSkipped: number;
  workersProcessed: number;
  workersSkipped: number;
  wakeupsEnqueued: number;
  errors: number;
}

export function workerLearningSynthesizer(db: Db, deps: WorkerReviewSynthesizerDeps) {
  const nowFn = deps.now ?? (() => new Date());

  async function synthesizeAll(now?: Date): Promise<SynthesisSummary> {
    const ts = now ?? nowFn();
    const windowStart = new Date(ts.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const summary: SynthesisSummary = {
      managersProcessed: 0,
      managersSkipped: 0,
      workersProcessed: 0,
      workersSkipped: 0,
      wakeupsEnqueued: 0,
      errors: 0,
    };

    const managerRows = await db
      .selectDistinct({ managerId: workerReviewLog.managerAgentId })
      .from(workerReviewLog)
      .where(
        and(
          gte(workerReviewLog.createdAt, windowStart),
          inArray(workerReviewLog.managerDecision, [...DECIDED_STATUSES]),
        ),
      );

    for (const mgr of managerRows) {
      if (!mgr.managerId) continue;
      const managerAgent = await db
        .select({ id: agents.id, status: agents.status, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, mgr.managerId))
        .then((rows) => rows[0] ?? null);
      if (!managerAgent) {
        summary.managersSkipped += 1;
        continue;
      }
      if (managerAgent.status === "paused" || managerAgent.status === "terminated") {
        summary.managersSkipped += 1;
        continue;
      }

      const workers = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.reportsTo, mgr.managerId));

      if (workers.length === 0) {
        summary.managersSkipped += 1;
        continue;
      }
      summary.managersProcessed += 1;

      for (const worker of workers) {
        try {
          const rows = await db
            .select()
            .from(workerReviewLog)
            .where(
              and(
                eq(workerReviewLog.managerAgentId, mgr.managerId),
                eq(workerReviewLog.workerAgentId, worker.id),
                gte(workerReviewLog.createdAt, windowStart),
                inArray(workerReviewLog.managerDecision, [...DECIDED_STATUSES]),
              ),
            )
            .orderBy(desc(workerReviewLog.createdAt))
            .limit(MAX_PACKETS_PER_WORKER);

          if (rows.length < MIN_PACKETS_FOR_SYNTHESIS) {
            summary.workersSkipped += 1;
            continue;
          }

          const reviewPackets = rows.map((r: WorkerReviewLog) => ({
            review_id: r.id,
            task_type: r.taskType,
            manager_decision: r.managerDecision,
            manager_feedback: r.managerFeedback,
            manager_decided_at: r.managerDecidedAt?.toISOString() ?? null,
            worker_attempt: r.workerAttempt ?? 1,
            attempt_count: r.attemptCount ?? 0,
            human_decision: r.humanDecision,
            human_feedback: r.humanFeedback,
            proposed_payload: r.workerOutput,
            created_at:
              r.createdAt instanceof Date
                ? r.createdAt.toISOString()
                : new Date(r.createdAt as unknown as string).toISOString(),
          }));

          const idempotencyKey = `synthesis:${mgr.managerId}:${worker.id}:${isoDate(ts)}`;

          await deps.heartbeat.wakeup(mgr.managerId, {
            source: "automation",
            triggerDetail: "system",
            reason: "nightly_synthesis",
            requestedByActorType: "system",
            requestedByActorId: "worker_learning_synthesizer",
            idempotencyKey,
            contextSnapshot: {
              source: "worker_learning_synthesizer",
              wakeSource: "automation",
              wakeReason: "nightly_synthesis",
              targetWorkerId: worker.id,
              reviewRowIds: rows.map((r) => r.id),
              windowStart: windowStart.toISOString(),
              windowEnd: ts.toISOString(),
              reviewPackets,
            },
          });
          summary.wakeupsEnqueued += 1;
          summary.workersProcessed += 1;
          await logActivity(db, {
            companyId: worker.companyId,
            actorType: "system",
            actorId: "worker_learning_synthesizer",
            action: "worker_learning.synthesis_wakeup",
            entityType: "agent",
            entityId: worker.id,
            agentId: mgr.managerId,
            details: {
              packetCount: reviewPackets.length,
              windowStart: windowStart.toISOString(),
              idempotencyKey,
            },
          });
        } catch (err) {
          logger.error(
            { err, managerId: mgr.managerId, workerId: worker.id },
            "worker_learning_synthesizer: per-worker failure",
          );
          summary.errors += 1;
        }
      }
    }

    logger.info({ ...summary, windowStart: windowStart.toISOString() }, "worker_learning_synthesizer tick done");
    return summary;
  }

  /**
   * Returnerer true hvis gjeldende tidspunkt krysser cron-tick siden forrige
   * tick-tidspunkt.
   */
  function shouldFire(
    cronExpression: string,
    lastTickAt: Date | null,
    now: Date,
  ): boolean {
    const cron = parseCron(cronExpression);
    const base = lastTickAt ?? new Date(now.getTime() - 2 * 60 * 1000);
    const next = nextCronTick(cron, base);
    if (!next) return false;
    return next.getTime() <= now.getTime();
  }

  return { synthesizeAll, shouldFire };
}

export type WorkerLearningSynthesizer = ReturnType<typeof workerLearningSynthesizer>;
