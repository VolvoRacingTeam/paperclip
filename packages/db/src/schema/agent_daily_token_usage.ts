import { pgTable, uuid, text, integer, timestamp, date, primaryKey } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentDailyTokenUsage = pgTable(
  "agent_daily_token_usage",
  {
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    usageDate: date("usage_date").notNull(),
    provider: text("provider").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    lastRunId: uuid("last_run_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.agentId, table.usageDate, table.provider],
      name: "agent_daily_token_usage_pk",
    }),
  }),
);
