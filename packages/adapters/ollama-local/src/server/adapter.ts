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
import {
  KUNDEOVERSIKT_TOOL_DEFINITIONS,
  executeKundeoversiktTool,
  isKundeoversiktTool,
} from "./kundeoversikt-tools.js";
import {
  FIKEN_TOOL_DEFINITIONS,
  executeFikenTool,
  isFikenTool,
} from "./fiken-tools.js";
import {
  buildFikenMcpToolExecutor,
  isFikenMcpTool,
  resolveEnabledFikenMcpTools,
  type FikenMcpExecutorContext,
} from "./fiken-mcp-tools.js";
import { getOrInitFikenMcpClient } from "./fiken-mcp-bootstrap.js";
import { ulid } from "./fiken-mcp/index.js";

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
  let userMessage = extractUserMessage(ctx);
  const systemPrompt = extractSystemPrompt(ctx);

  // For heartbeat runs, Paperclip doesn't inject a user message.
  // Fall back to default_prompt from adapter_config.
  if (!userMessage) {
    const defaultPrompt = typeof runtimeConfig.default_prompt === "string"
      ? runtimeConfig.default_prompt
      : undefined;
    if (defaultPrompt) {
      userMessage = defaultPrompt;
    } else {
      return failResult(
        ctx,
        "no_user_message",
        "Adapter received no user message and no default_prompt in adapter_config.",
      );
    }
  }

  // Discover plugin tools + inject Kundeoversikt built-in tools.
  const descriptors: ToolDescriptorLike[] = dispatcher.listToolsForAgent();
  const pluginTools: ToolDefinition[] = descriptors.map((d) => ({
    name: d.name,
    description: d.description,
    parametersSchema: d.parametersSchema,
  }));
  // Kundeoversikt built-in tools (email pipeline — see kundeoversikt-tools.ts)
  // Fikenverktøy MCP wrapper-tools (M2.2) — gated by both env config + per-agent
  // adapter_config.fikenverktoy_mcp_enabled_tools allowlist. Default: empty.
  const fikenMcpClient = getOrInitFikenMcpClient();
  const enabledFikenMcpTools = fikenMcpClient
    ? resolveEnabledFikenMcpTools(ctx.agent.adapterConfig)
    : [];
  const fikenMcpExecutor = fikenMcpClient
    ? buildFikenMcpToolExecutor(fikenMcpClient)
    : null;
  const fikenMcpCorrelationId = ulid();
  let fikenMcpStepIndex = 0;

  const tools: ToolDefinition[] = [
    ...pluginTools,
    ...KUNDEOVERSIKT_TOOL_DEFINITIONS,
    ...FIKEN_TOOL_DEFINITIONS,
    ...enabledFikenMcpTools,
  ];

  // Build a ToolExecutor that routes tool-calls to the right handler:
  // - Kundeoversikt built-in tools → executeKundeoversiktTool (HTTP)
  // - Legacy Fiken direct-API tools → executeFikenTool
  // - Fikenverktøy MCP wrapper-tools → fikenMcpExecutor (when enabled)
  // - All other tools → PluginToolDispatcher (plugin workers)
  const projectId = extractProjectId(ctx);
  const executeTool: ToolExecutor = async (name, args) => {
    if (isKundeoversiktTool(name)) {
      return executeKundeoversiktTool(name, args, {
        agentId: ctx.agent.id,
        runId: ctx.runId,
        companyId: ctx.agent.companyId,
        adapterType: "ollama_local",
      });
    }
    if (isFikenTool(name)) {
      return executeFikenTool(name, args);
    }
    if (fikenMcpExecutor && isFikenMcpTool(name)) {
      const mcpCtx: FikenMcpExecutorContext = {
        agentId: ctx.agent.id,
        agentName: ctx.agent.name,
        // Open Q4 in spec — Paperclip companyId stands in for MCP tenantId
        // until DB-backed agent_runtime_state lookup is wired.
        tenantId: ctx.agent.companyId,
        runId: ctx.runId,
        taskId: ctx.runtime.taskKey ?? ctx.runId,
        correlationId: fikenMcpCorrelationId,
        stepIndex: fikenMcpStepIndex++,
        companySlug: extractFikenCompanySlug(ctx.agent.adapterConfig),
      };
      return fikenMcpExecutor(name, args, mcpCtx);
    }
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
    default_prompt: typeof raw.default_prompt === "string" ? raw.default_prompt : undefined,
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
  // No well-known prompt key found. Return empty string to trigger
  // failResult("no_user_message") — do NOT stringify the raw context
  // as it may contain internal fields or credentials.
  return "";
}

function extractSystemPrompt(ctx: AdapterExecutionContext): string | undefined {
  const c = (ctx.context ?? {}) as Record<string, unknown>;
  const sys = c.systemPrompt ?? c.system ?? c.instructions;
  const base = typeof sys === "string" && sys.length > 0 ? sys : undefined;
  // Tier 1 injection: append learned-patterns markdown hvis servern la den ved.
  const learned = c.paperclipLearnedPatternsMarkdown;
  if (typeof learned === "string" && learned.length > 0) {
    return (base ? base + "\n\n" : "") + learned;
  }
  return base;
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

function extractFikenCompanySlug(adapterConfig: unknown): string | undefined {
  if (!adapterConfig || typeof adapterConfig !== "object") return undefined;
  const slug = (adapterConfig as { fiken_company_slug?: unknown }).fiken_company_slug;
  return typeof slug === "string" && slug.length > 0 ? slug : undefined;
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
