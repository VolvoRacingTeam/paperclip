import { pgTable, uuid, text, integer, timestamp, bigint, bigserial, unique, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentRunFailures = pgTable(
  "agent_run_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    workflow: text("workflow").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    dedupeWindowBucket: bigint("dedupe_window_bucket", { mode: "number" }).notNull(),
    errorSource: text("error_source").notNull(),
    errorClass: text("error_class").notNull(),
    errorCode: text("error_code"),
    httpStatus: integer("http_status"),
    targetRef: text("target_ref"),
    normalizedMessage: text("normalized_message").notNull(),
    errorFingerprint: text("error_fingerprint").notNull(),
    hitCount: integer("hit_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedupeUq: unique("agent_run_failures_agent_workflow_fingerprint_bucket_uq").on(
      table.agentId,
      table.workflow,
      table.errorFingerprint,
      table.dedupeWindowBucket,
    ),
    lookupIdx: index("agent_run_failures_lookup_idx").on(
      table.agentId,
      table.workflow,
      table.lastSeenAt,
    ),
  }),
);
