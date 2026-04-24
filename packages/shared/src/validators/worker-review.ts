import { z } from "zod";

/**
 * Zod-skjemaer for manager-review-hook.
 * Tilhoerer `@paperclipai/shared`.
 *
 * Konvensjon: status-verdier paa worker_review_log er norske (PENDING,
 * GODKJENT, AVVIST, ESKALERT) for aa matche eksisterende DB-check-constraints.
 * API-en godtar engelske beslutningsverdier fra manageren og mapper dem
 * server-side til norske check-constraint-verdier.
 */

// Engelsk beslutning fra manager (MCP tool)
export const managerReviewDecisionEnum = z.enum(["approve", "reject", "escalate"]);
export type ManagerReviewDecision = z.infer<typeof managerReviewDecisionEnum>;

// Norsk DB-status (matcher CHECK-constraint)
export const workerReviewManagerStatusEnum = z.enum([
  "PENDING",
  "GODKJENT",
  "AVVIST",
  "ESKALERT",
]);
export type WorkerReviewManagerStatus = z.infer<typeof workerReviewManagerStatusEnum>;

export const workerReviewHumanDecisionEnum = z.enum([
  "GODKJENT",
  "AVVIST",
  "ENDRET",
  "PENDING",
]);
export type WorkerReviewHumanDecision = z.infer<typeof workerReviewHumanDecisionEnum>;

/**
 * Intern submit-input -- kalt fra approval-intercept (server-side only).
 * Eksporteres for gjenbruk i tests.
 */
export const submitReviewSchema = z.object({
  companyId: z.string().uuid(),
  workerAgentId: z.string().uuid(),
  managerAgentId: z.string().uuid().nullable().optional(),
  taskType: z.string().min(1),
  taskPayload: z.record(z.unknown()),
  proposedPayload: z.record(z.unknown()),
  rationale: z.string().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  taskKey: z.string().nullable().optional(),
  parentReviewId: z.string().uuid().nullable().optional(),
  workerAttempt: z.number().int().min(1).optional(),
});
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;

/**
 * HTTP-body for POST /api/worker-reviews/:id/decision
 */
export const reviewDecisionSchema = z.object({
  decision: managerReviewDecisionEnum,
  note: z.string().nullable().optional(),
  redlinedPayload: z.record(z.unknown()).optional(),
});
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/**
 * Query-params for GET /api/companies/:companyId/worker-reviews/pending
 */
export const listPendingReviewsQuerySchema = z.object({
  manager_agent_id: z.string().uuid(),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});
export type ListPendingReviewsQuery = z.infer<typeof listPendingReviewsQuerySchema>;

/**
 * Kapasitetstak (brukt av service-lag for backpressure)
 */
export const WORKER_REVIEW_LIMITS = {
  maxPendingPerWorker: 10,
  maxPendingPerManager: 50,
  maxRetries: 2,
  stallEscalationMs: 60 * 60 * 1000, // 1h
  catchUpSweepStaleMs: 5 * 60 * 1000, // 5min
  catchUpSweepIdleMs: 15 * 60 * 1000, // 15min
} as const;
