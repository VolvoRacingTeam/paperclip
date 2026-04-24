-- Worker-learning Tier 1 prompt injection (SON-97 pakke 8b) -- 2026-04-24
--
-- Legger til archived_at-kolonne paa worker_learning_patterns saa manageren
-- eller mennesker kan markere patterns som utdaterte uten aa slette dem.
-- Injection-query-en i worker-learning-injection.ts respekterer denne
-- kolonnen naar den settes.
--
-- Idempotent (IF NOT EXISTS) slik at migrationen kan kjoeres trygt selv om
-- kolonnen allerede finnes.

ALTER TABLE "worker_learning_patterns"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "worker_learning_patterns_active_idx"
  ON "worker_learning_patterns" ("worker_agent_id", "last_seen_at")
  WHERE "archived_at" IS NULL;
