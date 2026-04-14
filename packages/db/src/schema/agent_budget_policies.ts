import { pgTable, uuid, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentBudgetPolicies = pgTable(
  "agent_budget_policies",
  {
    agentId: uuid("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
    workflowName: text("workflow_name").notNull().default("*"),
    primaryProvider: text("primary_provider").notNull(),
    primaryModel: text("primary_model").notNull(),
    fallbackProvider: text("fallback_provider").notNull(),
    fallbackModel: text("fallback_model").notNull(),
    maxTokensPerRun: integer("max_tokens_per_run").notNull(),
    dailyBudgetTokens: integer("daily_budget_tokens").notNull(),
    timezone: text("timezone").notNull().default("Europe/Oslo"),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
