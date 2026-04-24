import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

/**
 * Log over worker-forslag som sendes til manager-review (Sonnet-manager).
 *
 * Tabellen ble opprettet direkte i database (utenfor Drizzle) 2026-04-24.
 * Denne skjemafilen representerer den eksisterende strukturen pluss tre
 * kolonner som legges til i migration 0047 (`approval_id`, `attempt_count`,
 * `parent_review_id`, `payload_hash`, `idempotency_key`).
 *
 * Semantikk:
 *   - En rad = ett worker-forslag som krever manager-review foer eventuell
 *     promotering til `approvals`-tabellen.
 *   - `manager_decision` driver status-maskinen:
 *       PENDING   -> ventende manager-review
 *       GODKJENT  -> manager approved (vi promoterer til approvals)
 *       AVVIST    -> manager rejected (worker faar retry, opp til max_retries)
 *       ESKALERT  -> manager eskalerer direkte til bruker
 *   - `human_decision` fylles senere naar Tore resolver en promoted approval.
 */
export const workerReviewLog = pgTable(
  "worker_review_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    workerAgentId: uuid("worker_agent_id")
      .notNull()
      .references(() => agents.id),
    managerAgentId: uuid("manager_agent_id").references(() => agents.id),
    taskType: text("task_type").notNull(),
    taskPayload: jsonb("task_payload").$type<Record<string, unknown>>().notNull(),
    workerOutput: jsonb("worker_output").$type<Record<string, unknown>>().notNull(),
    workerAttempt: integer("worker_attempt").notNull().default(1),
    workerRunId: uuid("worker_run_id"),
    managerDecision: text("manager_decision"),
    managerFeedback: text("manager_feedback"),
    managerReasoning: jsonb("manager_reasoning").$type<Record<string, unknown>>(),
    managerDecidedAt: timestamp("manager_decided_at", { withTimezone: true }),
    humanDecision: text("human_decision"),
    humanFeedback: text("human_feedback"),
    humanEditedOutput: jsonb("human_edited_output").$type<Record<string, unknown>>(),
    humanDecidedAt: timestamp("human_decided_at", { withTimezone: true }),
    patternTags: text("pattern_tags").array().default([]),
    synthesized: boolean("synthesized").notNull().default(false),
    synthesizedAt: timestamp("synthesized_at", { withTimezone: true }),
    // Added in migration 0047:
    approvalId: uuid("approval_id").references(() => approvals.id),
    attemptCount: integer("attempt_count").notNull().default(0),
    parentReviewId: uuid("parent_review_id").references(
      (): AnyPgColumn => workerReviewLog.id,
    ),
    payloadHash: text("payload_hash"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    managerStatusIdx: index("worker_review_log_manager_status_idx").on(
      table.managerAgentId,
      table.managerDecision,
    ),
    workerCreatedIdx: index("worker_review_log_worker_created_idx").on(
      table.workerAgentId,
      table.createdAt,
    ),
    statusCreatedIdx: index("worker_review_log_status_created_idx").on(
      table.managerDecision,
      table.createdAt,
    ),
    companyWorkerIdx: index("worker_review_log_company_worker_idx").on(
      table.companyId,
      table.workerAgentId,
      table.createdAt,
    ),
    notSynthesizedIdx: index("worker_review_log_not_synthesized_idx").on(
      table.companyId,
      table.synthesized,
    ),
  }),
);

export type WorkerReviewLog = typeof workerReviewLog.$inferSelect;
export type NewWorkerReviewLog = typeof workerReviewLog.$inferInsert;
