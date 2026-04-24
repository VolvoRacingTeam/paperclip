import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * manager_sonnet_usage - Pakke D (SON-97).
 *
 * En rad per claude_local-run hvor agenten oppfattes som manager
 * (wakeReason = manager_review_pending, manager_review,
 * direct_approval, ...). Driver real-time cost-tracking, timesvis
 * aggregering til activity_log og daglig alert-grense paa 500k tokens
 * per company.
 */
export const managerSonnetUsage = pgTable(
  "manager_sonnet_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    runId: uuid("run_id"),
    reason: text("reason"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("manager_sonnet_usage_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    agentCreatedIdx: index("manager_sonnet_usage_agent_created_idx").on(
      table.agentId,
      table.createdAt,
    ),
  }),
);

export type ManagerSonnetUsage = typeof managerSonnetUsage.$inferSelect;
export type NewManagerSonnetUsage = typeof managerSonnetUsage.$inferInsert;
