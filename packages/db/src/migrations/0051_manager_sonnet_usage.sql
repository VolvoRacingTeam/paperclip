-- Pakke D (SON-97): Sonnet-cost-tracking for manager-runs.
--
-- Tabell som logger hver claude-cli-run hvor manager-agent var aktiv
-- (claude_local-adapter med wakeReason som indikerer manager-aktivitet,
-- f.eks. manager_review_pending eller direct_approval). Brukes for:
--   1. real-time cost-pres per agent/company i siste 24t
--   2. timesvis aggregering til activity_log (manager_sonnet.hourly_usage)
--   3. alert-trigger naar > 500k tokens/dag per company
--
-- Idempotent: trygg aa kjore selv om tabell allerede eksisterer.

CREATE TABLE IF NOT EXISTS "manager_sonnet_usage" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"      uuid NOT NULL REFERENCES "companies"("id"),
  "agent_id"        uuid NOT NULL REFERENCES "agents"("id"),
  "run_id"          uuid,
  "reason"          text,
  "input_tokens"    integer,
  "output_tokens"   integer,
  "duration_ms"     integer,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "manager_sonnet_usage_company_created_idx"
  ON "manager_sonnet_usage" ("company_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "manager_sonnet_usage_agent_created_idx"
  ON "manager_sonnet_usage" ("agent_id", "created_at" DESC);
