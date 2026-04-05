/**
 * Paperclip ServerAdapterModule factory for the ollama_local adapter.
 *
 * Wires the framework-agnostic `executeOllamaLocal` primitives (client,
 * tool-loop, schema) into Paperclip's full adapter contract
 * (`AdapterExecutionContext` / `AdapterExecutionResult`).
 *
 * See ADR-001 for the dependency-injection rationale.
 */

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type OllamaLocalRuntimeConfig,
  buildLlamaCppClient,
} from "./execute.js";
import { runToolLoop, type ToolExecutor, type ToolLoopLogEvent, type ToolLoopResult } from "./tool-loop.js";
import type { ToolDefinition } from "./schema.js";
import type {
  PluginToolDispatcherLike,
  ToolDescriptorLike,
  ToolResultLike,
} from "./tool-dispatcher-contract.js";

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface CreateOllamaLocalServerAdapterOptions {
  /**
   * Paperclip's in-process plugin tool dispatcher. Injected by
   * `server/src/adapters/registry.ts` at server startup.
   */
  toolDispatcher: PluginToolDispatcherLike;
}

/**
 * Build a ServerAdapterModule for `ollama_local` that closes over the
 * given PluginToolDispatcher instance. Called once during server boot.
 */
export function createOllamaLocalServerAdapter(
  opts: CreateOllamaLocalServerAdapterOptions,
): ServerAdapterModule {
  return {
    type: "ollama_local",
    execute: (ctx) => executeAdapter(ctx, opts.toolDispatcher),
    testEnvironment: (ctx) => testEnvironment(ctx),
    supportsLocalAgentJwt: false,
    models: [
      { id: "gemma4-26b", label: "Gemma 4 26B-A4B (llama.cpp Q3_K_M)" },
    ],
    agentConfigurationDoc: agentConfigurationDocString,
  };
}

// ---------------------------------------------------------------------------
// execute(ctx)
// ---------------------------------------------------------------------------

/**
 * Main adapter entry point. Consumes Paperclip's AdapterExecutionContext,
 * runs the llama.cpp tool-loop, and returns an AdapterExecutionResult.
 */
export async function executeAdapter(
  ctx: AdapterExecutionContext,
  dispatcher: PluginToolDispatcherLike,
): Promise<AdapterExecutionResult> {
  const runtimeConfig = extractRuntimeConfig(ctx);
  const userMessage = extractUserMessage(ctx);
  const systemPrompt = extractSystemPrompt(ctx);

  if (!userMessage) {
    return failResult(
      ctx,
      "no_user_message",
      "Adapter received no user message; refusing to call the model.",
    );
  }

  // Discover plugin tools. The ollama_local adapter does NOT filter by
  // plugin — all tools the agent has access to are exposed to the model.
  const descriptors: ToolDescriptorLike[] = dispatcher.listToolsForAgent();
  const tools: ToolDefinition[] = descriptors.map((d) => ({
    name: d.name,
    description: d.description,
    parametersSchema: d.parametersSchema,
  }));

  // Build a ToolExecutor that routes every model tool-call through the
  // real dispatcher with the correct run context.
  const projectId = extractProjectId(ctx);
  const executeTool: ToolExecutor = async (name, args) => {
    const execution = await dispatcher.executeTool(name, args, {
      agentId: ctx.agent.id,
      runId: ctx.runId,
      companyId: ctx.agent.companyId,
      projectId,
    });
    return shapeToolResult(execution.result);
  };

  // Stream tool-loop events into Paperclip's log stream.
  const onLog = (event: ToolLoopLogEvent): void => {
    void ctx.onLog("stdout", formatLogEvent(event) + "\n");
  };

  // Build client + run the loop.
  const client = buildLlamaCppClient(runtimeConfig);
  let result: ToolLoopResult;
  try {
    result = await runToolLoop(client, {
      systemPrompt,
      userMessage,
      tools,
      executeTool,
      maxIterations: runtimeConfig.max_iterations ?? 10,
      maxTokens: runtimeConfig.max_tokens,
      temperature: runtimeConfig.temperature,
      onLog,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failResult(ctx, "tool_loop_error", message);
  }

  const toolCalls = result.steps.map((step, idx) => ({
    id: `step_${idx + 1}`,
    name: step.tool,
    input: step.args,
    output: step.result,
    isError: step.isError,
  }));

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: result.escalated?.reason ?? null,
    usage: {
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
    },
    sessionId: null,
    provider: "llama.cpp",
    biller: "local",
    model: runtimeConfig.model_name ?? DEFAULT_MODEL,
    billingType: "fixed",
    costUsd: 0,
    summary: result.finalAnswer.slice(0, 500),
    resultJson: {
      finalAnswer: result.finalAnswer,
      iterations: result.usage.iterations,
      steps: toolCalls,
      escalated: result.escalated ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// testEnvironment(ctx) — GET /v1/models
// ---------------------------------------------------------------------------

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const runtimeConfig = (ctx.config ?? {}) as OllamaLocalRuntimeConfig;
  const baseUrl = runtimeConfig.base_url ?? DEFAULT_BASE_URL;
  const modelName = runtimeConfig.model_name ?? DEFAULT_MODEL;
  const checks: AdapterEnvironmentCheck[] = [];

  const modelsUrl = baseUrl.replace(/\/$/, "") + "/models";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(modelsUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      checks.push({
        code: "endpoint_unhealthy",
        level: "error",
        message: `llama.cpp /v1/models returned HTTP ${res.status}`,
        detail: `GET ${modelsUrl}`,
        hint: "Start the llamacpp-gemma4 container and retry.",
      });
      return buildResult(checks, "fail");
    }
    const body = (await res.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ name?: string }>;
    };
    const ids = [
      ...(body.data ?? []).map((m) => m.id).filter((x): x is string => !!x),
      ...(body.models ?? []).map((m) => m.name).filter((x): x is string => !!x),
    ];
    if (!ids.includes(modelName)) {
      checks.push({
        code: "model_missing",
        level: "error",
        message: `Model "${modelName}" not found at ${baseUrl}`,
        detail: `Available: ${ids.join(", ") || "(none)"}`,
        hint: `Load the GGUF into llama.cpp or set runtime_config.model_name to one of: ${ids.join(", ")}`,
      });
      return buildResult(checks, "fail");
    }
    checks.push({
      code: "endpoint_ok",
      level: "info",
      message: `llama.cpp reachable at ${baseUrl}, model "${modelName}" available.`,
      detail: null,
      hint: null,
    });
    return buildResult(checks, "pass");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "endpoint_unreachable",
      level: "error",
      message: `Cannot reach llama.cpp at ${modelsUrl}`,
      detail: message,
      hint: "Check runtime_config.base_url, container health, and docker network.",
    });
    return buildResult(checks, "fail");
  }
}

function buildResult(
  checks: AdapterEnvironmentCheck[],
  status: "pass" | "warn" | "fail",
): AdapterEnvironmentTestResult {
  return {
    adapterType: "ollama_local",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractRuntimeConfig(ctx: AdapterExecutionContext): OllamaLocalRuntimeConfig {
  const raw = (ctx.config ?? {}) as Record<string, unknown>;
  return {
    ai_backend: typeof raw.ai_backend === "string" ? raw.ai_backend : "ollama_local",
    model_name: typeof raw.model_name === "string" ? raw.model_name : undefined,
    base_url: typeof raw.base_url === "string" ? raw.base_url : undefined,
    max_tokens: typeof raw.max_tokens === "number" ? raw.max_tokens : undefined,
    temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
    timeout_ms: typeof raw.timeout_ms === "number" ? raw.timeout_ms : undefined,
    max_iterations: typeof raw.max_iterations === "number" ? raw.max_iterations : undefined,
    api_key: typeof raw.api_key === "string" ? raw.api_key : undefined,
  };
}

function extractUserMessage(ctx: AdapterExecutionContext): string {
  const c = (ctx.context ?? {}) as Record<string, unknown>;
  // Try common field names in order. Paperclip's runner may populate any
  // of these depending on how the agent was invoked.
  for (const key of ["prompt", "userMessage", "input", "message", "text"]) {
    const v = c[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  // Fallback: stringify the whole context object (debugging aid).
  try {
    return JSON.stringify(c);
  } catch {
    return "";
  }
}

function extractSystemPrompt(ctx: AdapterExecutionContext): string | undefined {
  const c = (ctx.context ?? {}) as Record<string, unknown>;
  const sys = c.systemPrompt ?? c.system ?? c.instructions;
  return typeof sys === "string" && sys.length > 0 ? sys : undefined;
}

function extractProjectId(ctx: AdapterExecutionContext): string {
  const c = (ctx.context ?? {}) as Record<string, unknown>;
  if (typeof c.projectId === "string") return c.projectId;
  // Fallback: use companyId as projectId scope. Plugin tool handlers
  // that actually need a real projectId will fail loudly, which is
  // the correct behavior for shadow-testing — we'll learn which tools
  // care about projectId and populate it properly in a follow-up.
  return ctx.agent.companyId;
}

function shapeToolResult(result: ToolResultLike): unknown {
  if (result.error) {
    return { error: result.error };
  }
  if (result.data !== undefined) return result.data;
  if (result.content !== undefined) return result.content;
  return null;
}

function formatLogEvent(event: ToolLoopLogEvent): string {
  switch (event.type) {
    case "model_call":
      return `[ollama_local] iter=${event.iteration} model_call: ${event.promptPreview.slice(0, 200)}`;
    case "model_response":
      return `[ollama_local] iter=${event.iteration} model_response: ${event.raw.slice(0, 500)}`;
    case "tool_call":
      return `[ollama_local] iter=${event.iteration} tool_call ${event.tool} args=${safeJson(event.args)}`;
    case "tool_result":
      return `[ollama_local] iter=${event.iteration} tool_result ${event.tool} result=${safeJson(event.result)}`;
    default: {
      const e = event as { type: string };
      return `[ollama_local] event=${e.type}`;
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 400);
  } catch {
    return String(v);
  }
}

function failResult(
  ctx: AdapterExecutionContext,
  code: string,
  message: string,
): AdapterExecutionResult {
  void ctx.onLog("stderr", `[ollama_local] ${code}: ${message}\n`);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: message,
    errorCode: code,
    provider: "llama.cpp",
    biller: "local",
    summary: null,
  };
}

// ---------------------------------------------------------------------------
// Agent configuration doc (pasted from src/index.ts for single-point export)
// ---------------------------------------------------------------------------

const agentConfigurationDocString = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to drive a local llama.cpp server directly (no CLI spawn)
- You need grammar-constrained JSON tool-calling on norsk input
- You want to run Gemma / Qwen / Llama models locally without the Ollama
  tool-parser bug (#15315) biting on norske tegn, apostrofer eller paths

runtime_config fields:
- ai_backend: "ollama_local" (required)
- model_name: e.g. "gemma4-26b" (required)
- base_url: e.g. "http://llamacpp-gemma4:11435/v1" (required)
- max_tokens: integer, default 2048 (MUST be >= 1500 for reasoning mode)
- temperature: default 0.3
- timeout_ms: default 120000
- max_iterations: default 10
- api_key: optional bearer token

Notes:
- Adapter owns the tool loop and dispatches via PluginToolDispatcher.
- Responses are JSON.parse'd under grammar-constrained sampling.
- A synthetic "final_answer" tool terminates the loop.
`;
