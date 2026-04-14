import { createHash } from "node:crypto";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export const DEFAULT_POLICY_TIMEZONE = "Europe/Oslo";
export const FALLBACK_BASE_URL = "http://llamacpp-gemma4:8080/v1";
export const FALLBACK_RUNTIME_MODEL = "gemma4-26b";

export type RoutedProvider = "claude_local" | "ollama_local";

export type RoutedFallbackReason =
  | "budget_cap"
  | "http_429"
  | "anthropic_rate_limit_error"
  | "anthropic_overloaded_error"
  | "two_consecutive_transport_timeouts"
  | "forced_fallback";

export interface RoutedPolicy {
  workflowName: string;
  primaryProvider: RoutedProvider;
  primaryModel: string;
  fallbackProvider: RoutedProvider;
  fallbackModel: string;
  maxTokensPerRun: number;
  dailyBudgetTokens: number;
  timezone: string;
  workflowTokenOverrides?: Record<string, number>;
}

export interface RoutedExecution {
  adapterType: RoutedProvider;
  policyModel: string;
  runtimeModel: string;
  fallbackReason: RoutedFallbackReason | null;
  maxTokensPerRun: number;
  workflowName: string;
  adapterConfigPatch: Record<string, unknown>;
}

export interface RoutedFallbackRequest {
  reason: RoutedFallbackReason;
  sourceRunId?: string | null;
  retryCount?: number | null;
}

export interface RoutedFailureSignal {
  shouldQueuePrimaryRetry: boolean;
  shouldQueueFallbackRetry: boolean;
  fallbackReason: RoutedFallbackReason | null;
  errorClass: string;
  normalizedMessage: string;
  errorFingerprint: string;
  httpStatus: number | null;
  providerErrorCode: string | null;
  errorCode: string | null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function formatDateInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return `${lookup.get("year")}-${lookup.get("month")}-${lookup.get("day")}`;
}

export function resolveWorkflowName(context: Record<string, unknown>): string {
  const candidates = [
    context.workflowName,
    context.workflow,
    context.paperclipWorkflowName,
    context.paperclipWorkflow,
  ];
  for (const candidate of candidates) {
    const value = readNonEmptyString(candidate);
    if (value) return value;
  }
  return "*";
}

export function resolveWorkflowMaxTokens(policy: RoutedPolicy): number {
  const override = policy.workflowTokenOverrides?.[policy.workflowName];
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return Math.max(0, Math.floor(policy.maxTokensPerRun));
}

export function resolveRuntimeModelName(model: string, provider: RoutedProvider): string {
  const normalized = model.trim();
  if (provider === "claude_local") {
    if (normalized === "claude-haiku-4-5") return "claude-haiku-4-5-20251001";
    return normalized;
  }
  if (normalized === "gemma-4-26b-a4b-q3_k_m-llamacpp") return FALLBACK_RUNTIME_MODEL;
  if (normalized === "llamacpp-gemma4") return FALLBACK_RUNTIME_MODEL;
  return normalized || FALLBACK_RUNTIME_MODEL;
}

export function readFallbackRequest(context: Record<string, unknown>): RoutedFallbackRequest | null {
  const record = asRecord(context.paperclipFallbackRequest);
  const reason = readNonEmptyString(record.reason);
  if (!reason) return null;
  return {
    reason: reason as RoutedFallbackReason,
    sourceRunId: readNonEmptyString(record.sourceRunId),
    retryCount: asNumber(record.retryCount, 0),
  };
}

export function buildFallbackRequest(
  existingContext: Record<string, unknown>,
  input: { reason: RoutedFallbackReason; sourceRunId?: string | null; retryCount?: number | null },
): Record<string, unknown> {
  return {
    ...existingContext,
    paperclipFallbackRequest: {
      reason: input.reason,
      sourceRunId: input.sourceRunId ?? null,
      retryCount: input.retryCount ?? 0,
      queuedAt: new Date().toISOString(),
    },
  };
}

export function buildPrimaryRetryContext(
  existingContext: Record<string, unknown>,
  retryCount: number,
): Record<string, unknown> {
  return {
    ...existingContext,
    paperclipTransportTimeoutRetryCount: retryCount,
  };
}

export function resolveTransportTimeoutRetryCount(context: Record<string, unknown>): number {
  return Math.max(0, Math.floor(asNumber(context.paperclipTransportTimeoutRetryCount, 0)));
}

export function clearRetryRoutingContext(context: Record<string, unknown>): Record<string, unknown> {
  const next = { ...context };
  delete next.paperclipFallbackRequest;
  delete next.paperclipTransportTimeoutRetryCount;
  return next;
}

export function buildRoutedPolicy(input: {
  workflowName: string;
  policyRow?: Record<string, unknown> | null;
  adapterConfig: Record<string, unknown>;
  agentAdapterType: string;
}): RoutedPolicy {
  const policyRow = asRecord(input.policyRow);
  const config = asRecord(input.adapterConfig);
  const workflowOverrides = asRecord(config.workflow_token_overrides);

  const primaryProvider =
    (readNonEmptyString(policyRow.primaryProvider ?? policyRow.primary_provider) ??
      readNonEmptyString(config.primary_provider) ??
      (input.agentAdapterType === "ollama_local" ? "ollama_local" : "claude_local")) as RoutedProvider;
  const fallbackProvider =
    (readNonEmptyString(policyRow.fallbackProvider ?? policyRow.fallback_provider) ??
      readNonEmptyString(config.fallback_provider) ??
      "ollama_local") as RoutedProvider;
  const primaryModel =
    readNonEmptyString(policyRow.primaryModel ?? policyRow.primary_model) ??
    readNonEmptyString(config.primary_model) ??
    readNonEmptyString(config.model) ??
    "claude-sonnet-4-6";
  const fallbackModel =
    readNonEmptyString(policyRow.fallbackModel ?? policyRow.fallback_model) ??
    readNonEmptyString(config.fallback_model) ??
    "gemma-4-26b-a4b-q3_k_m-llamacpp";
  const maxTokensPerRun = Math.max(
    0,
    Math.floor(
      asNumber(
        policyRow.maxTokensPerRun ?? policyRow.max_tokens_per_run,
        asNumber(config.max_tokens_per_run, asNumber(config.max_tokens, 0)),
      ),
    ),
  );
  const dailyBudgetTokens = Math.max(
    0,
    Math.floor(
      asNumber(
        policyRow.dailyBudgetTokens ?? policyRow.daily_budget_tokens,
        asNumber(config.daily_budget_tokens, 0),
      ),
    ),
  );
  const timezone =
    readNonEmptyString(policyRow.timezone) ??
    readNonEmptyString(config.budget_timezone) ??
    DEFAULT_POLICY_TIMEZONE;

  const workflowTokenOverrides = Object.fromEntries(
    Object.entries(workflowOverrides)
      .map(([key, value]) => [key, Math.max(0, Math.floor(asNumber(value, 0)))] as const)
      .filter(([, value]) => value > 0),
  );

  return {
    workflowName: input.workflowName,
    primaryProvider,
    primaryModel,
    fallbackProvider,
    fallbackModel,
    maxTokensPerRun,
    dailyBudgetTokens,
    timezone,
    workflowTokenOverrides,
  };
}

function buildAdapterConfigPatch(input: {
  provider: RoutedProvider;
  runtimeModel: string;
  fallbackReason: RoutedFallbackReason | null;
  maxTokensPerRun: number;
  baseConfig: Record<string, unknown>;
}) {
  if (input.provider === "claude_local") {
    return {
      ...input.baseConfig,
      model: input.runtimeModel,
      primary_model: input.runtimeModel,
      max_tokens_per_run: input.maxTokensPerRun,
      selected_model_provider: "claude_local",
      selected_model_runtime: input.runtimeModel,
      fallback_reason: input.fallbackReason,
    };
  }

  return {
    ...input.baseConfig,
    ai_backend: "ollama_local",
    model_name: input.runtimeModel,
    base_url: readNonEmptyString(input.baseConfig.fallback_base_url) ??
      readNonEmptyString(input.baseConfig.base_url) ??
      FALLBACK_BASE_URL,
    max_tokens_per_run: input.maxTokensPerRun,
    selected_model_provider: "ollama_local",
    selected_model_runtime: input.runtimeModel,
    fallback_reason: input.fallbackReason,
  };
}

export function selectExecutionRoute(input: {
  policy: RoutedPolicy;
  adapterConfig: Record<string, unknown>;
  primaryTokensUsedToday: number;
  fallbackRequest: RoutedFallbackRequest | null;
}): RoutedExecution {
  const maxTokensPerRun = resolveWorkflowMaxTokens(input.policy);
  const remainingPrimaryBudget = input.policy.dailyBudgetTokens - input.primaryTokensUsedToday;
  const budgetFallback =
    input.policy.dailyBudgetTokens > 0 &&
    maxTokensPerRun > 0 &&
    remainingPrimaryBudget < maxTokensPerRun;
  const forcedFallbackReason = input.fallbackRequest?.reason ?? null;
  const fallbackReason =
    forcedFallbackReason ??
    (budgetFallback ? "budget_cap" : null);
  const provider = fallbackReason ? input.policy.fallbackProvider : input.policy.primaryProvider;
  const model = fallbackReason ? input.policy.fallbackModel : input.policy.primaryModel;
  const runtimeModel = resolveRuntimeModelName(model, provider);
  return {
    adapterType: provider,
    policyModel: model,
    runtimeModel,
    fallbackReason,
    maxTokensPerRun,
    workflowName: input.policy.workflowName,
    adapterConfigPatch: buildAdapterConfigPatch({
      provider,
      runtimeModel,
      fallbackReason,
      maxTokensPerRun,
      baseConfig: input.adapterConfig,
    }),
  };
}

function extractMessageBlob(result: AdapterExecutionResult): string {
  const fragments = [
    typeof result.errorMessage === "string" ? result.errorMessage : "",
    typeof result.errorCode === "string" ? result.errorCode : "",
  ];
  if (result.resultJson && typeof result.resultJson === "object") {
    try {
      fragments.push(JSON.stringify(result.resultJson));
    } catch {
      // ignore non-serializable payloads
    }
  }
  return fragments.join("\n").trim();
}

function detectHttp429(blob: string): boolean {
  return /\bhttp\s*429\b|\b429\b/i.test(blob);
}

function detectRateLimit(blob: string): boolean {
  return /\brate[ _-]?limit(?:[ _-]?error)?\b/i.test(blob);
}

function detectOverloaded(blob: string): boolean {
  return /\boverloaded(?:[ _-]?error)?\b/i.test(blob);
}

function detectTransportTimeout(result: AdapterExecutionResult, blob: string): boolean {
  if (result.timedOut) return true;
  const code = readNonEmptyString(result.errorCode)?.toLowerCase() ?? "";
  if (code === "timeout") return true;
  return /\btimed?\s*out\b|\babort(?:ed|error)\b|\betimedout\b/i.test(blob);
}

export function classifyAdapterFailure(input: {
  result: AdapterExecutionResult;
  transportTimeoutRetryCount: number;
}): RoutedFailureSignal {
  const blob = extractMessageBlob(input.result);
  const normalizedMessage = blob.replace(/\s+/g, " ").trim() || "adapter failure";
  const httpStatus = detectHttp429(blob) ? 429 : null;
  const rateLimited = detectRateLimit(blob);
  const overloaded = detectOverloaded(blob);
  const transportTimeout = detectTransportTimeout(input.result, blob);

  let fallbackReason: RoutedFallbackReason | null = null;
  let shouldQueuePrimaryRetry = false;
  let providerErrorCode: string | null = null;

  if (httpStatus === 429) {
    fallbackReason = "http_429";
  } else if (rateLimited) {
    fallbackReason = "anthropic_rate_limit_error";
    providerErrorCode = "rate_limit_error";
  } else if (overloaded) {
    fallbackReason = "anthropic_overloaded_error";
    providerErrorCode = "overloaded_error";
  } else if (transportTimeout && input.transportTimeoutRetryCount >= 1) {
    fallbackReason = "two_consecutive_transport_timeouts";
  } else if (transportTimeout) {
    shouldQueuePrimaryRetry = true;
  }

  const errorClass =
    fallbackReason ??
    (transportTimeout ? "transport_timeout" : "adapter_failure");
  const errorCode = readNonEmptyString(input.result.errorCode);
  const errorFingerprint = createHash("sha256")
    .update(`${errorClass}\n${normalizedMessage}\n${httpStatus ?? ""}\n${providerErrorCode ?? ""}`)
    .digest("hex");

  return {
    shouldQueuePrimaryRetry,
    shouldQueueFallbackRetry: fallbackReason !== null,
    fallbackReason,
    errorClass,
    normalizedMessage,
    errorFingerprint,
    httpStatus,
    providerErrorCode,
    errorCode,
  };
}
