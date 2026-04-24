import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Patterns syntetisert fra `worker_review_log` av manager-agenter.
 * Brukes senere til Tier 1 prompt-injection og Tier 2 AGENTS.md-oppdatering.
 *
 * Tabellen ble opprettet i database 2026-04-24 (utenfor Drizzle).
 */
export const workerLearningPatterns = pgTable(
  "worker_learning_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    workerAgentId: uuid("worker_agent_id")
      .notNull()
      .references(() => agents.id),
    patternTag: text("pattern_tag").notNull(),
    patternDescription: text("pattern_description").notNull(),
    exampleCorrect: jsonb("example_correct").$type<Record<string, unknown>>(),
    exampleWrong: jsonb("example_wrong").$type<Record<string, unknown>>(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    injectedToPrompt: boolean("injected_to_prompt").notNull().default(false),
    injectedAt: timestamp("injected_at", { withTimezone: true }),
    ruleInAgentsMd: boolean("rule_in_agents_md").notNull().default(false),
    knowledgeBaseEntryId: uuid("knowledge_base_entry_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workerPatternTagUq: uniqueIndex(
      "worker_learning_patterns_worker_agent_id_pattern_tag_key",
    ).on(table.workerAgentId, table.patternTag),
    workerIdx: index("worker_learning_patterns_worker_idx").on(
      table.workerAgentId,
      table.lastSeenAt,
    ),
  }),
);

export type WorkerLearningPattern = typeof workerLearningPatterns.$inferSelect;
export type NewWorkerLearningPattern = typeof workerLearningPatterns.$inferInsert;
