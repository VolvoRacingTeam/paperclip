/**
 * FikenMcpClient — JSON-RPC 2.0 client for Paperclip → Fikenverktøy MCP.
 *
 * Per spec § 1, § 2, § 4 (paperclip-tier-b-mcp-wireup-spec.md).
 *
 * Lifecycle of one tool-call:
 *   1. Resolve fiken_company_slug from agent_runtime_state (or ctx override).
 *   2. Resolve idempotency_key for (runId, stepIndex, payload). Detects:
 *        - replay (same step, same payload → MCP returns cached result)
 *        - conflict (same step, *different* payload → throw, escalate to QC)
 *   3. Fetch X-Fiken-Access-Token from Kundeoversikt service-endpoint.
 *   4. Sign X-MCP-Actor-Claim JWT (ES256, kid=paperclip-2026-04, TTL 5 min).
 *   5. POST <mcpEndpoint>/api/mcp with JSON-RPC 2.0 tools/call envelope.
 *   6. Apply retry policy (spec §4.1): max 3 retries on 401-expired / 503 /
 *      429 with respect for Retry-After. No retry on other 4xx.
 *   7. Normalise response → tagged union for the wrapper layer.
 *
 * The client is feature-flagged at the wrapper-tool layer (M2.2+) — this
 * module just exposes the building block.
 */

import {
  ACTOR_CLAIM_HEADER_NAME,
  type ActorClaimContext,
  signActorClaim,
} from "./actor-claim.js";
import {
  IdempotencyKeyConflictError,
  MissingFikenCompanySlugError,
  type AgentRunStateStore,
} from "./idempotency.js";
import { FikenAccessTokenFetcher } from "./token-fetch.js";

const FIKEN_TOKEN_HEADER = "X-Fiken-Access-Token";
const DEFAULT_MCP_ENDPOINT = "https://fikenverktoy.vercel.app";
const DEFAULT_MCP_PATH = "/api/mcp";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;

export type McpResultKind =
  | "success"
  | "partial"
  | "pending_human"
  | "blocked"
  | "replay"
  | "error";

export interface McpAuditEcho {
  correlationId?: string;
  requestId?: string;
  planHash?: string;
  capabilityId?: string;
  capabilityKind?: "read" | "write" | "mutating";
  compensationStatus?:
    | "not_required"
    | "compensation_pending"
    | "compensation_succeeded"
    | "compensation_failed";
}

export interface McpToolResultBase {
  toolName: string;
  idempotencyKey: string;
  isReplay: boolean;
  raw: unknown;
  audit: McpAuditEcho;
}

export type McpToolResult =
  | (McpToolResultBase & { kind: "success"; data: unknown })
  | (McpToolResultBase & { kind: "partial"; data: unknown })
  | (McpToolResultBase & {
      kind: "pending_human";
      pendingApprovalId?: string;
      blockedBy: readonly string[];
    })
  | (McpToolResultBase & { kind: "blocked"; blockedBy: readonly string[] })
  | (McpToolResultBase & { kind: "replay"; data: unknown })
  | (McpToolResultBase & {
      kind: "error";
      code: string;
      message: string;
      retriable: boolean;
    });

export interface McpCallContext {
  agentId: string;
  agentName: string;
  tenantId: string;
  runId: string;
  taskId: string;
  stepIndex: number;
  scope: readonly string[];
  /**
   * Stable correlation id used in audit + cross-call rekonstruering. The
   * wrapper layer normally generates one ULID per task-execution and keeps it
   * across all steps in that task — this lets Compliance reconstruct
   * "all Fiken-handlinger under task T" with a single index lookup.
   */
  correlationId: string;
  /**
   * Optional override for fiken_company_slug. Falls back to
   * AgentRunStateStore.getFikenCompanySlug(agentId).
   */
  companySlug?: string;
}

export interface FikenMcpClientOptions {
  /** Base URL — defaults to PAPERCLIP_FIKEN_MCP_ENDPOINT or fikenverktoy.vercel.app. */
  endpoint?: string;
  /** MCP path under endpoint — default '/api/mcp'. */
  mcpPath?: string;
  /** Required: store backing agent_runtime_state. */
  store: AgentRunStateStore;
  /** Required: token fetcher. */
  tokenFetcher: FikenAccessTokenFetcher;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override now()-ms (tests). */
  nowMs?: () => number;
  /** HTTP request timeout in ms. */
  timeoutMs?: number;
  /** Max retries for retriable failures (default 3). */
  maxRetries?: number;
  /** Override backoff schedule (ms). */
  backoffMs?: readonly number[];
  /**
   * Sign-impl override — defaults to signActorClaim from actor-claim.ts.
   * Tests pass a stub so they don't need a real EC private key.
   */
  signActorClaim?: (params: {
    ctx: ActorClaimContext;
    nowSeconds?: number;
    audienceOverride?: string;
  }) => Promise<string>;
}

export class FikenMcpClient {
  private readonly endpoint: string;
  private readonly mcpPath: string;
  private readonly store: AgentRunStateStore;
  private readonly tokenFetcher: FikenAccessTokenFetcher;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: readonly number[];
  private readonly sign: (params: {
    ctx: ActorClaimContext;
    nowSeconds?: number;
    audienceOverride?: string;
  }) => Promise<string>;

  constructor(opts: FikenMcpClientOptions) {
    this.endpoint = stripTrailingSlash(
      opts.endpoint ?? process.env.PAPERCLIP_FIKEN_MCP_ENDPOINT ?? DEFAULT_MCP_ENDPOINT,
    );
    this.mcpPath = opts.mcpPath ?? DEFAULT_MCP_PATH;
    this.store = opts.store;
    this.tokenFetcher = opts.tokenFetcher;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowMs = opts.nowMs ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.sign = opts.signActorClaim ?? ((p) => signActorClaim(p));
  }

  /** Resolve fiken_company_slug for the agent — exported for the wrapper layer to pre-flight. */
  async resolveCompanySlug(agentId: string, ctxOverride?: string): Promise<string> {
    if (ctxOverride && ctxOverride.length > 0) return ctxOverride;
    const slug = await this.store.getFikenCompanySlug(agentId);
    if (!slug) throw new MissingFikenCompanySlugError(agentId);
    return slug;
  }

  /**
   * Execute one MCP tools/call. Throws IdempotencyKeyConflictError when the
   * (runId, stepIndex) is already bound to a different payload — caller must
   * pause the agent and escalate to Quality Control without retry.
   */
  async callTool(params: {
    toolName: string;
    arguments: Record<string, unknown>;
    ctx: McpCallContext;
  }): Promise<McpToolResult> {
    const { toolName, ctx } = params;

    const companySlug = await this.resolveCompanySlug(ctx.agentId, ctx.companySlug);

    const stepRes = await this.store.resolveStep({
      agentId: ctx.agentId,
      runId: ctx.runId,
      stepIndex: ctx.stepIndex,
      payload: { toolName, arguments: params.arguments },
      now: this.nowMs,
    });
    if (stepRes.isConflict) {
      throw new IdempotencyKeyConflictError(
        `Idempotency conflict on (runId=${ctx.runId}, stepIndex=${ctx.stepIndex}): existing key ${stepRes.step.idempotencyKey} bound to a different payload`,
        stepRes.step.idempotencyKey,
        ctx.runId,
        ctx.stepIndex,
      );
    }
    const idempotencyKey = stepRes.step.idempotencyKey;

    let lastError: McpToolResult | null = null;
    let forceRefreshToken = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.executeOnce({
          toolName,
          arguments: params.arguments,
          ctx,
          companySlug,
          idempotencyKey,
          forceRefreshToken,
        });

        if (result.kind === "error") {
          if (result.code === "actor_claim_expired" && attempt < this.maxRetries) {
            // 401 expired → re-sign next attempt (no token refresh needed).
            forceRefreshToken = false;
            await this.sleep(this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 1_000);
            lastError = result;
            continue;
          }
          if (
            (result.code === "service_unavailable" || result.code === "rate_limited") &&
            result.retriable &&
            attempt < this.maxRetries
          ) {
            await this.sleep(this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 1_000);
            lastError = result;
            continue;
          }
          if (result.code === "unauthorized_token" && attempt < this.maxRetries) {
            // 401 from MCP signalling stale Fiken PAT — bust cache, retry once.
            forceRefreshToken = true;
            this.tokenFetcher.invalidate({ tenantId: ctx.tenantId, companySlug });
            await this.sleep(this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 1_000);
            lastError = result;
            continue;
          }
        }

        // Mark step as replay if MCP told us so — store the flag for callers.
        return { ...result, isReplay: stepRes.isReplay || result.kind === "replay" };
      } catch (err) {
        if (err instanceof IdempotencyKeyConflictError) throw err;
        if (attempt < this.maxRetries) {
          lastError = errorResult({
            toolName,
            idempotencyKey,
            code: "transport_error",
            message: (err as Error).message,
            retriable: true,
            audit: {},
          });
          await this.sleep(this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 1_000);
          continue;
        }
        return errorResult({
          toolName,
          idempotencyKey,
          code: "transport_error",
          message: (err as Error).message,
          retriable: false,
          audit: {},
        });
      }
    }

    return (
      lastError ??
      errorResult({
        toolName,
        idempotencyKey,
        code: "max_retries_exceeded",
        message: `Exhausted ${this.maxRetries} retries`,
        retriable: false,
        audit: {},
      })
    );
  }

  private async executeOnce(args: {
    toolName: string;
    arguments: Record<string, unknown>;
    ctx: McpCallContext;
    companySlug: string;
    idempotencyKey: string;
    forceRefreshToken: boolean;
  }): Promise<McpToolResult> {
    const { toolName, ctx, companySlug, idempotencyKey, forceRefreshToken } = args;

    const credentials = await this.tokenFetcher.getCredentials({
      tenantId: ctx.tenantId,
      companySlug,
      forceRefresh: forceRefreshToken,
    });

    const actorClaim = await this.sign({
      ctx: {
        actorType: "agent",
        actorAgentId: ctx.agentId,
        actorAgentName: ctx.agentName,
        tenantId: ctx.tenantId,
        companySlug,
        scope: ctx.scope,
        correlationId: ctx.correlationId,
        taskId: ctx.taskId,
        agentRunStateStepIndex: ctx.stepIndex,
      },
    });

    const url = `${this.endpoint}${this.mcpPath}`;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: idempotencyKey,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args.arguments,
        idempotency_key: idempotencyKey,
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          [ACTOR_CLAIM_HEADER_NAME]: actorClaim,
          [FIKEN_TOKEN_HEADER]: credentials.accessToken,
          "X-Idempotency-Key": idempotencyKey,
        },
        body,
      });
    } finally {
      clearTimeout(timer);
    }

    return parseMcpResponse({ res, toolName, idempotencyKey });
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

interface JsonRpcEnvelope {
  jsonrpc?: "2.0";
  id?: string | number;
  result?: unknown;
  error?: { code: number | string; message: string; data?: unknown };
}

interface ParsedToolBody {
  status?: string;
  data?: unknown;
  policy_evaluation?: {
    status?: string;
    blocked_by?: string[];
    pending_approval_id?: string;
  };
  idempotency_replay?: boolean;
  audit?: {
    correlation_id?: string;
    request_id?: string;
    plan_hash?: string;
    capability_id?: string;
    capability_kind?: "read" | "write" | "mutating";
    compensation_status?:
      | "not_required"
      | "compensation_pending"
      | "compensation_succeeded"
      | "compensation_failed";
  };
}

async function parseMcpResponse(args: {
  res: Response;
  toolName: string;
  idempotencyKey: string;
}): Promise<McpToolResult> {
  const { res, toolName, idempotencyKey } = args;

  if (res.status === 409) {
    const json = await safeJson(res);
    const code = extractErrorCode(json) ?? "idempotency_key_conflict";
    if (code === "idempotency_key_conflict") {
      // Caller will translate this into IdempotencyKeyConflictError above the
      // executeOnce boundary — but inside executeOnce we surface as an
      // explicit error result so retry policy can choose to NOT retry.
      return errorResult({
        toolName,
        idempotencyKey,
        code,
        message: extractErrorMessage(json) ?? "MCP returned 409 idempotency_key_conflict",
        retriable: false,
        audit: extractAudit(json),
      });
    }
  }

  if (res.status === 401) {
    const json = await safeJson(res);
    const code = extractErrorCode(json) ?? "unauthorized";
    return errorResult({
      toolName,
      idempotencyKey,
      code: code === "unauthorized" ? "unauthorized_token" : code,
      message: extractErrorMessage(json) ?? `MCP 401 ${code}`,
      retriable: code === "actor_claim_expired" || code === "unauthorized_token",
      audit: extractAudit(json),
    });
  }

  if (res.status === 403) {
    const json = await safeJson(res);
    const code = extractErrorCode(json) ?? "forbidden";
    return errorResult({
      toolName,
      idempotencyKey,
      code,
      message: extractErrorMessage(json) ?? `MCP 403 ${code}`,
      retriable: false,
      audit: extractAudit(json),
    });
  }

  if (res.status === 429) {
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after")) ?? 1_000;
    if (retryAfterMs > 0 && retryAfterMs <= MAX_RETRY_AFTER_MS) {
      await sleepMs(retryAfterMs);
    }
    return errorResult({
      toolName,
      idempotencyKey,
      code: "rate_limited",
      message: "MCP 429 rate_limited",
      retriable: true,
      audit: {},
    });
  }

  if (res.status === 503 || res.status === 502 || res.status === 504) {
    return errorResult({
      toolName,
      idempotencyKey,
      code: "service_unavailable",
      message: `MCP ${res.status}`,
      retriable: true,
      audit: {},
    });
  }

  if (!res.ok) {
    const text = await safeText(res);
    return errorResult({
      toolName,
      idempotencyKey,
      code: `http_${res.status}`,
      message: text.slice(0, 300),
      retriable: false,
      audit: {},
    });
  }

  const envelope = (await safeJson(res)) as JsonRpcEnvelope | null;
  if (!envelope) {
    return errorResult({
      toolName,
      idempotencyKey,
      code: "invalid_response",
      message: "MCP returned non-JSON or empty body",
      retriable: false,
      audit: {},
    });
  }

  if (envelope.error) {
    return errorResult({
      toolName,
      idempotencyKey,
      code: String(envelope.error.code),
      message: envelope.error.message,
      retriable: false,
      audit: extractAudit(envelope.error.data),
    });
  }

  const body = (envelope.result ?? {}) as ParsedToolBody;
  const audit = extractAudit(body);

  if (body.idempotency_replay === true) {
    return {
      kind: "replay",
      toolName,
      idempotencyKey,
      isReplay: true,
      data: body.data ?? null,
      audit,
      raw: envelope,
    };
  }

  const policyStatus = body.policy_evaluation?.status;
  const blockedBy = body.policy_evaluation?.blocked_by ?? [];

  if (policyStatus === "blocked") {
    return {
      kind: "blocked",
      toolName,
      idempotencyKey,
      isReplay: false,
      blockedBy,
      audit,
      raw: envelope,
    };
  }
  if (policyStatus === "pending_human") {
    return {
      kind: "pending_human",
      toolName,
      idempotencyKey,
      isReplay: false,
      pendingApprovalId: body.policy_evaluation?.pending_approval_id,
      blockedBy,
      audit,
      raw: envelope,
    };
  }

  if (audit.compensationStatus === "compensation_failed" || body.status === "partial") {
    return {
      kind: "partial",
      toolName,
      idempotencyKey,
      isReplay: false,
      data: body.data ?? null,
      audit,
      raw: envelope,
    };
  }

  return {
    kind: "success",
    toolName,
    idempotencyKey,
    isReplay: false,
    data: body.data ?? null,
    audit,
    raw: envelope,
  };
}

function extractAudit(input: unknown): McpAuditEcho {
  if (!input || typeof input !== "object") return {};
  const obj = input as Record<string, unknown>;
  const audit = (obj.audit ?? obj) as Record<string, unknown>;
  return {
    correlationId: typeof audit.correlation_id === "string" ? audit.correlation_id : undefined,
    requestId: typeof audit.request_id === "string" ? audit.request_id : undefined,
    planHash: typeof audit.plan_hash === "string" ? audit.plan_hash : undefined,
    capabilityId: typeof audit.capability_id === "string" ? audit.capability_id : undefined,
    capabilityKind: isCapabilityKind(audit.capability_kind) ? audit.capability_kind : undefined,
    compensationStatus: isCompensationStatus(audit.compensation_status)
      ? audit.compensation_status
      : undefined,
  };
}

function isCapabilityKind(v: unknown): v is "read" | "write" | "mutating" {
  return v === "read" || v === "write" || v === "mutating";
}

function isCompensationStatus(
  v: unknown,
): v is "not_required" | "compensation_pending" | "compensation_succeeded" | "compensation_failed" {
  return (
    v === "not_required" ||
    v === "compensation_pending" ||
    v === "compensation_succeeded" ||
    v === "compensation_failed"
  );
}

function extractErrorCode(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.code === "string") return obj.code;
  const err = obj.error as Record<string, unknown> | undefined;
  if (err && typeof err.code === "string") return err.code;
  return undefined;
}

function extractErrorMessage(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.message === "string") return obj.message;
  const err = obj.error as Record<string, unknown> | undefined;
  if (err && typeof err.message === "string") return err.message;
  return undefined;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function errorResult(args: {
  toolName: string;
  idempotencyKey: string;
  code: string;
  message: string;
  retriable: boolean;
  audit: McpAuditEcho;
}): McpToolResult {
  return {
    kind: "error",
    toolName: args.toolName,
    idempotencyKey: args.idempotencyKey,
    isReplay: false,
    code: args.code,
    message: args.message,
    retriable: args.retriable,
    audit: args.audit,
    raw: null,
  };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
