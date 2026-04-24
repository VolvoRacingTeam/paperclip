-- SON-97 QA-fixrunde Fix 11 (severity som egen kolonne) -- 2026-04-25
--
-- Legg til severity-kolonne paa worker_learning_patterns med CHECK i
-- ('info','warning','critical') og default 'info'. Backfiller fra
-- legacy [severity=X]-prefiks i pattern_description hvis det finnes.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS).

ALTER TABLE "worker_learning_patterns"
  ADD COLUMN IF NOT EXISTS "severity" text NOT NULL DEFAULT 'info';
--> statement-breakpoint

ALTER TABLE "worker_learning_patterns"
  DROP CONSTRAINT IF EXISTS "worker_learning_patterns_severity_check";
--> statement-breakpoint
ALTER TABLE "worker_learning_patterns"
  ADD CONSTRAINT "worker_learning_patterns_severity_check"
  CHECK (severity IN ('info', 'warning', 'critical'));
--> statement-breakpoint

-- Backfill: parse [severity=X]-prefiks i pattern_description hvis det
-- finnes. Vi rorer ikke patterns som mangler markor (de beholder
-- default 'info').
UPDATE "worker_learning_patterns"
SET "severity" = (
  CASE
    WHEN pattern_description LIKE '[severity=critical]%' THEN 'critical'
    WHEN pattern_description LIKE '[severity=warning]%'  THEN 'warning'
    WHEN pattern_description LIKE '[severity=info]%'     THEN 'info'
    ELSE severity
  END
)
WHERE pattern_description ~ '^\[severity=(info|warning|critical)\]';
--> statement-breakpoint

-- Indeks for injection-query: filtrer paa severity i WHERE/ORDER BY
CREATE INDEX IF NOT EXISTS "worker_learning_patterns_worker_sev_idx"
  ON "worker_learning_patterns" ("worker_agent_id", "severity", "last_seen_at")
  WHERE "archived_at" IS NULL;
