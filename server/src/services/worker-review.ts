import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  workerReviewLog,
  type WorkerReviewLog,
  type NewWorkerReviewLog,
} from "@paperclipai/db";
import {
  WORKER_REVIEW_LIMITS,
  type ManagerReviewDecision,
  type SubmitReviewInput,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { approvalService } from "./approvals.js";

/**
 * Heartbeat-dependency injisert (minimumsoverflate vi trenger).
 * Vi duplikaterer ikke HeartbeatService-typen for aa unngaa sirkulaer
 * import og for aa gjoere testing mindre smertefullt.
 */
export interface HeartbeatDep {
  wakeup: (
    agentId: string,
    opts: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

/**
 * Subset av approvalService vi trenger (unngaar sirkulaer import).
 */
export type ApprovalsDep = ReturnType<typeof approvalService>;

export interface WorkerReviewServiceDeps {
  heartbeat: HeartbeatDep;
  approvals: ApprovalsDep;
  now?: () => Date;
}

/**
 * Kanonisk JSON for dup-hashing. Sorter noekler paa alle nivaaer.
 */
function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  function encode(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(encode);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[key] = encode((v as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return JSON.stringify(encode(value));
}

export function computePayloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/**
 * Manager-decision (engelsk) -> DB check-constraint (norsk).
 */
function mapDecisionToDbStatus(decision: ManagerReviewDecision): "GODKJENT" | "AVVIST" | "ESKALERT" {
  switch (decision) {
    case "approve":
      return "GODKJENT";
    case "reject":
      return "AVVIST";
    case "escalate":
      return "ESKALERT";
  }
}

export function workerReviewService(db: Db, deps: WorkerReviewServiceDeps) {
  const nowFn = deps.now ?? (() => new Date());

  async function resolveManager(workerAgentId: string): Promise<string | null> {
    const row = await db
      .select({ id: agents.id, reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, workerAgentId))
      .then((rows) => rows[0] ?? null);
    return row?.reportsTo ?? null;
  }

  async function countPendingForWorker(workerAgentId: string): Promise<number> {
    const row = await db
      .select({ c: count() })
      .from(workerReviewLog)
      .where(
        and(
          eq(workerReviewLog.workerAgentId, workerAgentId),
          eq(workerReviewLog.managerDecision, "PENDING"),
        ),
      )
      .then((rows) => rows[0] ?? { c: 0 });
    return Number(row.c ?? 0);
  }

  async function countPendingForManager(managerAgentId: string): Promise<number> {
    const row = await db
      .select({ c: count() })
      .from(workerReviewLog)
      .where(
        and(
          eq(workerReviewLog.managerAgentId, managerAgentId),
          eq(workerReviewLog.managerDecision, "PENDING"),
        ),
      )
      .then((rows) => rows[0] ?? { c: 0 });
    return Number(row.c ?? 0);
  }

  async function findDuplicateRejected(
    workerAgentId: string,
    payloadHash: string,
  ): Promise<WorkerReviewLog | null> {
    const row = await db
      .select()
      .from(workerReviewLog)
      .where(
        and(
          eq(workerReviewLog.workerAgentId, workerAgentId),
          eq(workerReviewLog.payloadHash, payloadHash),
          eq(workerReviewLog.managerDecision, "AVVIST"),
        ),
      )
      .orderBy(desc(workerReviewLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ?? null;
  }

  async function getById(reviewId: string): Promise<WorkerReviewLog | null> {
    return db
      .select()
      .from(workerReviewLog)
      .where(eq(workerReviewLog.id, reviewId))
      .then((rows) => rows[0] ?? null);
  }

  async function listPendingForManager(
    managerAgentId: string,
    opts: { limit?: number } = {},
  ): Promise<WorkerReviewLog[]> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
    return db
      .select()
      .from(workerReviewLog)
      .where(
        and(
          eq(workerReviewLog.managerAgentId, managerAgentId),
          eq(workerReviewLog.managerDecision, "PENDING"),
        ),
      )
      .orderBy(asc(workerReviewLog.createdAt))
      .limit(limit);
  }

  async function oldestPendingAge(managerAgentId: string): Promise<number> {
    const row = await db
      .select({ oldest: sql<Date | null>`min(${workerReviewLog.createdAt})` })
      .from(workerReviewLog)
      .where(
        and(
          eq(workerReviewLog.managerAgentId, managerAgentId),
          eq(workerReviewLog.managerDecision, "PENDING"),
        ),
      )
      .then((rows) => rows[0] ?? { oldest: null });
    if (!row.oldest) return 0;
    const oldestAt = row.oldest instanceof Date ? row.oldest : new Date(row.oldest);
    return Math.max(0, nowFn().getTime() - oldestAt.getTime());
  }

  async function submitForReview(input: SubmitReviewInput): Promise<WorkerReviewLog> {
    const now = nowFn();

    // 1. Resolve manager
    const resolvedManagerId =
      input.managerAgentId ?? (await resolveManager(input.workerAgentId));
    if (!resolvedManagerId) {
      throw unprocessable(
        "Worker does not have a reports_to manager; cannot route for manager review",
      );
    }

    // 2. Backpressure
    const [perWorker, perManager] = await Promise.all([
      countPendingForWorker(input.workerAgentId),
      countPendingForManager(resolvedManagerId),
    ]);
    if (perWorker >= WORKER_REVIEW_LIMITS.maxPendingPerWorker) {
      throw conflict(
        `Worker has ${perWorker} pending reviews (max ${WORKER_REVIEW_LIMITS.maxPendingPerWorker}); back off before submitting more`,
      );
    }
    if (perManager >= WORKER_REVIEW_LIMITS.maxPendingPerManager) {
      throw conflict(
        `Manager queue saturated: ${perManager} pending (max ${WORKER_REVIEW_LIMITS.maxPendingPerManager})`,
      );
    }

    // 3. Dup-hash short-circuit
    const payloadHash = computePayloadHash(input.proposedPayload);
    const duplicate = await findDuplicateRejected(input.workerAgentId, payloadHash);
    if (duplicate) {
      const rejectedRow = await db
        .insert(workerReviewLog)
        .values({
          companyId: input.companyId,
          workerAgentId: input.workerAgentId,
          managerAgentId: resolvedManagerId,
          taskType: input.taskType,
          taskPayload: input.taskPayload,
          workerOutput: input.proposedPayload,
          workerAttempt: input.workerAttempt ?? 1,
          workerRunId: input.sourceRunId ?? null,
          managerDecision: "AVVIST",
          managerFeedback: `Duplikat av tidligere avvist forslag (${duplicate.id}). Endre forslaget foer nytt forsoek.`,
          managerDecidedAt: now,
          payloadHash,
          parentReviewId: input.parentReviewId ?? null,
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        } satisfies NewWorkerReviewLog)
        .returning()
        .then((rows) => rows[0]);
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "worker_review_hook",
        action: "worker_review.auto_rejected_duplicate",
        entityType: "worker_review",
        entityId: rejectedRow.id,
        agentId: input.workerAgentId,
        details: { duplicateOf: duplicate.id, payloadHash },
      });
      return rejectedRow;
    }

    // 4. Insert PENDING row
    const row = await db
      .insert(workerReviewLog)
      .values({
        companyId: input.companyId,
        workerAgentId: input.workerAgentId,
        managerAgentId: resolvedManagerId,
        taskType: input.taskType,
        taskPayload: input.taskPayload,
        workerOutput: input.proposedPayload,
        workerAttempt: input.workerAttempt ?? 1,
        workerRunId: input.sourceRunId ?? null,
        managerDecision: "PENDING",
        payloadHash,
        parentReviewId: input.parentReviewId ?? null,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      } satisfies NewWorkerReviewLog)
      .returning()
      .then((rows) => rows[0]);

    // 5. Heartbeat wakeup -- idempotent per review-id
    try {
      await deps.heartbeat.wakeup(resolvedManagerId, {
        source: "automation",
        triggerDetail: "system",
        reason: "manager_review_pending",
        requestedByActorType: "system",
        requestedByActorId: "worker_review_hook",
        idempotencyKey: `review:${row.id}`,
        contextSnapshot: {
          source: "worker_review_hook",
          reason: "manager_review_pending",
          reviewId: row.id,
          workerAgentId: input.workerAgentId,
          taskType: input.taskType,
        },
      });
    } catch (err) {
      logger.warn(
        { err, reviewId: row.id, managerId: resolvedManagerId },
        "worker_review: failed to wake manager (catch-up sweep vil plukke opp)",
      );
    }

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "worker_review_hook",
      action: "worker_review.submitted",
      entityType: "worker_review",
      entityId: row.id,
      agentId: input.workerAgentId,
      details: {
        managerAgentId: resolvedManagerId,
        taskType: input.taskType,
        workerAttempt: row.workerAttempt,
        parentReviewId: row.parentReviewId ?? null,
      },
    });

    return row;
  }

  /**
   * Atomic CAS: oppdater rad kun hvis status fortsatt er PENDING.
   * Kaster 409 Conflict hvis noen andre allerede har avgjort saken.
   */
  async function recordManagerDecision(
    reviewId: string,
    decision: ManagerReviewDecision,
    note: string | null,
    redlinedPayload: Record<string, unknown> | undefined,
    actor: { managerAgentId: string; idempotencyKey?: string | null },
  ): Promise<{ row: WorkerReviewLog; approvalId?: string | null }> {
    const existing = await getById(reviewId);
    if (!existing) throw notFound("Review not found");
    if (existing.managerAgentId !== actor.managerAgentId) {
      throw conflict("Only the assigned manager-agent can decide this review");
    }
    if (existing.managerDecision !== "PENDING") {
      if (actor.idempotencyKey && existing.idempotencyKey === actor.idempotencyKey) {
        return { row: existing, approvalId: existing.approvalId ?? null };
      }
      throw conflict(`Review already in status ${existing.managerDecision}`);
    }

    const now = nowFn();
    const dbStatus = mapDecisionToDbStatus(decision);
    const reasoningPayload: Record<string, unknown> = {
      decision,
      decidedAt: now.toISOString(),
      byManagerAgentId: actor.managerAgentId,
    };
    if (redlinedPayload) {
      reasoningPayload.redlinedPayload = redlinedPayload;
      reasoningPayload.originalPayloadHash = existing.payloadHash;
    }

    const updated = await db
      .update(workerReviewLog)
      .set({
        managerDecision: dbStatus,
        managerFeedback: note ?? null,
        managerReasoning: reasoningPayload,
        managerDecidedAt: now,
        idempotencyKey: actor.idempotencyKey ?? existing.idempotencyKey ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(workerReviewLog.id, reviewId),
          eq(workerReviewLog.managerDecision, "PENDING"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      const latest = await getById(reviewId);
      throw conflict(
        `Review was modified concurrently; current status: ${latest?.managerDecision ?? "unknown"}`,
      );
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "agent",
      actorId: actor.managerAgentId,
      action: `worker_review.${decision}`,
      entityType: "worker_review",
      entityId: updated.id,
      agentId: actor.managerAgentId,
      details: {
        workerAgentId: updated.workerAgentId,
        decision,
        hasRedline: !!redlinedPayload,
      },
    });

    // Follow-up actions
    if (decision === "approve") {
      const approvalId = await promoteToApproval(updated, redlinedPayload);
      return { row: updated, approvalId };
    }
    if (decision === "reject") {
      await queueWorkerRetry(updated, note ?? "");
      return { row: updated };
    }
    // escalate -> create escalated_worker_action approval
    const approvalId = await escalate(updated, note ?? "");
    return { row: updated, approvalId };
  }

  async function promoteToApproval(
    row: WorkerReviewLog,
    redlinedPayload: Record<string, unknown> | undefined,
  ): Promise<string | null> {
    const finalPayload = redlinedPayload ?? (row.workerOutput as Record<string, unknown>);
    const payloadWithMeta: Record<string, unknown> = {
      ...finalPayload,
      __worker_review: {
        reviewId: row.id,
        workerAgentId: row.workerAgentId,
        managerAgentId: row.managerAgentId,
        managerApprovedAt: row.managerDecidedAt?.toISOString() ?? new Date().toISOString(),
        originalPayloadHash: row.payloadHash,
        redlinedByManager: !!redlinedPayload,
      },
    };
    try {
      const approval = await deps.approvals.create(row.companyId, {
        type: row.taskType,
        requestedByAgentId: row.workerAgentId,
        requestedByUserId: null,
        payload: payloadWithMeta,
        status: "pending",
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      } as Parameters<typeof deps.approvals.create>[1]);
      if (!approval) return null;
      await db
        .update(workerReviewLog)
        .set({ approvalId: approval.id, updatedAt: nowFn() })
        .where(eq(workerReviewLog.id, row.id));
      return approval.id;
    } catch (err) {
      logger.error(
        { err, reviewId: row.id },
        "worker_review.promoteToApproval failed",
      );
      throw err;
    }
  }

  async function queueWorkerRetry(row: WorkerReviewLog, feedback: string): Promise<void> {
    const nextAttempt = (row.attemptCount ?? 0) + 1;
    await db
      .update(workerReviewLog)
      .set({ attemptCount: nextAttempt, updatedAt: nowFn() })
      .where(eq(workerReviewLog.id, row.id));

    if (nextAttempt >= WORKER_REVIEW_LIMITS.maxRetries) {
      // Eskaler
      await escalate(row, `Max retries reached (${nextAttempt}). Last feedback: ${feedback}`);
      return;
    }

    try {
      await deps.heartbeat.wakeup(row.workerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "manager_review_retry",
        requestedByActorType: "system",
        requestedByActorId: "worker_review_hook",
        idempotencyKey: `review-retry:${row.id}:${nextAttempt}`,
        contextSnapshot: {
          source: "worker_review_hook",
          reason: "manager_review_retry",
          reviewId: row.id,
          attemptCount: nextAttempt,
          managerFeedback: feedback,
          originalTaskType: row.taskType,
          originalTaskPayload: row.taskPayload,
        },
      });
    } catch (err) {
      logger.warn({ err, reviewId: row.id }, "worker_review: retry wakeup failed");
    }

    await logActivity(db, {
      companyId: row.companyId,
      actorType: "system",
      actorId: "worker_review_hook",
      action: "worker_review.retry_queued",
      entityType: "worker_review",
      entityId: row.id,
      agentId: row.workerAgentId,
      details: { attemptCount: nextAttempt, feedback },
    });
  }

  async function escalate(row: WorkerReviewLog, managerNote: string): Promise<string | null> {
    const escalationPayload: Record<string, unknown> = {
      workerOutput: row.workerOutput,
      taskPayload: row.taskPayload,
      taskType: row.taskType,
      managerNote,
      __worker_review: {
        reviewId: row.id,
        workerAgentId: row.workerAgentId,
        managerAgentId: row.managerAgentId,
        escalation: true,
        attemptCount: row.attemptCount,
      },
    };
    try {
      const approval = await deps.approvals.create(row.companyId, {
        type: "escalated_worker_action",
        requestedByAgentId: row.managerAgentId ?? row.workerAgentId,
        requestedByUserId: null,
        payload: escalationPayload,
        status: "pending",
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      } as Parameters<typeof deps.approvals.create>[1]);
      if (!approval) return null;
      await db
        .update(workerReviewLog)
        .set({
          approvalId: approval.id,
          managerDecision: "ESKALERT",
          updatedAt: nowFn(),
        })
        .where(eq(workerReviewLog.id, row.id));
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: "worker_review_hook",
        action: "worker_review.escalated",
        entityType: "worker_review",
        entityId: row.id,
        agentId: row.managerAgentId ?? row.workerAgentId,
        details: { approvalId: approval.id, managerNote },
      });
      return approval.id;
    } catch (err) {
      logger.error({ err, reviewId: row.id }, "worker_review.escalate failed");
      throw err;
    }
  }

  /**
   * Kalles fra approval-resolve (godkjenn/avvis av Tore).
   * Speiler beslutningen tilbake paa review-raden.
   */
  async function recordHumanDecision(
    reviewId: string,
    decision: "GODKJENT" | "AVVIST" | "ENDRET",
    feedback: string | null,
    editedOutput: Record<string, unknown> | null,
  ): Promise<WorkerReviewLog | null> {
    const now = nowFn();
    const updated = await db
      .update(workerReviewLog)
      .set({
        humanDecision: decision,
        humanFeedback: feedback ?? null,
        humanEditedOutput: editedOutput ?? null,
        humanDecidedAt: now,
        updatedAt: now,
      })
      .where(eq(workerReviewLog.id, reviewId))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (updated) {
      await logActivity(db, {
        companyId: updated.companyId,
        actorType: "user",
        actorId: "board",
        action: "worker_review.human_decision",
        entityType: "worker_review",
        entityId: updated.id,
        details: { decision, hasFeedback: !!feedback, hasEdit: !!editedOutput },
      });
    }
    return updated;
  }

  /**
   * Finn alle managere (agent som er target for reports_to fra minst en annen agent).
   * Brukt av catch-up sweep.
   */
  async function listManagerAgents(): Promise<
    Array<{ id: string; companyId: string; lastHeartbeatAt: Date | null }>
  > {
    return db
      .selectDistinct({
        id: agents.id,
        companyId: agents.companyId,
        lastHeartbeatAt: agents.lastHeartbeatAt,
      })
      .from(agents)
      .innerJoin(
        sql`(select distinct reports_to as mgr from agents where reports_to is not null) sub`,
        sql`sub.mgr = ${agents.id}`,
      );
  }

  return {
    submitForReview,
    listPendingForManager,
    recordManagerDecision,
    promoteToApproval,
    queueWorkerRetry,
    escalate,
    recordHumanDecision,
    getById,
    countPending: countPendingForManager,
    countPendingForWorker,
    oldestPendingAge,
    listManagerAgents,
    computePayloadHash,
  };
}

export type WorkerReviewService = ReturnType<typeof workerReviewService>;
