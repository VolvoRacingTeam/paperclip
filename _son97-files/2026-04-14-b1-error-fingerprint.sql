BEGIN;

INSERT INTO _son97_rollback (reason, source_table, data)
SELECT
  'b1_error_fingerprint_prechange_2026-04-14',
  'paperclip_schema',
  jsonb_build_object(
    'captured_at', now(),
    'tables', jsonb_build_object(
      'agent_budget_policies', EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'agent_budget_policies'
      ),
      'agent_daily_token_usage', EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'agent_daily_token_usage'
      ),
      'agent_run_failures', EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'agent_run_failures'
      )
    ),
    'agent_run_failures_columns', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'column_name', column_name,
          'data_type', data_type,
          'ordinal_position', ordinal_position
        )
        ORDER BY ordinal_position
      )
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_run_failures'
    ), '[]'::jsonb)
  )
WHERE NOT EXISTS (
  SELECT 1
  FROM _son97_rollback
  WHERE reason = 'b1_error_fingerprint_prechange_2026-04-14'
    AND source_table = 'paperclip_schema'
);

CREATE TABLE IF NOT EXISTS agent_budget_policies (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  workflow_name text NOT NULL DEFAULT '*',
  primary_provider text NOT NULL,
  primary_model text NOT NULL,
  fallback_provider text NOT NULL,
  fallback_model text NOT NULL,
  max_tokens_per_run integer NOT NULL,
  daily_budget_tokens integer NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Oslo',
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_daily_token_usage (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  provider text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  last_run_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, usage_date, provider)
);

CREATE TABLE IF NOT EXISTS agent_run_failures (
  id bigserial PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workflow text NOT NULL,
  window_seconds integer NOT NULL,
  dedupe_window_bucket bigint NOT NULL,
  error_source text NOT NULL,
  error_class text NOT NULL,
  error_code text,
  http_status integer,
  target_ref text,
  normalized_message text NOT NULL,
  error_fingerprint text NOT NULL,
  hit_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, workflow, error_fingerprint, dedupe_window_bucket)
);

CREATE INDEX IF NOT EXISTS agent_run_failures_lookup_idx
  ON agent_run_failures (agent_id, workflow, last_seen_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agents WHERE id = '678cad5a-c7ae-4955-8287-dfaad76bc763'
  ) AND NOT EXISTS (
    SELECT 1 FROM agent_run_failures WHERE target_ref = 'seed:b1_error_fingerprint_demo'
  ) THEN
    INSERT INTO agent_run_failures (
      agent_id,
      workflow,
      window_seconds,
      dedupe_window_bucket,
      error_source,
      error_class,
      error_code,
      http_status,
      target_ref,
      normalized_message,
      error_fingerprint,
      hit_count,
      first_seen_at,
      last_seen_at
    ) VALUES (
      '678cad5a-c7ae-4955-8287-dfaad76bc763',
      'WF-6',
      900,
      202604141900,
      'provider',
      'rate_limit_error',
      'anthropic_rate_limit_error',
      429,
      'seed:b1_error_fingerprint_demo',
      'HTTP 429 from Claude on /messages',
      '678cad5a-c7ae-4955-8287-dfaad76bc763:WF-6:http_429_claude_messages',
      1,
      now(),
      now()
    );

    INSERT INTO agent_run_failures (
      agent_id,
      workflow,
      window_seconds,
      dedupe_window_bucket,
      error_source,
      error_class,
      error_code,
      http_status,
      target_ref,
      normalized_message,
      error_fingerprint,
      hit_count,
      first_seen_at,
      last_seen_at
    ) VALUES (
      '678cad5a-c7ae-4955-8287-dfaad76bc763',
      'WF-6',
      900,
      202604141900,
      'provider',
      'rate_limit_error',
      'anthropic_rate_limit_error',
      429,
      'seed:b1_error_fingerprint_demo',
      'HTTP 429 from Claude on /messages',
      '678cad5a-c7ae-4955-8287-dfaad76bc763:WF-6:http_429_claude_messages',
      1,
      now(),
      now()
    )
    ON CONFLICT (agent_id, workflow, error_fingerprint, dedupe_window_bucket)
    DO UPDATE SET
      window_seconds = EXCLUDED.window_seconds,
      error_source = EXCLUDED.error_source,
      error_class = EXCLUDED.error_class,
      error_code = EXCLUDED.error_code,
      http_status = EXCLUDED.http_status,
      target_ref = EXCLUDED.target_ref,
      normalized_message = EXCLUDED.normalized_message,
      hit_count = agent_run_failures.hit_count + 1,
      last_seen_at = EXCLUDED.last_seen_at;
  END IF;
END $$;

COMMIT;
