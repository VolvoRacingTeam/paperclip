-- M2.4-prereq: per-step idempotency-state for Fikenverktoy MCP wrapper-laget.
--
-- Bevisst SEPARAT fra agent_runtime_state (eksisterende per-agent metering +
-- state_json, PK = agent_id alene). agent_run_steps holder replay-data per
-- (agent_id, run_id, step_index) med 72t TTL og vacuum-cron 03:00 UTC.
--
-- Idempotent: trygg aa kjore selv om tabell allerede eksisterer.

CREATE TABLE IF NOT EXISTS "agent_run_steps" (
  "agent_id"        uuid NOT NULL REFERENCES "agents"("id"),
  "run_id"          text NOT NULL,
  "step_index"      integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "payload_hash"    text NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"      timestamp with time zone NOT NULL,
  PRIMARY KEY ("agent_id", "run_id", "step_index")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_run_steps_expires_at_idx"
  ON "agent_run_steps" ("expires_at");
