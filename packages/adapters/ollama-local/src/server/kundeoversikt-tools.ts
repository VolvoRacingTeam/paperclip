/**
 * Built-in Kundeoversikt tools for the ollama_local adapter.
 *
 * 14 tools covering: email listing, customer context, draft replies,
 * email classification, action logging, prospect management og
 * bokføringsrevisjoner.
 *
 * Environment variables (set in /opt/paperclip/.env):
 *   AGENT_API_KEY            — Bearer token for Kundeoversikt agent API (legacy fallback)
 *   KUNDEOVERSIKT_DRAFTS_URL — Base URL for drafts endpoint
 *   KUNDEOVERSIKT_ORG_ID     — Organization UUID for Verkvelven AS (used both as
 *                              query param and as JWT organization_id claim)
 *   PAPERCLIP_AGENT_JWT_ENABLED — Feature flag (true/false). When true and a per-run
 *                              JWT context is available, outbound calls use
 *                              `X-Paperclip-Agent-Claim: <ES256-JWT>` instead of Bearer.
 *                              Default false. Canary onsdag 2026-04-29.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getOrCreateIdempotencyKey } from "./idempotency.js";
import {
  backoffFor429,
  computeBackoffMs,
  parseRateLimitHeaders,
} from "./rate-limit-client.js";
import type { ToolDefinition } from "./schema.js";
import {
  isAgentJwtEnabled,
  signedFetch,
  type JwtRequestContext,
} from "./signed-fetch.js";

type ToolError = {
  error: string;
  code?: string;
  retry_after?: string;
};

type JsonObject = Record<string, unknown>;

type PendingRevision = {
  id: string;
  organization_id: string;
  customer_id: string | null;
  document_id: string | null;
  company_slug: string;
  status: "needs_revision" | "needs_human_escalation";
  booking_type: "purchase" | "journal_entry";
  inbox_document_id: number | null;
  fiken_payload: Record<string, unknown>;
  transaction_desc: string | null;
  suggested_account: string | null;
  amount_nok: string;
  ai_confidence: number;
  ai_reasoning: string;
  actor_name: string;
  human_note: string | null;
  human_note_structured: {
    reason_codes: string[];
    correct_account?: string | null;
    correct_vat_code?: string | null;
    document_interpretation?: string | null;
    free_text?: string | null;
  } | null;
  revision_count: number;
  last_feedback_at: string | null;
  latest_feedback: {
    feedback_id: string;
    feedback_type: "edited" | "returned" | "rejected" | "positive_example";
    human_note: string | null;
    reason_codes: string[];
    requested_at: string;
    resolved_at: string | null;
    resolved_by_actor_name: string | null;
  } | null;
  compliance_gate_open: boolean;
  created_at: string;
  updated_at: string;
};

type BookkeepingFeedbackExample = {
  feedback_id: string;
  queue_id: string;
  document_id: string | null;
  feedback_type: "edited" | "returned" | "rejected" | "positive_example";
  original_proposal: Record<string, unknown>;
  corrected_proposal: Record<string, unknown>;
  human_note: string | null;
  reason_codes: string[];
  what_was_wrong?: string | null;
  similarity: number;
  created_at: string;
};

type PendingRevisionListResponse = {
  items?: unknown;
};

type BookkeepingFeedbackResponse = {
  examples?: unknown;
};

type RevisionSubmissionResponse = {
  item?: unknown;
  idempotent_replay?: unknown;
};

type KnowledgeNoteDraftResponse = {
  status?: unknown;
  noteId?: unknown;
  revisionId?: unknown;
  queueId?: unknown;
  basedOnRevisionId?: unknown;
  diffPreview?: unknown;
  embeddingStatus?: unknown;
  requiresToreReview?: unknown;
};

const KNOWLEDGE_NOTE_TYPES = [
  "accounting_rule",
  "customer_exception",
  "vendor_mapping",
  "vat_rule",
  "tone_preference",
  "stop_rule",
  "compliance_rule",
] as const;
type KnowledgeNoteType = (typeof KNOWLEDGE_NOTE_TYPES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEARNING_DISABLED_SUPPRESS_MS = 5 * 60 * 1000;
const learningDisabledSuppress = new Map<string, number>();

/**
 * Deterministic idempotency key for knowledge-note drafts.
 *
 * Spec: sha256(`${runId}:${customerId}:${noteKey}`).slice(0, 32)
 * — same runId+customerId+noteKey → same key, så en retry treffer
 * Kundeoversikts idempotency-cache i stedet for å lage duplikater.
 */
export function computeKnowledgeNoteDraftIdempotencyKey(
  runId: string,
  customerId: string,
  noteKey: string,
): string {
  return createHash("sha256")
    .update(`${runId}:${customerId}:${noteKey}`)
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function baseUrl(): string {
  const draftsUrl = env("KUNDEOVERSIKT_DRAFTS_URL", "https://www.kundeoversikt.no/api/agent/drafts");
  return draftsUrl.replace(/\/drafts$/, "");
}

function orgId(): string {
  return env("KUNDEOVERSIKT_ORG_ID");
}

function apiKey(): string {
  return env("AGENT_API_KEY");
}

// ---------------------------------------------------------------------------
// Per-call JWT context (set by executeKundeoversiktTool, read by agentFetch helpers).
// Synchronous because executeKundeoversiktTool is single-flight per call —
// each tool invocation completes before another can begin within the same run.
// ---------------------------------------------------------------------------

export interface KundeoversiktCallContext {
  agentId: string;
  runId: string;
  /** Optional Paperclip-side companyId — surfaced as `company_id` claim only. */
  companyId?: string;
  /** Adapter type ("ollama_local") — surfaced as `adapter_type` claim only. */
  adapterType?: string;
}

let currentCallContext: KundeoversiktCallContext | null = null;
let currentToolName: string | null = null;

function buildJwtContextForCurrentCall(): JwtRequestContext | null {
  if (!isAgentJwtEnabled()) return null;
  if (!currentCallContext || !currentToolName) return null;
  const organizationId = process.env.KUNDEOVERSIKT_ORG_ID?.trim();
  if (!organizationId) {
    console.warn(
      "[kundeoversikt] PAPERCLIP_AGENT_JWT_ENABLED=true but KUNDEOVERSIKT_ORG_ID not set; falling back to Bearer.",
    );
    return null;
  }
  return {
    agentId: currentCallContext.agentId,
    runId: currentCallContext.runId,
    toolName: currentToolName,
    organizationId,
    companyId: currentCallContext.companyId,
    adapterType: currentCallContext.adapterType ?? "ollama_local",
  };
}


function dryRunEnabled(): boolean {
  return (process.env.PAPERCLIP_DRY_RUN ?? "false").trim().toLowerCase() === "true";
}

function shouldSendDryRunHeader(method?: string): boolean {
  void method;
  return dryRunEnabled();
}

async function appendDryRunLog(entry: Record<string, unknown>): Promise<void> {
  const filePath = process.env.PAPERCLIP_DRY_RUN_LOG_PATH?.trim();
  if (!filePath) return;

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(
      filePath,
      `${JSON.stringify({ loggedAt: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch (err) {
    console.warn(
      `[paperclip] could not append dry-run log: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Shared rate-limit aware fetch executor used by BOTH `agentFetch()` and
 * `agentBookkeepingFetch()`. Quinn finding #1: previously only `agentFetch`
 * had pre-call cache gate + 429-retry. Knowledge-note draft routes through
 * `agentBookkeepingFetch` and therefore bypassed the cache + retry — a 429
 * was returned to the agent immediately with no respect for Retry-After
 * and no cache update.
 *
 * Returns either a successful `Response` (caller decodes body itself) or
 * a `RateLimitedToolError` (caller propagates verbatim).
 *
 * Rate-limit handling (SON-97):
 *   1. Pre-call cache-gate — short-circuits with source:'cache'.
 *   2. Post-call success — cache headers per bucket.
 *   3. Post-call 429 — backoff <=60s ⇒ ÉN retry; >60s ⇒ RATE_LIMITED.
 */
type FetchWithRateLimitResult =
  | { kind: "response"; res: Response; attempts: number }
  | { kind: "rate_limited"; err: RateLimitedToolError };

async function executeFetchWithRateLimit(
  performFetch: () => Promise<Response>,
  opts: {
    buckets: string[];
    toolNameForLog: string;
    requestPath: string;
    method: string;
    dryRunLog: boolean;
  },
): Promise<FetchWithRateLimitResult> {
  const { buckets, toolNameForLog, requestPath, method, dryRunLog } = opts;

  // --- Pre-call cache gate -------------------------------------------------
  const nowMs = Date.now();
  const cached = getCachedBackoffMs(buckets, nowMs);
  if (cached.waitMs > 0) {
    const retryAfter = Math.ceil(cached.waitMs / 1000);
    console.warn(
      `[kundeoversikt] ${toolNameForLog}: rate-limit pre-call short-circuit ` +
        `bucket=${cached.bucket ?? "?"} retryAfter=${retryAfter}s ` +
        `(event=kundeoversikt_rate_limit_hit source=cache)`,
    );
    if (dryRunLog) {
      await appendDryRunLog({
        system: "kundeoversikt",
        method,
        path: requestPath,
        rateLimited: true,
        source: "cache",
        bucket: cached.bucket,
        retryAfter,
      });
    }
    return {
      kind: "rate_limited",
      err: {
        error: "RATE_LIMITED",
        code: "RATE_LIMITED",
        retriable: true,
        hint: RATE_LIMITED_HINT,
        retryAfter,
        bucket: cached.bucket,
        attempts: 0,
        source: "cache",
      },
    };
  }

  // --- Single attempt (with at most one 429-retry) -------------------------
  let res = await performFetch();
  let attempts = 1;
  recordRateLimitHeaders(buckets, res.headers);

  if (res.status === 429) {
    const waitMs = backoffFor429(res);
    const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
    const bucketHit = buckets[0] ?? null;

    if (waitMs > AGENT_FETCH_MAX_BACKOFF_MS) {
      console.warn(
        `[kundeoversikt] ${toolNameForLog}: rate-limit 429 wait=${waitMs}ms ` +
          `over 60s-cap — returnerer RATE_LIMITED ` +
          `(event=kundeoversikt_rate_limit_hit source=server attempts=${attempts})`,
      );
      if (dryRunLog) {
        await appendDryRunLog({
          system: "kundeoversikt",
          method,
          path: requestPath,
          status: 429,
          rateLimited: true,
          source: "server",
          retryAfter,
          attempts,
        });
      }
      return {
        kind: "rate_limited",
        err: {
          error: "RATE_LIMITED",
          code: "RATE_LIMITED",
          retriable: true,
          hint: RATE_LIMITED_HINT,
          retryAfter,
          bucket: bucketHit,
          attempts,
          source: "server",
        },
      };
    }

    console.warn(
      `[kundeoversikt] ${toolNameForLog}: rate-limit 429 backoff ${waitMs}ms før retry ` +
        `(event=kundeoversikt_rate_limit_hit source=server attempts=${attempts})`,
    );
    await vent(waitMs);
    res = await performFetch();
    attempts = 2;
    recordRateLimitHeaders(buckets, res.headers);

    if (res.status === 429) {
      const retryWaitMs = backoffFor429(res);
      const retryAfterSecs = Math.max(1, Math.ceil(retryWaitMs / 1000));
      console.warn(
        `[kundeoversikt] ${toolNameForLog}: rate-limit 429 også på retry — ` +
          `returnerer RATE_LIMITED ` +
          `(event=kundeoversikt_rate_limit_hit source=server attempts=${attempts})`,
      );
      if (dryRunLog) {
        await appendDryRunLog({
          system: "kundeoversikt",
          method,
          path: requestPath,
          status: 429,
          rateLimited: true,
          source: "server",
          retryAfter: retryAfterSecs,
          attempts,
        });
      }
      return {
        kind: "rate_limited",
        err: {
          error: "RATE_LIMITED",
          code: "RATE_LIMITED",
          retriable: true,
          hint: RATE_LIMITED_HINT,
          retryAfter: retryAfterSecs,
          bucket: bucketHit,
          attempts,
          source: "server",
        },
      };
    }
  }

  return { kind: "response", res, attempts };
}

/**
 * Outbound HTTP helper used av Kundeoversikt-tools som ikke trenger
 * den typede envelope-formen fra `agentBookkeepingFetch`.
 *
 * Returnerer:
 *   - parset JSON-body på 2xx (legacy callers fungerer som før),
 *   - `{ error: string }` på transport- / non-rate-limit HTTP-feil (legacy),
 *   - diskriminert `RateLimitedToolError` på 429 (cache eller server).
 */
async function agentFetch(
  path: string,
  options?: RequestInit,
): Promise<unknown> {
  const url = `${baseUrl()}${path}`;
  const method = (options?.method ?? "GET").toUpperCase();
  const dryRun = shouldSendDryRunHeader(method);
  const dryRunLog = dryRunEnabled();
  const jwtCtx = buildJwtContextForCurrentCall();
  const buckets = bucketsForCall(path, options?.body);
  const toolNameForLog = currentToolName ?? "agentFetch";

  const performFetch = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const baseHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        ...((options?.headers as Record<string, string>) ?? {}),
        ...(dryRun ? { "X-Paperclip-Dry-Run": "true" } : {}),
      };
      if (jwtCtx) {
        return await signedFetch(
          url,
          {
            ...options,
            method,
            signal: controller.signal,
            headers: baseHeaders,
            body: typeof options?.body === "string" ? options.body : undefined,
          },
          jwtCtx,
        );
      }
      return await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          ...baseHeaders,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let attempts = 0;
  try {
    const outcome = await executeFetchWithRateLimit(performFetch, {
      buckets,
      toolNameForLog,
      requestPath: path,
      method,
      dryRunLog,
    });
    if (outcome.kind === "rate_limited") return outcome.err;
    const res = outcome.res;
    attempts = outcome.attempts;

    const body = await res.json() as Record<string, unknown>;
    if (dryRunLog) {
      await appendDryRunLog({
        system: "kundeoversikt",
        method,
        path,
        status: res.status,
        ok: res.ok,
        dryRunHeader: dryRun,
        attempts,
      });
    }
    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${JSON.stringify(body)}` };
    }
    return body;
  } catch (err) {
    if (dryRunLog) {
      await appendDryRunLog({
        system: "kundeoversikt",
        method,
        path,
        error: (err as Error).message,
        dryRunHeader: dryRun,
        attempts,
      });
    }
    return { error: `Fetch failed: ${(err as Error).message}` };
  }
}

type KundeoversiktHttpResponse = {
  status: number;
  headers: Headers;
  body: unknown;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArg(
  args: Record<string, unknown>,
  field: string,
  alias?: string,
): string | undefined {
  const direct = args[field];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct;
  }

  if (!alias) return undefined;
  const legacy = args[alias];
  if (typeof legacy === "string" && legacy.trim().length > 0) {
    return legacy;
  }

  return undefined;
}

function readNumberArg(
  args: Record<string, unknown>,
  field: string,
  alias?: string,
): number | undefined {
  const direct = args[field];
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }

  if (!alias) return undefined;
  const legacy = args[alias];
  if (typeof legacy === "number" && Number.isFinite(legacy)) {
    return legacy;
  }

  return undefined;
}

function invalidArguments(error: string): ToolError {
  return { error, code: "INVALID_ARGUMENTS" };
}

function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function requireUuid(value: string | undefined, field: string): ToolError | string {
  if (!value) {
    return invalidArguments(`${field} er påkrevd.`);
  }
  if (!isUuid(value)) {
    return invalidArguments(`${field} må være en gyldig UUID`);
  }
  return value;
}

function normalizeErrorResponse(
  body: unknown,
  fallbackError: string,
  fallbackCode?: string,
): ToolError {
  if (isRecord(body) && typeof body.error === "string") {
    const normalized: ToolError = {
      error: body.error,
    };
    if (typeof body.code === "string") {
      normalized.code = body.code;
    } else if (fallbackCode) {
      normalized.code = fallbackCode;
    }
    return normalized;
  }

  const normalized: ToolError = { error: fallbackError };
  if (fallbackCode) {
    normalized.code = fallbackCode;
  }
  return normalized;
}

function normalizeLimit(rawLimit: number | undefined, opts: {
  defaultValue: number;
  maxValue: number;
}): number {
  if (rawLimit === undefined) return opts.defaultValue;
  const rounded = Math.trunc(rawLimit);
  if (rounded < 1) return opts.defaultValue;
  return Math.min(rounded, opts.maxValue);
}

function normalizeOffset(rawOffset: number | undefined, defaultValue = 0): number {
  if (rawOffset === undefined) return defaultValue;
  const rounded = Math.trunc(rawOffset);
  if (rounded < 0) return defaultValue;
  return rounded;
}

function ensureObjectPayload(
  value: unknown,
): JsonObject | null {
  if (!isRecord(value)) {
    return null;
  }
  return value;
}

function hasValidFikenPayloadShape(value: JsonObject): boolean {
  const date = value.date;
  const lines = value.lines;
  return typeof date === "string" && date.trim().length > 0 && Array.isArray(lines) && lines.length > 0;
}

async function vent(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function warnOnUnexpectedContractVersion(
  toolName: string,
  headers: Headers,
): void {
  const contractVersion = headers.get("X-Kundeoversikt-Contract-Version");
  if (contractVersion !== "1") {
    console.warn(
      `[kundeoversikt] ${toolName}: uventet X-Kundeoversikt-Contract-Version=${contractVersion ?? "(mangler)"}`,
    );
  }
}

async function applyRateLimitBackoff(
  toolName: string,
  res: Response,
  threshold = 4,
): Promise<void> {
  const waitMs =
    res.status === 429
      ? backoffFor429(res)
      : computeBackoffMs(parseRateLimitHeaders(res.headers), { threshold });

  if (waitMs <= 0) return;

  console.warn(
    `[kundeoversikt] ${toolName}: rate-limit backoff ${waitMs}ms før neste kall.`,
  );
  await vent(waitMs);
}

// ---------------------------------------------------------------------------
// In-process rate-limit cache used by agentFetch() pre-call gate.
// Keyed by bucket (agentId-min, agentId-hour, customerId, orgId, runId).
// Lets us short-circuit before issuing a request the server will only 429.
// Exported (under __test) for unit tests.
// ---------------------------------------------------------------------------

type RateLimitCacheEntry = {
  remaining: number;
  resetEpoch: number;
};

const rateLimitCache = new Map<string, RateLimitCacheEntry>();

const AGENT_FETCH_MAX_BACKOFF_MS = 60_000;

export function __resetRateLimitCacheForTest(): void {
  rateLimitCache.clear();
}

export function __peekRateLimitCacheForTest(): Map<string, RateLimitCacheEntry> {
  return new Map(rateLimitCache);
}

function extractCustomerIdFromPathOrBody(
  path: string,
  body: unknown,
): string | undefined {
  // Match `/customers/<segment>` and require <segment> to be a strict UUID v1-5.
  // Loose hex patterns like `/customers/anonymous/...` or `/customers/00000000`
  // must NOT cache a customer-bucket (Quinn finding #2).
  const match = /\/customers\/([^/?#]+)/.exec(path);
  if (match?.[1] && UUID_RE.test(match[1])) return match[1];
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.customerId === "string" &&
        UUID_RE.test(parsed.customerId)
      ) {
        return parsed.customerId;
      }
    } catch {
      /* not json — ignore */
    }
  }
  return undefined;
}

function bucketsForCall(path: string, body: unknown): string[] {
  const buckets: string[] = [];
  const ctx = currentCallContext;
  if (ctx) {
    buckets.push(`agent:${ctx.agentId}:min`);
    buckets.push(`agent:${ctx.agentId}:hour`);
    buckets.push(`run:${ctx.runId}`);
  }
  const org = process.env.KUNDEOVERSIKT_ORG_ID?.trim();
  if (org) buckets.push(`org:${org}`);
  const customerId = extractCustomerIdFromPathOrBody(path, body);
  if (customerId) buckets.push(`customer:${customerId}`);
  return buckets;
}

function getCachedBackoffMs(
  buckets: string[],
  nowMs: number,
): { waitMs: number; bucket: string | null } {
  let waitMs = 0;
  let bucket: string | null = null;
  for (const key of buckets) {
    const entry = rateLimitCache.get(key);
    if (!entry) continue;
    const resetMs = entry.resetEpoch * 1000;
    if (entry.remaining <= 0 && resetMs > nowMs) {
      const candidate = resetMs - nowMs;
      if (candidate > waitMs) {
        waitMs = candidate;
        bucket = key;
      }
    } else if (resetMs <= nowMs) {
      // Window har rullet over — fjern utdatert entry.
      rateLimitCache.delete(key);
    }
  }
  return { waitMs, bucket };
}

/**
 * Filter the bucket-set we'll cache rate-limit state into, given the response
 * headers. Quinn finding #3:
 *
 * Vercel/Kundeoversikt returns ONE set of `X-RateLimit-*` headers per response,
 * which represents the most-restrictive bucket the call hit — but we don't know
 * which one that was. Recording `remaining=0` against ALL buckets (org, agent,
 * customer) on every call leads to over-pessimistic blocking of unrelated
 * customers when the real flaskehals was e.g. the org bucket.
 *
 * Strategy:
 *   - org / agent / run buckets: ALWAYS record. They are shared across all
 *     customers, so over-pessimism there is safe (and intentional — if one
 *     call learns the org budget is empty, every other call should respect it).
 *   - customer:<id> bucket: ONLY record when the server disambiguates with
 *     `X-RateLimit-Bucket` or `X-RateLimit-Scope` matching the customer scope,
 *     OR when the path/body is unambiguously customer-scoped AND we have
 *     positive evidence the headers describe that bucket. Default: skip.
 */
function filterBucketsForRecording(
  buckets: string[],
  headers: Headers,
): string[] {
  const bucketHeader = headers.get("X-RateLimit-Bucket")?.trim().toLowerCase();
  const scopeHeader = headers.get("X-RateLimit-Scope")?.trim().toLowerCase();
  const customerScoped =
    bucketHeader?.startsWith("customer") === true ||
    scopeHeader === "customer";

  return buckets.filter((key) => {
    if (key.startsWith("customer:")) {
      // Only cache customer-bucket if the server explicitly tagged the headers
      // as customer-scoped. Otherwise we'd block kunde B based on kunde A's call.
      return customerScoped;
    }
    // org / agent / run are global to the org, safe to record from any header.
    return true;
  });
}

function recordRateLimitHeaders(
  buckets: string[],
  headers: Headers,
): void {
  const state = parseRateLimitHeaders(headers);
  if (!state) return;
  const recordable = filterBucketsForRecording(buckets, headers);
  for (const key of recordable) {
    rateLimitCache.set(key, {
      remaining: state.remaining,
      resetEpoch: state.resetEpoch,
    });
  }
}

type RateLimitedToolError = {
  error: "RATE_LIMITED";
  /** Mirror of `error` so callers that check `result.code === "RATE_LIMITED"` work. */
  code: "RATE_LIMITED";
  /** Always retriable — it just needs to wait until `retryAfter`. */
  retriable: true;
  /** Human-readable instruction for the agent. */
  hint: string;
  retryAfter: number; // seconds
  bucket: string | null;
  attempts: number;
  source: "cache" | "server";
};

const RATE_LIMITED_HINT =
  "Rate-limit truffet — vent retryAfter sekunder før neste kall.";

async function agentBookkeepingFetch(
  requestPath: string,
  options?: RequestInit,
): Promise<KundeoversiktHttpResponse | ToolError | RateLimitedToolError> {
  const url = `${baseUrl()}${requestPath}`;
  const method = (options?.method ?? "GET").toUpperCase();
  const dryRun = shouldSendDryRunHeader(method);
  const dryRunLog = dryRunEnabled();
  const jwtCtx = buildJwtContextForCurrentCall();
  const buckets = bucketsForCall(requestPath, options?.body);
  const toolNameForLog = currentToolName ?? "agentBookkeepingFetch";

  // Each fetch attempt gets its own controller so the retry path doesn't
  // inherit an aborted signal from the first try.
  const performFetch = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const baseHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Paperclip-Contract-Version": "1",
        ...((options?.headers as Record<string, string>) ?? {}),
        ...(dryRun ? { "X-Paperclip-Dry-Run": "true" } : {}),
      };
      if (jwtCtx) {
        return await signedFetch(
          url,
          {
            ...options,
            method,
            signal: controller.signal,
            headers: baseHeaders,
            body: typeof options?.body === "string" ? options.body : undefined,
          },
          jwtCtx,
        );
      }
      return await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          ...baseHeaders,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // Quinn finding #1: route bookkeeping calls through the same rate-limit
    // executor as agentFetch so cache-gate + 429-retry apply uniformly.
    const outcome = await executeFetchWithRateLimit(performFetch, {
      buckets,
      toolNameForLog,
      requestPath,
      method,
      dryRunLog,
    });
    if (outcome.kind === "rate_limited") return outcome.err;
    const res = outcome.res;

    const rawText = await res.text();
    let body: unknown = null;
    if (rawText.trim().length > 0) {
      try {
        body = JSON.parse(rawText) as unknown;
      } catch {
        body = { error: rawText.slice(0, 500) };
      }
    }

    if (dryRunLog) {
      await appendDryRunLog({
        system: "kundeoversikt",
        method,
        path: requestPath,
        status: res.status,
        ok: res.ok,
        dryRunHeader: dryRun,
        contractVersion: "1",
        attempts: outcome.attempts,
      });
    }

    return {
      status: res.status,
      headers: res.headers,
      body,
    };
  } catch (err) {
    if (dryRunLog) {
      await appendDryRunLog({
        system: "kundeoversikt",
        method,
        path: requestPath,
        error: (err as Error).message,
        dryRunHeader: dryRun,
        contractVersion: "1",
      });
    }

    return {
      error: `Fetch failed: ${(err as Error).message}`,
      code: "FETCH_FAILED",
    };
  }
}

// ---------------------------------------------------------------------------
// Tool definitions (for JSON schema)
// ---------------------------------------------------------------------------

export const KUNDEOVERSIKT_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === 1. List unprocessed emails ===
  {
    name: "kundeoversikt_list_unprocessed_emails",
    description:
      "Hent innkommende e-poster som ikke er behandlet. " +
      "Returnerer subject, bodyText (maks 2000 tegn), avsender, kunde-info. " +
      "Kall dette FØRST for å finne nye e-poster.",
    parametersSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maks antall (1-50, standard 10).", minimum: 1, maximum: 50 },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // === 2. Get customer context ===
  {
    name: "kundeoversikt_get_customer_context",
    description:
      "Hent kundekontekst: kundedata, preferanser, regnskapsinstruksjoner, observasjoner. " +
      "Bruk customerId fra e-post-listen.",
    parametersSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "UUID for kunden." },
      },
      required: ["customerId"],
      additionalProperties: false,
    },
  },

  // === 3. Create draft reply ===
  {
    name: "kundeoversikt_create_draft_reply",
    description:
      "Opprett svar-utkast som venter på Tores godkjenning. " +
      "INGEN e-post sendes uten godkjenning.",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Mottaker-e-poster." },
        subject: { type: "string", description: "Emne (typisk 'Sv: <original>')." },
        bodyHtml: { type: "string", description: "HTML-svar med <p>-tagger." },
        replyToEmailLogId: { type: "string", description: "UUID for e-posten dette svarer på." },
        customerId: { type: "string", description: "UUID for kunden (valgfri)." },
        aiReasoning: { type: "string", description: "Begrunnelse for svaret — vises til Tore." },
        aiConfidence: { type: "number", description: "Konfidens 0.0-1.0.", minimum: 0, maximum: 1 },
      },
      required: ["to", "subject", "bodyHtml", "replyToEmailLogId", "aiReasoning", "aiConfidence"],
      additionalProperties: false,
    },
  },

  // === 4. Classify email (Fase 2) ===
  {
    name: "kundeoversikt_classify_email",
    description:
      "Klassifiser en e-post etter innholdstype. Kall dette for HVER e-post du behandler. " +
      "Typer: 'prospect' (ny kundehenvendelse), 'bilag' (faktura/kvittering), " +
      "'sporsmal' (spørsmål fra kunde), 'system' (automatisk melding), 'annet'.",
    parametersSchema: {
      type: "object",
      properties: {
        emailLogId: { type: "string", description: "UUID for e-posten." },
        contentCategory: {
          type: "string",
          enum: ["prospect", "bilag", "sporsmal", "system", "annet"],
          description: "Innholdstype.",
        },
        confidence: { type: "number", description: "Konfidens 0.0-1.0.", minimum: 0, maximum: 1 },
        summary: { type: "string", description: "1-2 setningers oppsummering av e-posten." },
        recommendedAction: { type: "string", description: "Anbefalt handling (f.eks. 'route_to_kundebehandler', 'draft_reply', 'skip')." },
      },
      required: ["emailLogId", "contentCategory", "confidence", "summary"],
      additionalProperties: false,
    },
  },

  // === 5. Log action (Fase 1 — allerede deployet) ===
  {
    name: "kundeoversikt_log_action",
    description:
      "Logg en handling i Kundeoversikt (POST /api/agent/actions). " +
      "Brukes for sporbarhet og audit-trail. " +
      "Logg ALLE handlinger: klassifisering, prospect-opprettelse, routing, draft-opprettelse. " +
      "Bruk emailLogId og customerId fra listen over ubehandlede e-poster.",
    parametersSchema: {
      type: "object",
      properties: {
        actionType: { type: "string", description: "Type handling: 'classify_email', 'create_prospect', 'route_to_agent', 'draft_reply', 'skip_system_email'." },
        actionSummary: { type: "string", description: "Menneskelig lesbar beskrivelse av handlingen (1-2 setninger)." },
        emailLogId: { type: "string", description: "UUID for e-posten som handlingen gjelder. Hentes fra emailLogId i list_unprocessed_emails." },
        customerId: { type: "string", description: "UUID for kunden. Hentes fra customerId i list_unprocessed_emails." },
        resultStatus: { type: "string", description: "Status: completed, failed, eller skipped." },
        actionDetails: { type: "object", description: "Valgfri: ekstra strukturert data om handlingen (nøkkel-verdi)." },
        prospectId: { type: "string", description: "Valgfri: UUID for prospect (kun ved prospect-relaterte handlinger)." },
      },
      required: ["actionType", "actionSummary", "emailLogId", "customerId", "resultStatus"],
      additionalProperties: false,
    },
  },

  // === 6. Create prospect (Fase 3) ===
  {
    name: "kundeoversikt_create_prospect",
    description:
      "Opprett en prospect (potensiell ny kunde) i Kundeoversikt. " +
      "Ekstraher info fra e-posten: firmanavn, orgnummer, kontakt-epost, telefon, behov. " +
      "Kundeoversikt kjører automatisk BRREG-oppslag og sanksjonssjekk.",
    parametersSchema: {
      type: "object",
      properties: {
        companyName: { type: "string", description: "Firmanavn (fra e-post/signatur)." },
        orgNumber: { type: "string", description: "9-sifret norsk orgnummer (hvis funnet)." },
        contactEmail: { type: "string", description: "Kontaktpersonens e-post." },
        contactPhone: { type: "string", description: "Telefonnummer (hvis funnet)." },
        contactName: { type: "string", description: "Kontaktpersonens navn." },
        needsDescription: { type: "string", description: "Hva kunden trenger (regnskap, lønn, MVA, etc.)." },
        sourceEmailLogId: { type: "string", description: "UUID for e-posten som utløste dette." },
      },
      required: ["contactEmail", "sourceEmailLogId"],
      additionalProperties: false,
    },
  },

  // === 7. Get prospect ===
  {
    name: "kundeoversikt_get_prospect",
    description: "Hent en prospect med sjekk-resultater og anbefaling.",
    parametersSchema: {
      type: "object",
      properties: {
        prospectId: { type: "string", description: "UUID for prospect." },
      },
      required: ["prospectId"],
      additionalProperties: false,
    },
  },

  // === 8. List prospects ===
  {
    name: "kundeoversikt_list_prospects",
    description: "List prospects filtrert på status.",
    parametersSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["new", "checking", "ready", "converted", "rejected"], description: "Status-filter." },
        limit: { type: "integer", description: "Maks antall (standard 20).", minimum: 1, maximum: 100 },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // === 9. Get draft feedback ===
  {
    name: "kundeoversikt_get_draft_feedback",
    description:
      "Hent Tores tidligere redigeringer av agent-utkast. " +
      "Bruk dette FØR create_draft_reply for å tilpasse tone og stil.",
    parametersSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "UUID for kunden (valgfri)." },
        contentCategory: { type: "string", description: "Innholdstype-filter (valgfri)." },
        limit: { type: "integer", description: "Maks antall (standard 5).", minimum: 1, maximum: 50 },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // === 10. List pending bookkeeping revisions ===
  // LLM-skjemaet bruker camelCase for konsistens med øvrige tools,
  // men HTTP-kontrakten mot serveren bruker snake_case i query/body.
  {
    name: "kundeoversikt_list_pending_revisions",
    description:
      "List bokføringssaker i needs_revision for én organisasjon og ett selskap. " +
      "Returnerer kun saker som fortsatt kan revideres maskinelt.",
    parametersSchema: {
      type: "object",
      properties: {
        organizationId: { type: "string", description: "Kundeoversikt organization_id." },
        companySlug: { type: "string", description: "Fiken company slug for saken." },
        offset: { type: "integer", description: "Offset for paginering (standard 0).", minimum: 0, default: 0 },
        limit: { type: "integer", description: "Maks antall (standard 5, maks 20).", minimum: 1, maximum: 20 },
      },
      required: ["organizationId", "companySlug"],
      additionalProperties: false,
    },
  },

  // === 11. Get bookkeeping feedback ===
  {
    name: "kundeoversikt_get_bookkeeping_feedback",
    description:
      "Hent few-shot-eksempler for bokføring på kundenivå. " +
      "Brukes før ny revisjon sendes inn.",
    parametersSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Kunde-ID som feedback skal hentes for." },
        organizationId: { type: "string", description: "Kundeoversikt organization_id." },
        expandToOrg: {
          type: "boolean",
          description: "Må være false. Endepunktet returnerer 400 for andre verdier.",
          default: false,
        },
        limit: { type: "integer", description: "Maks antall (standard 5, maks 20 på tool-nivå).", minimum: 1, maximum: 20 },
      },
      required: ["customerId", "organizationId"],
      additionalProperties: false,
    },
  },

  // === 12. Submit bookkeeping revision ===
  {
    name: "kundeoversikt_submit_bookkeeping_revision",
    description:
      "Send et revidert bokføringsforslag tilbake på et needs_revision-køelement. " +
      "Kontrakten krever company_slug i body, derfor eksponeres companySlug eksplisitt her.",
    parametersSchema: {
      type: "object",
      properties: {
        queueId: { type: "string", description: "bookkeeping_queue.id som skal revideres." },
        organizationId: { type: "string", description: "Kundeoversikt organization_id." },
        companySlug: { type: "string", description: "Fiken company slug som må matche organizationId." },
        customerId: { type: "string", description: "Valgfri customer_id hvis agenten kjenner den." },
        fikenPayload: { type: "object", description: "Revidert Fiken-payload." },
        aiReasoning: { type: "string", description: "Hvorfor revisjonen er riktig." },
        aiConfidence: { type: "number", description: "Konfidens mellom 0 og 1.", minimum: 0, maximum: 1 },
        actorName: {
          type: "string",
          description: "Aktor-navn som sendes som actor_name i kontrakten.",
          default: "paperclip-regnskapsforer",
        },
        transactionDesc: { type: "string", description: "Valgfri transaksjonsbeskrivelse." },
        suggestedAccount: { type: "string", description: "Valgfri foreslått konto." },
      },
      required: ["queueId", "organizationId", "companySlug", "fikenPayload", "aiReasoning", "aiConfidence"],
      additionalProperties: false,
    },
  },

  // === 13. Upsert email summary ===
  {
    name: "kundeoversikt_upsert_email_summary",
    description:
      "Opprett eller oppdater sammendrag for en e-posttråd. " +
      "Kall dette etter klassifisering eller etter at svar er sendt.",
    parametersSchema: {
      type: "object",
      properties: {
        graphConversationId: { type: "string", description: "graph_conversation_id fra e-posten." },
        customerId: { type: "string", description: "UUID for kunden (valgfri)." },
        summaryText: { type: "string", description: "Kort oppsummering av tråden." },
        status: { type: "string", description: "Presis status, f.eks. 'Venter på svar fra Daniel Herigstad (Nextify Media)'." },
        keyPoints: { type: "array", items: { type: "string" }, description: "Nøkkelpunkter fra samtalen." },
        messageCount: { type: "integer", description: "Totalt antall meldinger i tråden.", minimum: 1 },
        lastMessageId: { type: "string", description: "ID for siste melding." },
      },
      required: ["graphConversationId", "summaryText", "status", "keyPoints", "messageCount", "lastMessageId"],
      additionalProperties: false,
    },
  },
  // === 14. Submit morning summary ===
  {
    name: "kundeoversikt_submit_morning_summary",
    description:
      "Send morgenresymé til Kundeoversikt. Kalles av scheduler kl 07:00. " +
      "Oppsummerer siste 24 timers e-postbehandling, ventende utkast, og viktige hendelser.",
    parametersSchema: {
      type: "object",
      properties: {
        contentMarkdown: { type: "string", description: "Markdown-formatert resymé." },
        highlightsJson: {
          type: "object",
          description: "Strukturert data for morgenresymé-widget.",
          properties: {
            mailsProcessed24h: { type: "integer", description: "Antall e-poster prosessert siste 24 timer." },
            draftsWaiting: { type: "integer", description: "Antall utkast som venter på godkjenning." },
            unprocessedNow: { type: "integer", description: "Antall ubehandlede e-poster akkurat nå." },
            deadlines7d: { type: "array", items: { type: "string" }, description: "Frister neste 7 dager (tom liste hvis ingen)." },
            warnings: { type: "array", items: { type: "string" }, description: "Advarsler (tom liste hvis ingen)." },
          },
          required: ["mailsProcessed24h", "draftsWaiting", "unprocessedNow", "deadlines7d", "warnings"],
        },
      },
      required: ["contentMarkdown", "highlightsJson"],
      additionalProperties: false,
    },
  },

  // === 15. Upsert knowledge-note draft (krav-engine for læringsloop) ===
  {
    name: "kundeoversikt_upsert_knowledge_note_draft",
    description:
      "Lag eller oppdater et utkast til en kunnskapsnote for en kunde. " +
      "Brukes når agenten oppdager mønster (regnskapsregel, kundeunntak, " +
      "leverandør-mapping, MVA-regel, tone-preferanse, stop-regel, " +
      "compliance-regel) og trenger å lagre det. " +
      "ALLE drafts venter på Tores godkjenning før de tas i bruk. " +
      "Sett basedOnRevisionId hvis du bygger videre på et eksisterende utkast " +
      "(unngår STALE_DRAFT 409). Organisasjonen hentes fra env, " +
      "så IKKE send organizationId.",
    parametersSchema: {
      type: "object",
      properties: {
        customerId: {
          type: "string",
          description: "UUID for kunden noten gjelder. Må tilhøre vår organisasjon.",
        },
        customerSlug: {
          type: "string",
          description: "Kunde-slug (1-120 tegn).",
          minLength: 1,
          maxLength: 120,
        },
        noteKey: {
          type: "string",
          description:
            "Stabil nøkkel for noten (1-200 tegn). Unik per (org, customer). " +
            "Brukes til upsert-logikken.",
          minLength: 1,
          maxLength: 200,
        },
        noteType: {
          type: "string",
          enum: [...KNOWLEDGE_NOTE_TYPES],
          description: "Notetype.",
        },
        title: {
          type: "string",
          description: "Tittel (1-200 tegn).",
          minLength: 1,
          maxLength: 200,
        },
        contentMd: {
          type: "string",
          description: "Markdown-innhold for noten (minst 1 tegn).",
          minLength: 1,
        },
        content: {
          type: "object",
          description: "Strukturert innhold for noten.",
          properties: {
            scope: { type: "string", enum: ["customer"], description: "Må være 'customer'." },
            trigger: { type: "string", description: "Når regelen utløses." },
            action: { type: "string", description: "Hva som skal skje." },
            source: { type: "string", description: "Hvor regelen kommer fra (f.eks. 'feedback fra Tore')." },
            example: { type: "string", description: "Valgfritt eksempel." },
          },
          required: ["scope", "trigger", "action", "source"],
        },
        rationale: {
          type: "string",
          description: "Hvorfor utkastet er riktig (1-4000 tegn).",
          minLength: 1,
          maxLength: 4000,
        },
        confidence: {
          type: "number",
          description: "Konfidens 0-1.",
          minimum: 0,
          maximum: 1,
        },
        idempotencyKey: {
          type: "string",
          description:
            "Valgfri. Hvis utelatt, bygges deterministisk fra " +
            "sha256(runId:customerId:noteKey).slice(0,32).",
          minLength: 1,
          maxLength: 200,
        },
        basedOnRevisionId: {
          type: "string",
          description: "UUID for forrige revisjon (anbefales for STALE_DRAFT-unngåelse).",
        },
        modelVersion: { type: "string", description: "Modellversjon (sporing)." },
        promptVersion: { type: "string", description: "Promptversjon (sporing)." },
        sourceRefs: {
          type: "array",
          items: { type: "string" },
          description: "Referanser (URL/ID-er).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for kategorisering.",
        },
        traceId: { type: "string", description: "Sporings-ID for distribuert tracing." },
      },
      required: [
        "customerId",
        "customerSlug",
        "noteKey",
        "noteType",
        "title",
        "contentMd",
        "content",
        "rationale",
        "confidence",
      ],
      additionalProperties: false,
    },
  },
];

const KUNDEOVERSIKT_TOOL_NAMES = new Set(
  KUNDEOVERSIKT_TOOL_DEFINITIONS.map((tool) => tool.name),
);

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

function noteLegacyAlias(
  toolName: string,
  legacyField: string,
  canonicalField: string,
): string {
  const msg = `[LEGACY ALIAS] ${toolName}: felt "${legacyField}" normaliseres til "${canonicalField}". Bruk "${canonicalField}" neste gang for å unngå dette.`;
  console.log(msg);
  return msg;
}

export async function executeKundeoversiktTool(
  toolName: string,
  args: Record<string, unknown>,
  callContext?: KundeoversiktCallContext,
): Promise<unknown> {
  // Establish per-call JWT context. Synchronous because tool execution is
  // single-flight per agent run within executeKundeoversiktTool.
  const previousCtx = currentCallContext;
  const previousTool = currentToolName;
  currentCallContext = callContext ?? null;
  currentToolName = toolName;
  try {
    return await runKundeoversiktTool(toolName, args);
  } finally {
    currentCallContext = previousCtx;
    currentToolName = previousTool;
  }
}

async function runKundeoversiktTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "kundeoversikt_list_unprocessed_emails": {
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const raw = await agentFetch(
        `/emails/unprocessed?organizationId=${orgId()}&limit=${limit}&excludeClassificationMethods=rule_firma_sender`,
      ) as Record<string, unknown>;
      if (raw.emails && Array.isArray(raw.emails)) {
        raw.emails = (raw.emails as Array<Record<string, unknown>>).map((e) => ({
          emailLogId: e.id,
          subject: e.subject,
          bodyText: typeof e.bodyText === "string" ? (e.bodyText as string).slice(0, 2000) : "",
          from: e.from,
          fromName: e.fromName,
          receivedAt: e.receivedAt,
          customerId: e.customerId,
          customerName: e.customerName,
          graphConversationId: e.graphConversationId,
          hasAttachments: e.hasAttachments,
          classificationMethod: e.classificationMethod,
        }));
      }
      return raw;
    }

    case "kundeoversikt_get_customer_context": {
      const customerId = args.customerId as string;
      if (!customerId) return { error: "customerId er påkrevd" };
      return agentFetch(`/customers/${customerId}/context?organizationId=${orgId()}`);
    }

    case "kundeoversikt_create_draft_reply": {
      let bodyHtml =
        typeof args.bodyHtml === "string" ? args.bodyHtml : undefined;

      if (!bodyHtml && typeof args.content === "string") {
        noteLegacyAlias(
          "kundeoversikt_create_draft_reply",
          "content",
          "bodyHtml",
        );
        bodyHtml = args.content;
      }
      if (!bodyHtml && typeof args.body === "string") {
        noteLegacyAlias(
          "kundeoversikt_create_draft_reply",
          "body",
          "bodyHtml",
        );
        bodyHtml = args.body;
      }
      if (!bodyHtml && typeof args.html === "string") {
        noteLegacyAlias(
          "kundeoversikt_create_draft_reply",
          "html",
          "bodyHtml",
        );
        bodyHtml = args.html;
      }

      // Auto-wrap rent tekst-innhold i <p>-tagger så backend er fornøyd
      if (bodyHtml && !bodyHtml.includes("<")) {
        bodyHtml = bodyHtml
          .split(/\n{2,}/)
          .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
          .join("");
      }

      // Godta "to" som string eller array — normaliser til array
      let toArray: string[] | undefined;
      if (Array.isArray(args.to)) {
        toArray = args.to.filter((x): x is string => typeof x === "string");
      } else if (typeof args.to === "string") {
        toArray = [args.to];
      }

      // replyToEmailLogId default til emailLogId hvis den finnes
      const replyToEmailLogId =
        typeof args.replyToEmailLogId === "string"
          ? args.replyToEmailLogId
          : typeof args.emailLogId === "string"
          ? args.emailLogId
          : undefined;

      const aiReasoning =
        typeof args.aiReasoning === "string" && args.aiReasoning.trim().length >= 20
          ? args.aiReasoning
          : undefined;
      const aiConfidence =
        typeof args.aiConfidence === "number" &&
        args.aiConfidence >= 0 &&
        args.aiConfidence <= 1
          ? args.aiConfidence
          : undefined;

      if (
        !toArray ||
        toArray.length === 0 ||
        !args.subject ||
        !bodyHtml ||
        !replyToEmailLogId ||
        !aiReasoning ||
        aiConfidence === undefined
      ) {
        return {
          error:
            'kundeoversikt_create_draft_reply krever ALLE disse feltene: ' +
            '"to" (array), "subject" (string), "bodyHtml" (HTML-tekst), ' +
            '"replyToEmailLogId" (samme UUID som emailLogId fra originalen), ' +
            '"aiReasoning" (minst 20 tegn — forklar Tore HVORFOR du foreslår dette svaret), ' +
            '"aiConfidence" (tall mellom 0 og 1). ' +
            'Bruk ikke "content" eller "body" — bruk "bodyHtml".',
        };
      }

      return agentFetch("/drafts", {
        method: "POST",
        body: JSON.stringify({
          organizationId: orgId(),
          agentName: "paperclip-email-assistant",
          to: toArray,
          cc: [],
          subject: args.subject,
          bodyHtml,
          customerId:
            typeof args.customerId === "string" && args.customerId.trim().length > 0
              ? args.customerId
              : null,
          replyToEmailLogId,
          aiReasoning,
          aiConfidence,
        }),
      });
    }

    case "kundeoversikt_classify_email": {
      const validContentCategories = [
        "prospect",
        "bilag",
        "sporsmal",
        "system",
        "annet",
      ] as const;

      const emailLogId =
        typeof args.emailLogId === "string" ? args.emailLogId : undefined;
      if (!emailLogId) return { error: "emailLogId er påkrevd" };

      let contentCategory =
        typeof args.contentCategory === "string"
          ? args.contentCategory
          : undefined;

      if (!contentCategory && typeof args.classification === "string") {
        noteLegacyAlias(
          "kundeoversikt_classify_email",
          "classification",
          "contentCategory",
        );
        contentCategory = args.classification;
      }

      if (!contentCategory && typeof args.category === "string") {
        noteLegacyAlias(
          "kundeoversikt_classify_email",
          "category",
          "contentCategory",
        );
        contentCategory = args.category;
      }

      if (
        !contentCategory ||
        !validContentCategories.includes(
          contentCategory as (typeof validContentCategories)[number],
        )
      ) {
        return {
          error:
            `contentCategory mangler eller er ugyldig. ` +
            `Gyldige verdier: ${validContentCategories.join(", ")}. ` +
            `Bruk feltet "contentCategory" (ikke "classification" eller "category").`,
        };
      }

      return agentFetch(`/emails/${emailLogId}/classify`, {
        method: "PATCH",
        body: JSON.stringify({
          organizationId: orgId(),
          actorName: "paperclip-email-assistant",
          contentCategory,
          confidence: args.confidence,
          summary: args.summary,
          recommendedAction: args.recommendedAction,
        }),
      });
    }

    case "kundeoversikt_log_action": {
      let actionType =
        typeof args.actionType === "string" ? args.actionType : undefined;

      if (!actionType && typeof args.action === "string") {
        noteLegacyAlias(
          "kundeoversikt_log_action",
          "action",
          "actionType",
        );
        actionType = args.action;
      }

      let actionSummary =
        typeof args.actionSummary === "string"
          ? args.actionSummary
          : undefined;

      if (!actionSummary && typeof args.details === "string") {
        noteLegacyAlias(
          "kundeoversikt_log_action",
          "details",
          "actionSummary",
        );
        actionSummary = args.details;
      }

      if (!actionType || !actionSummary) {
        return {
          error:
            'kundeoversikt_log_action krever "actionType" og "actionSummary". ' +
            'Bruk ikke "action" eller "details".',
        };
      }

      const customerId =
        typeof args.customerId === "string" && args.customerId.trim().length > 0
          ? args.customerId
          : undefined;

      return agentFetch("/actions", {
        method: "POST",
        body: JSON.stringify({
          organizationId: orgId(),
          actorName: "paperclip-email-assistant",
          actionType,
          actionSummary,
          emailLogId: args.emailLogId,
          customerId,
          resultStatus: args.resultStatus ?? "completed",
          actionDetails: args.actionDetails ?? undefined,
          prospectId: args.prospectId ?? undefined,
        }),
      });
    }

    case "kundeoversikt_create_prospect": {
      return agentFetch("/prospects", {
        method: "POST",
        body: JSON.stringify({
          organizationId: orgId(),
          actorName: "paperclip-email-assistant",
          companyName: args.companyName ?? null,
          orgNumber: args.orgNumber ?? null,
          contactEmail: args.contactEmail,
          contactPhone: args.contactPhone ?? null,
          contactName: args.contactName ?? null,
          needsDescription: args.needsDescription ?? null,
          sourceEmailLogId: args.sourceEmailLogId ?? null,
        }),
      });
    }

    case "kundeoversikt_get_prospect": {
      const prospectId = args.prospectId as string;
      if (!prospectId) return { error: "prospectId er påkrevd" };
      return agentFetch(`/prospects/${prospectId}?organizationId=${orgId()}`);
    }

    case "kundeoversikt_list_prospects": {
      const status = typeof args.status === "string" ? `&status=${args.status}` : "";
      const limit = typeof args.limit === "number" ? args.limit : 20;
      return agentFetch(`/prospects?organizationId=${orgId()}&limit=${limit}${status}`);
    }


    case "kundeoversikt_get_draft_feedback": {
      const params = new URLSearchParams();
      params.set("organizationId", orgId());
      if (typeof args.customerId === "string") params.set("customerId", args.customerId);
      if (typeof args.contentCategory === "string") params.set("contentCategory", args.contentCategory);
      const limit = typeof args.limit === "number" ? args.limit : 5;
      params.set("limit", String(limit));
      return agentFetch(`/draft-feedback?${params.toString()}`);
    }

    case "kundeoversikt_list_pending_revisions": {
      const organizationId = requireUuid(
        readStringArg(args, "organizationId", "organization_id"),
        "organizationId",
      );
      if (typeof organizationId !== "string") {
        return organizationId;
      }

      const companySlug = readStringArg(args, "companySlug", "company_slug");
      if (!companySlug) {
        return invalidArguments("companySlug er påkrevd.");
      }

      const offset = normalizeOffset(readNumberArg(args, "offset"), 0);
      const limit = normalizeLimit(readNumberArg(args, "limit"), {
        defaultValue: 5,
        maxValue: 20,
      });

      const params = new URLSearchParams();
      params.set("status", "needs_revision");
      params.set("organization_id", organizationId);
      params.set("company_slug", companySlug);
      params.set("offset", String(offset));
      params.set("limit", String(limit));

      const response = await agentBookkeepingFetch(`/bookkeeping/queue?${params.toString()}`);
      if ("error" in response) return response;

      warnOnUnexpectedContractVersion(toolName, response.headers);

      const syntheticResponse = new Response(null, {
        status: response.status,
        headers: response.headers,
      });
      await applyRateLimitBackoff(toolName, syntheticResponse);

      if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 500) {
        return normalizeErrorResponse(
          response.body,
          `Kunne ikke hente bokføringskø (HTTP ${response.status})`,
        );
      }

      if (response.status !== 200) {
        return normalizeErrorResponse(
          response.body,
          `Uventet svar fra bokføringskø (HTTP ${response.status})`,
        );
      }

      if (!isRecord(response.body)) {
        return normalizeErrorResponse(null, "Kunne ikke tolke svar fra bokføringskø.", "INVALID_RESPONSE");
      }

      const items = Array.isArray((response.body as PendingRevisionListResponse).items)
        ? ((response.body as PendingRevisionListResponse).items as PendingRevision[])
        : [];

      const filteredItems = items.filter((item): item is PendingRevision => {
        if (item == null || typeof item !== "object") {
          return false;
        }

        const revisionItem = item as PendingRevision;
        if (revisionItem.status === "needs_human_escalation") {
          console.warn(
            `[kundeoversikt] ${toolName}: filtrerer ut sak ${revisionItem.id} med status needs_human_escalation.`,
          );
          return false;
        }
        return revisionItem.status === "needs_revision";
      });

      return filteredItems;
    }

    case "kundeoversikt_get_bookkeeping_feedback": {
      const customerId = requireUuid(
        readStringArg(args, "customerId", "customer_id"),
        "customerId",
      );
      if (typeof customerId !== "string") {
        return customerId;
      }

      const organizationId = requireUuid(
        readStringArg(args, "organizationId", "organization_id"),
        "organizationId",
      );
      if (typeof organizationId !== "string") {
        return organizationId;
      }

      if (args.expandToOrg !== undefined && args.expandToOrg !== false) {
        return invalidArguments("expandToOrg må være false for dette endepunktet.");
      }

      const suppressUntilMs = learningDisabledSuppress.get(organizationId);
      if (suppressUntilMs !== undefined && suppressUntilMs > Date.now()) {
        return [];
      }

      // Kontrakten tillater maks 10, selv om MCP-laget gjerne kan foreslå høyere.
      const limit = normalizeLimit(readNumberArg(args, "limit"), {
        defaultValue: 5,
        maxValue: 10,
      });

      const params = new URLSearchParams();
      // Tool-skjemaet er camelCase, men HTTP-kontrakten krever snake_case.
      params.set("customer_id", customerId);
      params.set("organization_id", organizationId);
      params.set("expand_to_org", "false");
      params.set("limit", String(limit));

      const response = await agentBookkeepingFetch(`/bookkeeping/feedback-examples?${params.toString()}`);
      if ("error" in response) return response;

      warnOnUnexpectedContractVersion(toolName, response.headers);

      const syntheticResponse = new Response(null, {
        status: response.status,
        headers: response.headers,
      });
      await applyRateLimitBackoff(toolName, syntheticResponse);

      if (response.status === 409) {
        const normalized = normalizeErrorResponse(
          response.body,
          "Learning loop er deaktivert for denne organisasjonen",
        );
        if (normalized.code === "LEARNING_DISABLED") {
          learningDisabledSuppress.set(
            organizationId,
            Date.now() + LEARNING_DISABLED_SUPPRESS_MS,
          );
          console.info(
            `[kundeoversikt] learning_disabled_skipped customerId=${customerId} organizationId=${organizationId}`,
          );
          return [];
        }
        return normalized;
      }

      learningDisabledSuppress.delete(organizationId);

      if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 500) {
        return normalizeErrorResponse(
          response.body,
          `Kunne ikke hente feedback-eksempler (HTTP ${response.status})`,
        );
      }

      if (response.status !== 200) {
        return normalizeErrorResponse(
          response.body,
          `Uventet svar fra feedback-eksempler (HTTP ${response.status})`,
        );
      }

      if (!isRecord(response.body)) {
        return normalizeErrorResponse(null, "Kunne ikke tolke svar fra feedback-eksempler.", "INVALID_RESPONSE");
      }

      const examples = Array.isArray((response.body as BookkeepingFeedbackResponse).examples)
        ? ((response.body as BookkeepingFeedbackResponse).examples as BookkeepingFeedbackExample[])
        : [];

      return examples;
    }

    case "kundeoversikt_submit_bookkeeping_revision": {
      const queueId = requireUuid(
        readStringArg(args, "queueId", "queue_id"),
        "queueId",
      );
      if (typeof queueId !== "string") {
        return queueId;
      }

      const organizationId = requireUuid(
        readStringArg(args, "organizationId", "organization_id"),
        "organizationId",
      );
      if (typeof organizationId !== "string") {
        return organizationId;
      }

      const companySlug = readStringArg(args, "companySlug", "company_slug");
      if (!companySlug) {
        return invalidArguments("companySlug er påkrevd fordi kontrakten krever company_slug i request body.");
      }

      const payloadOrError = ensureObjectPayload(args.fikenPayload ?? args.fiken_payload);
      if (!payloadOrError) {
        return invalidArguments("fikenPayload må være et objekt.");
      }
      if (!hasValidFikenPayloadShape(payloadOrError)) {
        return invalidArguments("fikenPayload må inneholde date og lines med minst ett element.");
      }

      const aiReasoning = readStringArg(args, "aiReasoning", "ai_reasoning");
      if (!aiReasoning) {
        return invalidArguments("aiReasoning er påkrevd.");
      }

      const aiConfidence = readNumberArg(args, "aiConfidence", "ai_confidence");
      if (aiConfidence === undefined) {
        return invalidArguments("aiConfidence er påkrevd.");
      }
      if (aiConfidence !== undefined && (aiConfidence < 0 || aiConfidence > 1)) {
        return invalidArguments("aiConfidence må være mellom 0 og 1.");
      }

      const actorName = readStringArg(args, "actorName", "actor_name") ?? "paperclip-regnskapsforer";
      if (actorName.trim().length === 0) {
        return invalidArguments("actorName kan ikke være tom.");
      }

      // Tool-skjemaet er camelCase, men request-body følger serverkontraktens snake_case.
      const body: JsonObject = {
        organization_id: organizationId,
        company_slug: companySlug,
        fiken_payload: payloadOrError,
        ai_reasoning: aiReasoning,
        actor_name: actorName,
      };

      const customerId = readStringArg(args, "customerId", "customer_id");
      if (customerId) {
        if (!isUuid(customerId)) {
          return invalidArguments("customerId må være en gyldig UUID");
        }
        body.customer_id = customerId;
      }

      body.ai_confidence = aiConfidence;

      const transactionDesc = readStringArg(args, "transactionDesc", "transaction_desc");
      if (transactionDesc) body.transaction_desc = transactionDesc;

      const suggestedAccount = readStringArg(args, "suggestedAccount", "suggested_account");
      if (suggestedAccount) body.suggested_account = suggestedAccount;

      const idempotencyKey = getOrCreateIdempotencyKey(queueId, body);
      const response = await agentBookkeepingFetch(
        `/bookkeeping/queue/${encodeURIComponent(queueId)}/revision-result`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(body),
        },
      );
      if ("error" in response) return response;

      warnOnUnexpectedContractVersion(toolName, response.headers);

      const syntheticResponse = new Response(null, {
        status: response.status,
        headers: response.headers,
      });
      await applyRateLimitBackoff(toolName, syntheticResponse);

      if (response.status === 409) {
        const normalized = normalizeErrorResponse(
          response.body,
          "Saken kan ikke revideres akkurat nå.",
        );
        if (normalized.code === "COMPLIANCE_CASE_OPEN") {
          return {
            ...normalized,
            retry_after: "Etter at compliance-saken er lukket.",
          };
        }
        return normalized;
      }

      if (response.status === 422) {
        return normalizeErrorResponse(
          response.body,
          "Saken er eskalert til menneskelig behandling.",
        );
      }

      if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 500) {
        return normalizeErrorResponse(
          response.body,
          `Kunne ikke lagre revidert bokføringsforslag (HTTP ${response.status})`,
        );
      }

      if (response.status !== 200) {
        return normalizeErrorResponse(
          response.body,
          `Uventet svar fra revision-result (HTTP ${response.status})`,
        );
      }

      if (!isRecord(response.body)) {
        return normalizeErrorResponse(null, "Kunne ikke tolke svar fra revision-result.", "INVALID_RESPONSE");
      }

      const resultBody = response.body as RevisionSubmissionResponse;
      if (!isRecord(resultBody.item)) {
        return normalizeErrorResponse(null, "Manglet item i revision-result.", "INVALID_RESPONSE");
      }

      return {
        ...resultBody.item,
        idempotent_replay: resultBody.idempotent_replay === true,
      };
    }

    case "kundeoversikt_upsert_email_summary": {
      let graphConversationId =
        typeof args.graphConversationId === "string"
          ? args.graphConversationId
          : undefined;

      if (!graphConversationId && typeof args.conversationId === "string") {
        noteLegacyAlias(
          "kundeoversikt_upsert_email_summary",
          "conversationId",
          "graphConversationId",
        );
        graphConversationId = args.conversationId;
      }

      if (!graphConversationId) {
        return {
          error:
            'graphConversationId er påkrevd. Bruk feltet "graphConversationId" (ikke "conversationId").',
        };
      }

      let summaryText =
        typeof args.summaryText === "string" ? args.summaryText : undefined;

      if (!summaryText && typeof args.summary === "string") {
        noteLegacyAlias(
          "kundeoversikt_upsert_email_summary",
          "summary",
          "summaryText",
        );
        summaryText = args.summary;
      }

      let lastMessageId =
        typeof args.lastMessageId === "string"
          ? args.lastMessageId
          : undefined;

      if (!lastMessageId && typeof args.lastEmailId === "string") {
        noteLegacyAlias(
          "kundeoversikt_upsert_email_summary",
          "lastEmailId",
          "lastMessageId",
        );
        lastMessageId = args.lastEmailId;
      }

      if (!summaryText) {
        return {
          error:
            'kundeoversikt_upsert_email_summary krever "summaryText" (kort oppsummering av e-posttråden, minst 10 tegn).',
        };
      }

      const status =
        typeof args.status === "string" && args.status.trim().length > 0
          ? args.status
          : "active";
      const keyPoints = Array.isArray(args.keyPoints)
        ? args.keyPoints.filter((x): x is string => typeof x === "string")
        : [];
      const messageCount =
        typeof args.messageCount === "number" && args.messageCount > 0
          ? args.messageCount
          : 1;

      return agentFetch("/email-summaries", {
        method: "POST",
        body: JSON.stringify({
          organizationId: orgId(),
          graphConversationId,
          customerId:
            typeof args.customerId === "string" && args.customerId.trim().length > 0
              ? args.customerId
              : null,
          summaryText,
          status,
          keyPoints,
          messageCount,
          lastMessageId: lastMessageId ?? null,
        }),
      });
    }


    case "kundeoversikt_submit_morning_summary": {
      const contentMarkdown =
        typeof args.contentMarkdown === "string" ? args.contentMarkdown : undefined;
      if (!contentMarkdown) {
        return {
          error:
            'kundeoversikt_submit_morning_summary krever "contentMarkdown" (Markdown-formatert resymé).',
        };
      }

      const rawHighlights = args.highlightsJson as Record<string, unknown> | undefined;
      if (!rawHighlights || typeof rawHighlights !== "object" || Array.isArray(rawHighlights)) {
        return {
          error:
            'kundeoversikt_submit_morning_summary krever "highlightsJson" (objekt med mailsProcessed24h, draftsWaiting, unprocessedNow, deadlines7d, warnings).',
        };
      }

      // Normalize common LLM field-name mistakes
      const fieldAliases: Record<string, string> = {
        unprocessed_emails: "unprocessedNow",
        unprocessed: "unprocessedNow",
        pending_drafts: "draftsWaiting",
        pendingDrafts: "draftsWaiting",
        new_prospects: "warnings",
        mails_processed: "mailsProcessed24h",
        mailsProcessed: "mailsProcessed24h",
        processed24h: "mailsProcessed24h",
        drafts_waiting: "draftsWaiting",
        deadlines: "deadlines7d",
      };
      const highlightsJson: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawHighlights)) {
        const canonical = fieldAliases[k] ?? k;
        if (canonical !== k) {
          noteLegacyAlias("kundeoversikt_submit_morning_summary", k, canonical);
        }
        highlightsJson[canonical] = v;
      }
      // Ensure required fields exist with defaults
      highlightsJson.mailsProcessed24h ??= 0;
      highlightsJson.draftsWaiting ??= 0;
      highlightsJson.unprocessedNow ??= 0;
      highlightsJson.deadlines7d ??= [];
      highlightsJson.warnings ??= [];

      const runId = crypto.randomUUID();

      return agentFetch("/morning-summary", {
        method: "POST",
        body: JSON.stringify({
          organizationId: orgId(),
          runId,
          contentMarkdown,
          highlightsJson,
          generatedAtUtc: new Date().toISOString(),
        }),
      });
    }

    case "kundeoversikt_upsert_knowledge_note_draft": {
      // --- Required string fields with manual validation (consistent with
      // existing tools — pakken har ikke zod som dependency) ---
      const customerId = readStringArg(args, "customerId", "customer_id");
      if (!customerId) return invalidArguments("customerId er påkrevd.");
      if (!isUuid(customerId)) {
        return invalidArguments("customerId må være en gyldig UUID.");
      }

      const customerSlug = readStringArg(args, "customerSlug", "customer_slug");
      if (!customerSlug) return invalidArguments("customerSlug er påkrevd.");
      if (customerSlug.length > 120) {
        return invalidArguments("customerSlug må være maks 120 tegn.");
      }

      const noteKey = readStringArg(args, "noteKey", "note_key");
      if (!noteKey) return invalidArguments("noteKey er påkrevd.");
      if (noteKey.length > 200) {
        return invalidArguments("noteKey må være maks 200 tegn.");
      }

      const noteType = readStringArg(args, "noteType", "note_type");
      if (!noteType) return invalidArguments("noteType er påkrevd.");
      if (!(KNOWLEDGE_NOTE_TYPES as readonly string[]).includes(noteType)) {
        return invalidArguments(
          `noteType må være en av: ${KNOWLEDGE_NOTE_TYPES.join(", ")}.`,
        );
      }

      const title = readStringArg(args, "title");
      if (!title) return invalidArguments("title er påkrevd.");
      if (title.length > 200) {
        return invalidArguments("title må være maks 200 tegn.");
      }

      const contentMd = readStringArg(args, "contentMd", "content_md");
      if (!contentMd) return invalidArguments("contentMd er påkrevd.");

      const contentObj = ensureObjectPayload(args.content);
      if (!contentObj) {
        return invalidArguments("content må være et objekt.");
      }
      const scope = contentObj.scope;
      const trigger = contentObj.trigger;
      const action = contentObj.action;
      const source = contentObj.source;
      if (scope !== "customer") {
        return invalidArguments("content.scope må være 'customer'.");
      }
      if (typeof trigger !== "string" || trigger.trim().length === 0) {
        return invalidArguments("content.trigger er påkrevd.");
      }
      if (typeof action !== "string" || action.trim().length === 0) {
        return invalidArguments("content.action er påkrevd.");
      }
      if (typeof source !== "string" || source.trim().length === 0) {
        return invalidArguments("content.source er påkrevd.");
      }

      const rationale = readStringArg(args, "rationale");
      if (!rationale) return invalidArguments("rationale er påkrevd.");
      if (rationale.length > 4000) {
        return invalidArguments("rationale må være maks 4000 tegn.");
      }

      const confidence = readNumberArg(args, "confidence");
      if (confidence === undefined) {
        return invalidArguments("confidence er påkrevd.");
      }
      if (confidence < 0 || confidence > 1) {
        return invalidArguments("confidence må være mellom 0 og 1.");
      }

      // --- Deterministic idempotency key (caller may override) ---
      // Hvis caller ikke har gitt en, bygg fra runId + customerId + noteKey.
      // Vi trenger runId fra currentCallContext for å gjøre dette deterministisk
      // på tvers av retries innen samme run.
      const callerIdempotencyKey = readStringArg(
        args,
        "idempotencyKey",
        "idempotency_key",
      );
      let idempotencyKey: string;
      if (callerIdempotencyKey) {
        if (callerIdempotencyKey.length > 200) {
          return invalidArguments("idempotencyKey må være maks 200 tegn.");
        }
        idempotencyKey = callerIdempotencyKey;
      } else {
        const runIdForKey = currentCallContext?.runId ?? "no-run-id";
        idempotencyKey = computeKnowledgeNoteDraftIdempotencyKey(
          runIdForKey,
          customerId,
          noteKey,
        );
      }

      // --- organizationId injiseres ALLTID fra env, aldri fra args ---
      const organizationId = orgId();

      // --- Optional fields ---
      const basedOnRevisionId = readStringArg(
        args,
        "basedOnRevisionId",
        "based_on_revision_id",
      );
      const modelVersion = readStringArg(args, "modelVersion", "model_version");
      const promptVersion = readStringArg(args, "promptVersion", "prompt_version");
      const traceId = readStringArg(args, "traceId", "trace_id");
      const sourceRefs = Array.isArray(args.sourceRefs)
        ? (args.sourceRefs as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : Array.isArray(args.source_refs)
          ? (args.source_refs as unknown[]).filter(
              (x): x is string => typeof x === "string",
            )
          : undefined;
      const tags = Array.isArray(args.tags)
        ? (args.tags as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : undefined;

      // --- Build request body ---
      const requestBody: JsonObject = {
        organizationId,
        customerId,
        customerSlug,
        noteKey,
        noteType,
        title,
        contentMd,
        content: {
          scope,
          trigger,
          action,
          source,
          ...(typeof contentObj.example === "string"
            ? { example: contentObj.example }
            : {}),
        },
        rationale,
        confidence,
        idempotencyKey,
      };
      if (basedOnRevisionId) requestBody.basedOnRevisionId = basedOnRevisionId;
      if (modelVersion) requestBody.modelVersion = modelVersion;
      if (promptVersion) requestBody.promptVersion = promptVersion;
      if (sourceRefs && sourceRefs.length > 0) requestBody.sourceRefs = sourceRefs;
      if (tags && tags.length > 0) requestBody.tags = tags;
      if (traceId) requestBody.traceId = traceId;

      const response = await agentBookkeepingFetch(
        "/upsert-knowledge-note-draft",
        {
          method: "POST",
          body: JSON.stringify(requestBody),
        },
      );
      if ("error" in response) return response;

      warnOnUnexpectedContractVersion(toolName, response.headers);

      const syntheticResponse = new Response(null, {
        status: response.status,
        headers: response.headers,
      });
      await applyRateLimitBackoff(toolName, syntheticResponse);

      // --- Error mapping per spec ---
      const status = response.status;
      const body = response.body;
      const code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
      const errMsg =
        isRecord(body) && typeof body.error === "string"
          ? body.error
          : `Knowledge-note draft feilet (HTTP ${status})`;

      const buildErr = (
        retriable: boolean,
        hint: string,
        retryAfter?: number,
      ): JsonObject => {
        const out: JsonObject = {
          error: errMsg,
          code: code ?? `HTTP_${status}`,
          retriable,
          hint,
        };
        if (retryAfter !== undefined) out.retryAfter = retryAfter;
        return out;
      };

      const parseRetryAfter = (): number | undefined => {
        const ra = response.headers.get("Retry-After");
        if (!ra) return undefined;
        const n = Number(ra);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      };

      if (status === 401) {
        if (code === "JWT_EXPIRED" || code === "JWT_FUTURE") {
          return buildErr(true, "JWT-klokke utenfor vindu — re-sign og prøv igjen.");
        }
        if (code === "JWT_REPLAY") {
          return buildErr(false, "JWT-jti er allerede brukt; ikke retry.");
        }
        if (code === "JWT_TOOL_MISMATCH") {
          return buildErr(false, "JWT.tool matcher ikke endepunktet; sjekk signedFetch-kontekst.");
        }
        if (code === "JWT_MISSING") {
          return buildErr(false, "JWT-header manglet; sjekk PAPERCLIP_AGENT_JWT_ENABLED.");
        }
        return buildErr(false, "Uventet 401 fra Kundeoversikt.");
      }
      if (status === 400) {
        if (code === "JWT_BODY_MISMATCH") {
          return buildErr(false, "body_sha256 matcher ikke wire-body — caller serialiserte feil.");
        }
        if (code === "INVALID_BODY") {
          return buildErr(false, "Body validation failed på server-side; ikke retry uten endringer.");
        }
        return buildErr(false, "Bad request fra Kundeoversikt.");
      }
      if (status === 403) {
        if (code === "JWT_ORG_MISMATCH") {
          return buildErr(false, "JWT.organization_id matcher ikke target — sjekk env.");
        }
        return buildErr(false, "Forbidden — kunden tilhører ikke vår org eller mangler tilgang.");
      }
      if (status === 409) {
        if (code === "STALE_DRAFT") {
          return buildErr(true, "Hent ny basedOnRevisionId og prøv igjen.");
        }
        if (code === "IDEMPOTENCY_CONFLICT") {
          return buildErr(false, "Samme idempotencyKey + ulik body. Generer ny key.");
        }
        if (code === "DRAFT_QUEUE_FULL") {
          return buildErr(true, "Draft-køen er full; vent og prøv igjen.", 60);
        }
        return buildErr(false, "Conflict fra Kundeoversikt.");
      }
      if (status === 429) {
        return buildErr(true, "Rate-limited; respekter Retry-After.", parseRetryAfter() ?? 60);
      }
      if (status === 503) {
        if (code === "DRAFT_INTAKE_PAUSED") {
          return buildErr(true, "Draft-intake er midlertidig pauset av Kundeoversikt.");
        }
        return buildErr(true, "Service unavailable.");
      }
      if (status === 500) {
        return buildErr(true, "Server-feil hos Kundeoversikt.");
      }

      if (status !== 200) {
        return normalizeErrorResponse(
          body,
          `Uventet svar fra upsert-knowledge-note-draft (HTTP ${status})`,
        );
      }

      if (!isRecord(body)) {
        return normalizeErrorResponse(
          null,
          "Kunne ikke tolke svar fra upsert-knowledge-note-draft.",
          "INVALID_RESPONSE",
        );
      }

      // --- Happy path. embeddingStatus=pending_retry er IKKE feil.
      // Quinn finding #5: whitelist embeddingStatus. 'failed' or unknown
      // values must surface as a structured error so the agent doesn't
      // silently treat a noteId=null response as success. ---
      const result = body as KnowledgeNoteDraftResponse;
      const rawEmbedding = result.embeddingStatus;
      const allowedEmbeddingStatuses = new Set(["ok", "pending_retry"]);
      if (
        typeof rawEmbedding !== "string" ||
        !allowedEmbeddingStatuses.has(rawEmbedding)
      ) {
        const observed =
          typeof rawEmbedding === "string" ? rawEmbedding : "unknown";
        return {
          error: `Embedding feilet — Kundeoversikt vil retry. (observed=${observed})`,
          code: "EMBEDDING_FAILED",
          retriable: true,
          hint: "Embedding feilet — Kundeoversikt vil retry.",
          embeddingStatus: observed,
        };
      }
      const out: JsonObject = {
        status: result.status,
        noteId: result.noteId,
        revisionId: result.revisionId,
        queueId: result.queueId,
        basedOnRevisionId: result.basedOnRevisionId,
        diffPreview: result.diffPreview,
        embeddingStatus: rawEmbedding,
        requiresToreReview: result.requiresToreReview,
      };
      if (rawEmbedding === "pending_retry") {
        out._note =
          "Embedding pending — Kundeoversikt vil retry. Noten er lagret som draft.";
      }
      return out;
    }

    default:
      return { error: `Ukjent Kundeoversikt-verktøy: ${toolName}` };
  }
}

export function isKundeoversiktTool(name: string): boolean {
  return KUNDEOVERSIKT_TOOL_NAMES.has(name);
}
