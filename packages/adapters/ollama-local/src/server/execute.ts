/**
 * Entry-point for the ollama-local adapter.
 *
 * This is the function Paperclip's agent-runner will call once the
 * adapter is wired into the runtime registry. For now it exposes a
 * plain, framework-agnostic signature that can be adapted to the
 * full `AdapterExecutionContext` shape in a follow-up commit.
 */

import { LlamaCppClient, type LlamaCppClientOptions } from "./client.js";
import {
  runToolLoop,
  type ToolExecutor,
  type ToolLoopLogEvent,
  type ToolLoopResult,
} from "./tool-loop.js";
import type { ToolDefinition } from "./schema.js";

export interface OllamaLocalRuntimeConfig {
  ai_backend?: string;
  model_name?: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
  timeout_ms?: number;
  max_iterations?: number;
  api_key?: string;
  default_prompt?: string;
}

export interface ExecuteOllamaLocalOptions {
  runtimeConfig: OllamaLocalRuntimeConfig;
  systemPrompt?: string;
  userMessage: string;
  tools: ToolDefinition[];
  executeTool: ToolExecutor;
  onLog?: (event: ToolLoopLogEvent) => void;
}

export const DEFAULT_BASE_URL = "http://192.168.68.82:11435/v1";
export const DEFAULT_MODEL = "gemma4-26b";

export function buildLlamaCppClient(
  cfg: OllamaLocalRuntimeConfig,
): LlamaCppClient {
  const opts: LlamaCppClientOptions = {
    baseUrl: cfg.base_url ?? DEFAULT_BASE_URL,
    model: cfg.model_name ?? DEFAULT_MODEL,
    maxTokens: cfg.max_tokens ?? 2048,
    temperature: cfg.temperature ?? 0.3,
    timeoutMs: cfg.timeout_ms ?? 120_000,
    apiKey: cfg.api_key,
  };
  return new LlamaCppClient(opts);
}

export async function executeOllamaLocal(
  options: ExecuteOllamaLocalOptions,
): Promise<ToolLoopResult> {
  const client = buildLlamaCppClient(options.runtimeConfig);
  return runToolLoop(client, {
    systemPrompt: options.systemPrompt,
    userMessage: options.userMessage,
    tools: options.tools,
    executeTool: options.executeTool,
    maxIterations: options.runtimeConfig.max_iterations ?? 10,
    maxTokens: options.runtimeConfig.max_tokens,
    temperature: options.runtimeConfig.temperature,
    onLog: options.onLog,
  });
}
