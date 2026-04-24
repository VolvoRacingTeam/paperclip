import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  workerReviewLog,
  workerLearningPatterns,
  type WorkerReviewLog,
  type NewWorkerReviewLog,
  type WorkerLearningPattern,
} from "@paperclipai/db";
import {
  WORKER_REVIEW_LIMITS,
  type ManagerReviewDecision,
  type SubmitReviewInput,
  type UpsertWorkerPatternInput,
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

/**
 * Vi lagrer ikke severity i en egen kolonne (worker_learning_patterns
 * har ikke severity). Vi koder den inn som en markoer-linje i
 * pattern_description saa injection-rendringen kan lese den tilbake.
 * Format: f.eks. foerste linje = "[severity=critical] <original description>".
 * Hvis markoer mangler, anta warning.
 */
function extractSeverityFromDesc(
  desc: string | null,
): "info" | "warning" | "critical" {
  if (!desc) return "warning";
  const m = /^\[severity=(info|warning|critical)\]/u.exec(desc);
  return (m?.[1] as "info" | "warning" | "critical" | undefined) ?? "warning";
}

function stripSeverityMarker(desc: string): string {
  return desc.replace(/^\[severity=(info|warning|critical)\]\s*/u, "");
}

function formatDescriptionWithSeverity(
  desc: string,
  severity: "info" | "warning" | "critical",
): string {
  return "[severity=" + severity + "] " + stripSeverityMarker(desc);
}

function extractRationaleFromTask(row: WorkerReviewLog): string | null {
  const payload = row.taskPayload as Record<string, unknown> | null;
  if (!payload) return null;
  const r = payload.rationale;
  if (typeof r === "string" && r.trim().length > 0) return r;
  return null;
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
    // Vi hydraterer hele review-pakken slik at managerens context-snapshot
    // har `currentReview` direkte tilgjengelig og dermed trenger ikke et
    // ekstra HTTP-kall for detaljer.
    let currentReview: Record<string, unknown> | null = null;
    try {
      currentReview = await hydrateReviewPacket(row.id);
    } catch (err) {
      logger.warn({ err, reviewId: row.id }, "worker_review: hydrateReviewPacket failed");
    }
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
          wakeSource: "automation",
          wakeReason: "manager_review_pending",
          reason: "manager_review_pending",
          reviewId: row.id,
          workerAgentId: input.workerAgentId,
          taskType: input.taskType,
          currentReview,
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
      // Fix 3: bruk transaksjon for aa unngaa zombie-rader (managerDecision
      // satt til GODKJENT uten approvalId hvis approval-insert kaster).
      // Vi inserter direkte i approvals-tabellen via tx fordi
      // deps.approvals.create lukker over root-db. Hvis insert feiler,
      // rulles UPDATE av workerReviewLog ogsaa tilbake.
      const approvalId = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(approvals)
          .values({
            companyId: row.companyId,
            type: row.taskType,
            requestedByAgentId: row.workerAgentId,
            requestedByUserId: null,
            payload: payloadWithMeta,
            status: "pending",
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            updatedAt: new Date(),
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!inserted) return null;
        await tx
          .update(workerReviewLog)
          .set({ approvalId: inserted.id, updatedAt: nowFn() })
          .where(eq(workerReviewLog.id, row.id));
        return inserted.id;
      });
      return approvalId;
    } catch (err) {
      logger.error(
        { err, reviewId: row.id },
        "worker_review.promoteToApproval failed",
      );
      throw err;
    }
  }

  async function queueWorkerRetry(row: WorkerReviewLog, feedback: string): Promise<void> {
    // Fix 1+8 (off-by-one + idempotency-determinism):
    // Idempotency-key avledes fra (row.id, row.attemptCount FOER UPDATE).
    // Det betyr at hvis denne funksjonen re-invokes paa samme rad foer
    // UPDATE har commited, faar vi samme idempotency-key.
    const previousAttempt = row.attemptCount ?? 0;
    const nextAttempt = previousAttempt + 1;
    // Eskaler hvis dette overskrider maks retries (3. reject -> escalate).
    // maxRetries=2 betyr: vi tillater 1. og 2. reject som retry, 3. -> escalate.
    if (nextAttempt > WORKER_REVIEW_LIMITS.maxRetries) {
      // Vi beholder attempt_count slik at audit-trail viser eskalering paa
      // forsoek N+1, ikke pa et oppblast tall.
      await db
        .update(workerReviewLog)
        .set({ attemptCount: nextAttempt, updatedAt: nowFn() })
        .where(eq(workerReviewLog.id, row.id));
      await escalate(
        row,
        `Max retries reached (${nextAttempt}). Last feedback: ${feedback}`,
        { attemptCountOverride: nextAttempt },
      );
      return;
    }

    // Fix 5 (silent fault): Markeres PENDING_RETRY foer wakeup. Sweep
    // ignorerer denne statusen slik at vi ikke fyrer dobbel-wakeup eller
    // havner i en evig loop hvis wakeup feiler.
    await db
      .update(workerReviewLog)
      .set({
        managerDecision: "PENDING_RETRY",
        attemptCount: nextAttempt,
        updatedAt: nowFn(),
      })
      .where(eq(workerReviewLog.id, row.id));

    try {
      await deps.heartbeat.wakeup(row.workerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "manager_review_retry",
        requestedByActorType: "system",
        requestedByActorId: "worker_review_hook",
        idempotencyKey: `review-retry:${row.id}:${previousAttempt}`,
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
      logger.warn(
        { err, reviewId: row.id },
        "worker_review: retry wakeup failed (rad er PENDING_RETRY; egen retry-sweep maa plukke opp)",
      );
    }

    // Fix 7: aktivitetslog for retry-enqueue
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "system",
      actorId: "worker_review_hook",
      action: "worker_review.retry_enqueued",
      entityType: "worker_review",
      entityId: row.id,
      agentId: row.workerAgentId,
      details: {
        reviewId: row.id,
        workerAgentId: row.workerAgentId,
        attemptCount: nextAttempt,
        feedback,
      },
    });
  }

  async function escalate(
    row: WorkerReviewLog,
    managerNote: string,
    opts: { attemptCountOverride?: number } = {},
  ): Promise<string | null> {
    // Hvis caller (queueWorkerRetry) allerede har gjort UPDATE som
    // inkrementerer attempt_count, vil row.attemptCount vaere foreldet.
    // attemptCountOverride lar oss logge riktig tall.
    const effectiveAttemptCount = opts.attemptCountOverride ?? row.attemptCount;
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
        attemptCount: effectiveAttemptCount,
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
        details: {
          approvalId: approval.id,
          managerNote,
          attemptCount: effectiveAttemptCount,
        },
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

  /**
   * Upsert et pattern for en worker-agent. Upsert-noekkel er
   * (worker_agent_id, pattern_tag). Ved eksisterende rad: oeker
   * occurrence_count, oppdaterer last_seen_at og velger strengeste severity.
   */
  async function upsertWorkerPattern(
    input: UpsertWorkerPatternInput & { companyId: string },
  ): Promise<{ pattern: WorkerLearningPattern; createdOrUpdated: "created" | "updated" }> {
    const now = nowFn();
    const exampleCorrectObj = input.exampleCorrect
      ? { text: input.exampleCorrect }
      : null;
    const exampleWrongObj = input.exampleWrong ? { text: input.exampleWrong } : null;

    const severityRank = { info: 1, warning: 2, critical: 3 } as const;

    const existing = await db
      .select()
      .from(workerLearningPatterns)
      .where(
        and(
          eq(workerLearningPatterns.workerAgentId, input.workerAgentId),
          eq(workerLearningPatterns.patternTag, input.patternTag),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!existing) {
      const inserted = await db
        .insert(workerLearningPatterns)
        .values({
          companyId: input.companyId,
          workerAgentId: input.workerAgentId,
          patternTag: input.patternTag,
          patternDescription: formatDescriptionWithSeverity(
            input.patternDescription,
            input.severity,
          ),
          exampleCorrect: exampleCorrectObj,
          exampleWrong: exampleWrongObj,
          occurrenceCount: 1,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "agent",
        actorId: "manager",
        action: "worker_pattern.created",
        entityType: "worker_learning_pattern",
        entityId: inserted.id,
        agentId: input.workerAgentId,
        details: { patternTag: input.patternTag, severity: input.severity },
      });
      return { pattern: inserted, createdOrUpdated: "created" };
    }

    const prevSev = extractSeverityFromDesc(existing.patternDescription);
    const nextSev =
      severityRank[input.severity] > severityRank[prevSev]
        ? input.severity
        : prevSev;
    const nextDescription = formatDescriptionWithSeverity(
      input.patternDescription,
      nextSev,
    );

    const updated = await db
      .update(workerLearningPatterns)
      .set({
        patternDescription: nextDescription,
        exampleCorrect: exampleCorrectObj ?? existing.exampleCorrect,
        exampleWrong: exampleWrongObj ?? existing.exampleWrong,
        occurrenceCount: (existing.occurrenceCount ?? 1) + 1,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(workerLearningPatterns.id, existing.id))
      .returning()
      .then((rows) => rows[0]);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: "manager",
      action: "worker_pattern.updated",
      entityType: "worker_learning_pattern",
      entityId: existing.id,
      agentId: input.workerAgentId,
      details: {
        patternTag: input.patternTag,
        severity: nextSev,
        occurrenceCount: updated.occurrenceCount,
      },
    });
    return { pattern: updated, createdOrUpdated: "updated" };
  }

  /**
   * Bygger en normalisert review-pakke til injeksjon i contextSnapshot
   * naar manager vekkes. Inkluderer parent-review-kjeden (opp til 3 hopp)
   * saa manageren ser tidligere forsoek fra samme worker paa samme sak.
   */
  async function hydrateReviewPacket(
    reviewId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await getById(reviewId);
    if (!row) return null;
    const worker = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.id, row.workerAgentId))
      .then((rows) => rows[0] ?? null);

    const parentHistory: Array<Record<string, unknown>> = [];
    let cursor: WorkerReviewLog | null = row;
    let hops = 0;
    while (cursor?.parentReviewId && hops < 3) {
      const parent = await getById(cursor.parentReviewId);
      if (!parent) break;
      parentHistory.unshift({
        review_id: parent.id,
        manager_decision: parent.managerDecision,
        manager_feedback: parent.managerFeedback,
        attempt_count: parent.attemptCount ?? 0,
        decided_at: parent.managerDecidedAt?.toISOString() ?? null,
      });
      cursor = parent;
      hops += 1;
    }

    return {
      review_id: row.id,
      worker_agent_id: row.workerAgentId,
      worker_name: worker?.name ?? null,
      approval_type: row.taskType,
      proposed_payload: row.workerOutput,
      rationale: extractRationaleFromTask(row),
      attempt_count: row.attemptCount ?? 0,
      parent_review_history: parentHistory,
      submitted_at: row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt as unknown as string).toISOString(),
    };
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
    upsertWorkerPattern,
    hydrateReviewPacket,
  };
}

export type WorkerReviewService = ReturnType<typeof workerReviewService>;
