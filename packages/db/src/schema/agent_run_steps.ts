import { pgTable, uuid, text, integer, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

/**
 * Per-step idempotency-state for Fikenverktoy MCP wrapper-laget.
 *
 * Composite PK (agent_id, run_id, step_index) — replay av samme (runId, stepIndex)
 * returnerer samme idempotency_key. Feilstilte runs har TTL via expires_at og
 * vacuum-cron rydder daglig 03:00 UTC.
 *
 * Bevisst SEPARAT fra agent_runtime_state (per-agent metering + state_json).
 * agent_run_steps holder per-step replay-data; agent_runtime_state.state_json
 * holder per-agent kontekst som fiken_company_slug.
 */
export const agentRunSteps = pgTable(
  "agent_run_steps",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    runId: text("run_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.runId, table.stepIndex] }),
    expiresAtIdx: index("agent_run_steps_expires_at_idx").on(table.expiresAt),
  }),
);

export type AgentRunStepsRow = typeof agentRunSteps.$inferSelect;
export type NewAgentRunStepsRow = typeof agentRunSteps.$inferInsert;
