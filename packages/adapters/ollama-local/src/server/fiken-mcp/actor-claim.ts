/**
 * X-MCP-Actor-Claim JWT signer for Paperclip → Fikenverktøy MCP.
 *
 * Per spec § 1.3 (_bmad-output/paperclip-tier-b-mcp-wireup-spec.md) and the
 * audit-canonicalisation decided 2026-04-28 (commit e6af602 +
 * supabase/migrations/20260428000001_fiken_actions_audit_canonical_all_mcp.sql).
 *
 *   Header  : X-MCP-Actor-Claim: <jwt>
 *   Algo    : ES256 (P-256 ECDSA + SHA-256)
 *   TTL     : 300 s
 *   kid     : paperclip-2026-04 (PAPERCLIP_JWT_KID)
 *
 *   Payload:
 *     iss     : paperclip.nullmas.no   (PAPERCLIP_MCP_JWT_ISSUER)
 *     aud     : fikenverktoy.vercel.app (PAPERCLIP_MCP_JWT_AUDIENCE)
 *     sub     : agent:<actor_agent_id>
 *     iat=nbf, exp = iat + ttlSeconds
 *     jti     : random UUID
 *     actor_type                 : 'agent' (Paperclip never sends 'human'/'service')
 *     actor_agent_id             : UUID
 *     actor_agent_name           : string (e.g. "Bankavstemmer")
 *     surface                    : 'paperclip' (env-bound)
 *     tenant_id                  : UUID (Paperclip company_id)
 *     company_slug               : Fiken slug (e.g. "fiken-demo-total-blomst-as")
 *     scope                      : string[]
 *     correlation_id             : ULID
 *     task_id                    : Paperclip task UUID (from agent_run_state)
 *     agent_run_state_step_index : int (0-based step within the run)
 *
 * Reuses the same signing primitives as signed-fetch.ts but keeps separate
 * env-defaults so Kundeoversikt and Fikenverktøy claims can rotate
 * independently.
 */

import { readFileSync } from "node:fs";
import {
  createPrivateKey,
  createSign,
  randomUUID,
  type KeyObject,
} from "node:crypto";

const DEFAULT_PRIVATE_KEY_PATH = "/paperclip/secrets/paperclip-es256-private.pem";
const DEFAULT_KID = "paperclip-2026-04";
const DEFAULT_ISSUER = "paperclip.nullmas.no";
const DEFAULT_AUDIENCE = "fikenverktoy.vercel.app";
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_SURFACE = "paperclip";
export const ACTOR_CLAIM_HEADER_NAME = "X-MCP-Actor-Claim";

export type ActorType = "agent" | "human" | "service";

export interface ActorClaimContext {
  actorType: ActorType;
  actorAgentId: string;
  actorAgentName: string;
  tenantId: string;
  companySlug: string;
  scope: readonly string[];
  correlationId: string;
  taskId: string;
  agentRunStateStepIndex: number;
  /** Optional override; defaults to PAPERCLIP_MCP_SURFACE or 'paperclip'. */
  surface?: string;
}

export interface ActorClaimPayload {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  actor_type: ActorType;
  actor_agent_id: string;
  actor_agent_name: string;
  surface: string;
  tenant_id: string;
  company_slug: string;
  scope: readonly string[];
  correlation_id: string;
  task_id: string;
  agent_run_state_step_index: number;
}

interface KeyConfig {
  privateKey: KeyObject;
  kid: string;
  issuer: string;
  audience: string;
  surface: string;
  ttlSeconds: number;
}

let cachedKey: KeyConfig | null = null;
let keyCacheError: Error | null = null;
let keyCacheInitialized = false;

function loadPrivateKeyPem(): string | null {
  const inlinePem = process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM;
  if (inlinePem && inlinePem.trim().length > 0) {
    return inlinePem.includes("\n") ? inlinePem : inlinePem.replace(/\\n/g, "\n");
  }
  const envPath = process.env.PAPERCLIP_JWT_PRIVATE_KEY_PATH;
  const candidatePaths = [envPath, DEFAULT_PRIVATE_KEY_PATH].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  for (const candidate of candidatePaths) {
    try {
      const pem = readFileSync(candidate, "utf8");
      if (pem.includes("BEGIN")) return pem;
    } catch {
      // try next
    }
  }
  return null;
}

function buildKeyConfig(): KeyConfig | null {
  const pem = loadPrivateKeyPem();
  if (!pem) return null;

  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  if (privateKey.asymmetricKeyType !== "ec") {
    throw new Error(
      "PAPERCLIP_JWT_PRIVATE_KEY must be an EC (P-256) key for ES256 signing",
    );
  }

  const kid = process.env.PAPERCLIP_JWT_KID ?? DEFAULT_KID;
  const issuer = process.env.PAPERCLIP_MCP_JWT_ISSUER ?? DEFAULT_ISSUER;
  const audience = process.env.PAPERCLIP_MCP_JWT_AUDIENCE ?? DEFAULT_AUDIENCE;
  const surface = process.env.PAPERCLIP_MCP_SURFACE ?? DEFAULT_SURFACE;
  const ttlRaw = Number(process.env.PAPERCLIP_MCP_JWT_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(ttlRaw) && ttlRaw > 0
    ? Math.floor(ttlRaw)
    : DEFAULT_TTL_SECONDS;

  return { privateKey, kid, issuer, audience, surface, ttlSeconds };
}

function getKeyConfig(): KeyConfig | null {
  if (!keyCacheInitialized) {
    try {
      cachedKey = buildKeyConfig();
      keyCacheError = null;
    } catch (err) {
      keyCacheError = err instanceof Error ? err : new Error(String(err));
      cachedKey = null;
    }
    keyCacheInitialized = true;
  }
  if (keyCacheError) throw keyCacheError;
  return cachedKey;
}

export function resetActorClaimKeyCache(): void {
  cachedKey = null;
  keyCacheError = null;
  keyCacheInitialized = false;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** ASN.1 DER ECDSA signature → IEEE P1363 (raw r||s, 64 bytes for P-256). */
function derToP1363(derSig: Buffer, byteLen = 32): Buffer {
  let offset = 0;
  if (derSig[offset++] !== 0x30) {
    throw new Error("Invalid DER signature: missing SEQUENCE tag");
  }
  let totalLen = derSig[offset++]!;
  if (totalLen & 0x80) {
    const lenBytes = totalLen & 0x7f;
    totalLen = 0;
    for (let i = 0; i < lenBytes; i++) {
      totalLen = (totalLen << 8) | derSig[offset++]!;
    }
  }
  if (derSig[offset++] !== 0x02) {
    throw new Error("Invalid DER signature: missing INTEGER tag for r");
  }
  const rLen = derSig[offset++]!;
  let r = derSig.subarray(offset, offset + rLen);
  offset += rLen;
  if (derSig[offset++] !== 0x02) {
    throw new Error("Invalid DER signature: missing INTEGER tag for s");
  }
  const sLen = derSig[offset++]!;
  let s = derSig.subarray(offset, offset + sLen);
  while (r.length > byteLen && r[0] === 0) r = r.subarray(1);
  while (s.length > byteLen && s[0] === 0) s = s.subarray(1);
  if (r.length > byteLen || s.length > byteLen) {
    throw new Error(`ECDSA component longer than expected (${byteLen} bytes)`);
  }
  const padR = Buffer.alloc(byteLen - r.length, 0);
  const padS = Buffer.alloc(byteLen - s.length, 0);
  return Buffer.concat([padR, r, padS, s]);
}

export interface BuildActorClaimOptions {
  ctx: ActorClaimContext;
  /** Override now() — used by tests to fix iat/exp deterministically. */
  nowSeconds?: number;
  /** Override TTL (seconds). Falls back to env / DEFAULT_TTL_SECONDS. */
  ttlSecondsOverride?: number;
  /** Override audience (used by per-environment routing or tests). */
  audienceOverride?: string;
  /** Override issuer. */
  issuerOverride?: string;
  /** Override jti (used by tests). */
  jtiOverride?: string;
}

/** Construct the actor-claim payload without signing — exported for tests. */
export function buildActorClaimPayload(opts: BuildActorClaimOptions): ActorClaimPayload {
  const cfg = getKeyConfig();
  const issuer = opts.issuerOverride
    ?? cfg?.issuer
    ?? process.env.PAPERCLIP_MCP_JWT_ISSUER
    ?? DEFAULT_ISSUER;
  const audience = opts.audienceOverride
    ?? cfg?.audience
    ?? process.env.PAPERCLIP_MCP_JWT_AUDIENCE
    ?? DEFAULT_AUDIENCE;
  const surface = opts.ctx.surface
    ?? cfg?.surface
    ?? process.env.PAPERCLIP_MCP_SURFACE
    ?? DEFAULT_SURFACE;
  const ttl = opts.ttlSecondsOverride ?? cfg?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  validateContext(opts.ctx);

  return {
    iss: issuer,
    aud: audience,
    sub: `agent:${opts.ctx.actorAgentId}`,
    iat: now,
    nbf: now,
    exp: now + ttl,
    jti: opts.jtiOverride ?? randomUUID(),
    actor_type: opts.ctx.actorType,
    actor_agent_id: opts.ctx.actorAgentId,
    actor_agent_name: opts.ctx.actorAgentName,
    surface,
    tenant_id: opts.ctx.tenantId,
    company_slug: opts.ctx.companySlug,
    scope: opts.ctx.scope,
    correlation_id: opts.ctx.correlationId,
    task_id: opts.ctx.taskId,
    agent_run_state_step_index: opts.ctx.agentRunStateStepIndex,
  };
}

function validateContext(ctx: ActorClaimContext): void {
  const required: Array<[string, unknown]> = [
    ["actorAgentId", ctx.actorAgentId],
    ["actorAgentName", ctx.actorAgentName],
    ["tenantId", ctx.tenantId],
    ["companySlug", ctx.companySlug],
    ["correlationId", ctx.correlationId],
    ["taskId", ctx.taskId],
  ];
  for (const [name, value] of required) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`actor-claim: missing required field '${name}'`);
    }
  }
  if (ctx.actorType !== "agent" && ctx.actorType !== "human" && ctx.actorType !== "service") {
    throw new Error(`actor-claim: invalid actor_type '${ctx.actorType}'`);
  }
  if (!Array.isArray(ctx.scope)) {
    throw new Error("actor-claim: scope must be an array");
  }
  if (
    !Number.isInteger(ctx.agentRunStateStepIndex) ||
    ctx.agentRunStateStepIndex < 0
  ) {
    throw new Error(
      `actor-claim: agent_run_state_step_index must be a non-negative integer (got ${ctx.agentRunStateStepIndex})`,
    );
  }
}

/** Sign the actor-claim JWT. Throws if no signing key is configured. */
export async function signActorClaim(opts: BuildActorClaimOptions): Promise<string> {
  const cfg = getKeyConfig();
  if (!cfg) {
    throw new Error(
      "PAPERCLIP_JWT_PRIVATE_KEY not configured; cannot sign X-MCP-Actor-Claim (set PAPERCLIP_JWT_PRIVATE_KEY_PEM or _PATH)",
    );
  }

  const payload = buildActorClaimPayload(opts);
  const header = { alg: "ES256", kid: cfg.kid, typ: "JWT" };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const derSig = signer.sign(cfg.privateKey);
  const p1363Sig = derToP1363(derSig, 32);
  return `${signingInput}.${base64UrlEncode(p1363Sig)}`;
}

export const _internals = {
  DEFAULT_ISSUER,
  DEFAULT_AUDIENCE,
  DEFAULT_TTL_SECONDS,
  DEFAULT_SURFACE,
  DEFAULT_KID,
  base64UrlEncode,
  derToP1363,
};
