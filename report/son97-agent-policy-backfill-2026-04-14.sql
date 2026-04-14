CREATE SCHEMA IF NOT EXISTS _son97_rollback;

DROP TABLE IF EXISTS _son97_rollback.agents_adapter_config_20260414;
CREATE TABLE _son97_rollback.agents_adapter_config_20260414 AS
SELECT id, name, adapter_type, adapter_config, updated_at
FROM agents;

DROP TABLE IF EXISTS _son97_rollback.agent_budget_policies_20260414;
CREATE TABLE _son97_rollback.agent_budget_policies_20260414 AS
SELECT *
FROM agent_budget_policies;

INSERT INTO agent_budget_policies (
  agent_id,
  workflow_name,
  primary_provider,
  primary_model,
  fallback_provider,
  fallback_model,
  max_tokens_per_run,
  daily_budget_tokens,
  timezone,
  enabled,
  updated_at
)
VALUES
  ('a970a167-e207-4c4b-a3c9-5a37fec776fe', '*', 'claude_local', 'claude-sonnet-4-6', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 200000, 1000000, 'Europe/Oslo', true, now()),
  ('d52640a6-89c7-4be2-8cc9-e3908f9954c1', '*', 'claude_local', 'claude-haiku-4-5', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 50000, 300000, 'Europe/Oslo', true, now()),
  ('f9240773-ea26-4c4f-b902-f99298e3be91', '*', 'claude_local', 'claude-sonnet-4-6', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 200000, 250000, 'Europe/Oslo', true, now()),
  ('4888134e-c013-4e46-aae9-816a5115425c', '*', 'claude_local', 'claude-haiku-4-5', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 50000, 250000, 'Europe/Oslo', true, now()),
  ('0fcc0c98-e7fa-43b8-8b3d-d6d1a23bed6a', '*', 'claude_local', 'claude-haiku-4-5', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 50000, 250000, 'Europe/Oslo', true, now()),
  ('e1a29f34-3747-4b3b-9813-e8909fa6c21f', '*', 'claude_local', 'claude-haiku-4-5', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 50000, 100000, 'Europe/Oslo', true, now()),
  ('cc4b8e82-1fdc-4ffc-b8f1-3822ac09e949', '*', 'claude_local', 'claude-haiku-4-5', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 50000, 100000, 'Europe/Oslo', true, now()),
  ('3c4b1f09-bee5-48f0-8e1b-04dee07f8a45', '*', 'claude_local', 'claude-haiku-4-5', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 50000, 100000, 'Europe/Oslo', true, now()),
  ('678cad5a-c7ae-4955-8287-dfaad76bc763', '*', 'claude_local', 'claude-sonnet-4-6', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 200000, 300000, 'Europe/Oslo', true, now()),
  ('54afe0d1-807c-4bca-b288-fa348463bcdb', '*', 'claude_local', 'claude-sonnet-4-6', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 200000, 300000, 'Europe/Oslo', true, now()),
  ('31a2760f-7385-42b9-b755-7375703cca35', '*', 'claude_local', 'claude-haiku-4-5', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 50000, 75000, 'Europe/Oslo', true, now()),
  ('93979a8d-4637-4fbe-98d2-60dca0eb26a6', '*', 'claude_local', 'claude-haiku-4-5', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 50000, 75000, 'Europe/Oslo', true, now()),
  ('7328c7b6-b2ec-482e-8610-2e944db1e0d8', '*', 'claude_local', 'claude-sonnet-4-6', 'ollama_local', 'gemma-4-26b-a4b-q3_k_m-llamacpp', 200000, 200000, 'Europe/Oslo', true, now())
ON CONFLICT (agent_id) DO UPDATE
SET
  workflow_name = excluded.workflow_name,
  primary_provider = excluded.primary_provider,
  primary_model = excluded.primary_model,
  fallback_provider = excluded.fallback_provider,
  fallback_model = excluded.fallback_model,
  max_tokens_per_run = excluded.max_tokens_per_run,
  daily_budget_tokens = excluded.daily_budget_tokens,
  timezone = excluded.timezone,
  enabled = excluded.enabled,
  updated_at = now();

UPDATE agents
SET
  adapter_config = adapter_config || jsonb_build_object(
    'primary_provider', 'claude_local',
    'primary_model', 'claude-sonnet-4-6',
    'primary_runtime_model', 'claude-sonnet-4-6',
    'fallback_provider', 'ollama_local',
    'fallback_model', 'gemma-4-26b-a4b-q3_k_m-llamacpp',
    'fallback_runtime_model', 'gemma4-26b',
    'fallback_base_url', 'http://llamacpp-gemma4:8080/v1',
    'max_tokens_per_run', 200000,
    'daily_budget_tokens', 1000000,
    'budget_timezone', 'Europe/Oslo',
    'workflow_token_overrides', jsonb_build_object('WF-7', 500000)
  ),
  updated_at = now()
WHERE id = 'a970a167-e207-4c4b-a3c9-5a37fec776fe';

UPDATE agents
SET
  adapter_config = adapter_config || jsonb_build_object(
    'primary_provider', 'claude_local',
    'primary_model', 'claude-haiku-4-5',
    'primary_runtime_model', 'claude-haiku-4-5-20251001',
    'fallback_provider', 'ollama_local',
    'fallback_model', 'gemma-4-26b-a4b-q3_k_m-llamacpp',
    'fallback_runtime_model', 'gemma4-26b',
    'fallback_base_url', 'http://llamacpp-gemma4:8080/v1',
    'max_tokens_per_run', 50000,
    'daily_budget_tokens', 300000,
    'budget_timezone', 'Europe/Oslo'
  ),
  updated_at = now()
WHERE id = 'd52640a6-89c7-4be2-8cc9-e3908f9954c1';

UPDATE agents
SET
  adapter_config = adapter_config || jsonb_build_object(
    'primary_provider', 'claude_local',
    'primary_model', 'claude-sonnet-4-6',
    'primary_runtime_model', 'claude-sonnet-4-6',
    'fallback_provider', 'ollama_local',
    'fallback_model', 'gemma-4-26b-a4b-q3_k_m-llamacpp',
    'fallback_runtime_model', 'gemma4-26b',
    'fallback_base_url', 'http://llamacpp-gemma4:8080/v1',
    'max_tokens_per_run', 200000,
    'daily_budget_tokens', 250000,
    'budget_timezone', 'Europe/Oslo'
  ),
  updated_at = now()
WHERE id = 'f9240773-ea26-4c4f-b902-f99298e3be91';

UPDATE agents
SET
  adapter_config = adapter_config || jsonb_build_object(
    'primary_provider', 'claude_local',
    'primary_model', 'claude-haiku-4-5',
    'primary_runtime_model', 'claude-haiku-4-5-20251001',
    'fallback_provider', 'ollama_local',
    'fallback_model', 'gemma-4-26b-a4b-q3_k_m-llamacpp',
    'fallback_runtime_model', 'gemma4-26b',
    'fallback_base_url', 'http://llamacpp-gemma4:8080/v1',
    'max_tokens_per_run', 50000,
    'daily_budget_tokens', 250000,
    'budget_timezone', 'Europe/Oslo'
  ),
  updated_at = now()
WHERE id IN (
  '4888134e-c013-4e46-aae9-816a5115425c',
  '0fcc0c98-e7fa-43b8-8b3d-d6d1a23bed6a'
);

UPDATE agents
SET
  adapter_config = adapter_config || jsonb_build_object(
    'primary_provider', 'claude_local',
    'primary_model', 'claude-haiku-4-5',
    'primary_runtime_model', 'claude-haiku-4-5-20251001',
    'fallback_provider', 'ollama_local',
    'fallback_model', 'gemma-4-26b-a4b-q3_k_m-llamacpp',
    'fallback_runtime_model', 'gemma4-26b',
    'fallback_base_url', 'http://llamacpp-gemma4:8080/v1',
    'max_tokens_per_run', 50000,
    'daily_budget_tokens', 100000,
    'budget_timezone', 'Europe/Oslo'
  ),
  updated_at = now()
WHERE id IN (
  'e1a29f34-3747-4b3b-9813-e8909fa6c21f',
  'cc4b8e82-1fdc-4ffc-b8f1-3822ac09e949',
  '3c4b1f09-bee5-48f0-8e1b-04dee07f8a45'
);

UPDATE agents
SET
  adapter_config = adapter_config || jsonb_build_object(
    'primary_provider', 'claude_local',
    'primary_model', 'claude-sonnet-4-6',
    'primary_runtime_model', 'claude-sonnet-4-6',
    'fallback_provider', 'ollama_local',
    'fallback_model', 'gemma-4-26b-a4b-q3_k_m-llamacpp',
    'fallback_runtime_model', 'gemma4-26b',
    'fallback_base_url', 'http://llamacpp-gemma4:8080/v1',
    'max_tokens_per_run', 200000,
    'daily_budget_tokens', 300000,
    'budget_timezone', 'Europe/Oslo'
  ),
  updated_at = now()
WHERE id IN (
  '678cad5a-c7ae-4955-8287-dfaad76bc763',
  '54afe0d1-807c-4bca-b288-fa348463bcdb'
);

UPDATE agents
SET
  adapter_config = adapter_config || jsonb_build_object(
    'primary_provider', 'claude_local',
    'primary_model', 'claude-haiku-4-5',
    'primary_runtime_model', 'claude-haiku-4-5-20251001',
    'fallback_provider', 'ollama_local',
    'fallback_model', 'gemma-4-26b-a4b-q3_k_m-llamacpp',
    'fallback_runtime_model', 'gemma4-26b',
    'fallback_base_url', 'http://llamacpp-gemma4:8080/v1',
    'max_tokens_per_run', 50000,
    'daily_budget_tokens', 75000,
    'budget_timezone', 'Europe/Oslo'
  ),
  updated_at = now()
WHERE id IN (
  '31a2760f-7385-42b9-b755-7375703cca35',
  '93979a8d-4637-4fbe-98d2-60dca0eb26a6'
);

UPDATE agents
SET
  adapter_config = adapter_config || jsonb_build_object(
    'primary_provider', 'claude_local',
    'primary_model', 'claude-sonnet-4-6',
    'primary_runtime_model', 'claude-sonnet-4-6',
    'fallback_provider', 'ollama_local',
    'fallback_model', 'gemma-4-26b-a4b-q3_k_m-llamacpp',
    'fallback_runtime_model', 'gemma4-26b',
    'fallback_base_url', 'http://llamacpp-gemma4:8080/v1',
    'max_tokens_per_run', 200000,
    'daily_budget_tokens', 200000,
    'budget_timezone', 'Europe/Oslo'
  ),
  updated_at = now()
WHERE id = '7328c7b6-b2ec-482e-8610-2e944db1e0d8';
