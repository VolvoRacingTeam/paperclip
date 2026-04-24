-- SON-97 QA-fixrunde Fix 5 (PENDING_RETRY) -- 2026-04-25
--
-- Utvider manager_decision-CHECK med PENDING_RETRY slik at
-- queueWorkerRetry kan sette raden i en ikke-PENDING-mellomtilstand
-- mens worker varsles. Sweep-jobben behandler kun PENDING og
-- skipper dermed PENDING_RETRY-rader (worker-retry-koe).
--
-- Idempotent (DROP CONSTRAINT IF EXISTS).

ALTER TABLE "worker_review_log"
  DROP CONSTRAINT IF EXISTS "worker_review_log_manager_decision_check";
--> statement-breakpoint
ALTER TABLE "worker_review_log"
  ADD CONSTRAINT "worker_review_log_manager_decision_check"
  CHECK (manager_decision = ANY (ARRAY[
    'GODKJENT'::text,
    'AVVIST'::text,
    'ESKALERT'::text,
    'PENDING'::text,
    'PENDING_RETRY'::text
  ]));
