-- Manager Review Hook (SON-97/worker-review-hook) -- 2026-04-24
--
-- Legger til kolonner og indekser paa eksisterende worker_review_log-tabell.
-- Tabellene worker_review_log + worker_learning_patterns ble laget manuelt
-- i produksjons-DB 2026-04-24; denne migrationen bringer dem i synk med
-- Drizzle-skjemaet.
--
-- Alle endringer er idempotente (IF NOT EXISTS) slik at migrationen kan
-- kjoeres trygt selv om deler av strukturen allerede finnes.

-- Approval-link + retry-chain + dup-hash + idempotency
ALTER TABLE "worker_review_log"
  ADD COLUMN IF NOT EXISTS "approval_id" uuid;
--> statement-breakpoint
ALTER TABLE "worker_review_log"
  ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "worker_review_log"
  ADD COLUMN IF NOT EXISTS "parent_review_id" uuid;
--> statement-breakpoint
ALTER TABLE "worker_review_log"
  ADD COLUMN IF NOT EXISTS "payload_hash" text;
--> statement-breakpoint
ALTER TABLE "worker_review_log"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint

-- FK-er (DO-block for aa hoppe over hvis de finnes)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_review_log_approval_id_fkey'
  ) THEN
    ALTER TABLE "worker_review_log"
      ADD CONSTRAINT "worker_review_log_approval_id_fkey"
      FOREIGN KEY ("approval_id") REFERENCES "approvals"("id");
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'worker_review_log_parent_review_id_fkey'
  ) THEN
    ALTER TABLE "worker_review_log"
      ADD CONSTRAINT "worker_review_log_parent_review_id_fkey"
      FOREIGN KEY ("parent_review_id") REFERENCES "worker_review_log"("id");
  END IF;
END $$;
--> statement-breakpoint

-- Indekser for review-koe-queries
CREATE INDEX IF NOT EXISTS "worker_review_log_manager_status_idx"
  ON "worker_review_log" ("manager_agent_id", "manager_decision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_review_log_worker_created_idx"
  ON "worker_review_log" ("worker_agent_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_review_log_status_created_idx"
  ON "worker_review_log" ("manager_decision", "created_at");
--> statement-breakpoint

-- Dup-hash lookups: (worker_agent_id, payload_hash)
CREATE INDEX IF NOT EXISTS "worker_review_log_dup_hash_idx"
  ON "worker_review_log" ("worker_agent_id", "payload_hash")
  WHERE "payload_hash" IS NOT NULL;
