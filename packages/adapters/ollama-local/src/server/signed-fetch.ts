/**
 * Signed-fetch helper for outbound agent calls (Kundeoversikt etc.).
 *
 * Mirrors server/src/agent-jwt-es256.ts::signRequestJwt() independently to avoid
 * a circular workspace dependency (server depends on adapters, not the reverse).
 * MUST stay in lockstep with that file and Kundeoversikt's verify-paperclip-jwt.ts.
 *
 * 2026-04-24 spec (Kundeoversikt 02:15 CET):
 *   Header  : X-Paperclip-Agent-Claim: <jwt>
 *   Algo    : ES256 (P-256 ECDSA + SHA-256)
 *   iss     : paperclip.nullmas.no   (bare hostname, no scheme)
 *   aud     : kundeoversikt.no
 *   sub     : agent:<agentId>
 *   iat=nbf, exp = iat + 90
 *   jti     : random UUID per request
 *   payload : agent_id, run_id, organization_id, body_sha256, tool, method, path
 *
 * Implementation uses only `node:crypto` to keep this package free of the
 * `jose` dependency the server uses.
 *
 * Feature-flagged: callers should consult PAPERCLIP_AGENT_JWT_ENABLED before
 * invoking signedFetch — the helper itself does NOT auto-fall-back.
 */

import { readFileSync } from "node:fs";
import {
  createHash,
  createPrivateKey,
  createSign,
  randomUUID,
  type KeyObject,
} from "node:crypto";

const DEFAULT_PRIVATE_KEY_PATH = "/paperclip/secrets/paperclip-es256-private.pem";
const DEFAULT_KID = "paperclip-2026-04";
const DEFAULT_ISSUER = "paperclip.nullmas.no";
const DEFAULT_AUDIENCE = "kundeoversikt.no";
const DEFAULT_TTL_SECONDS = 90;
const JWT_HEADER_NAME = "X-Paperclip-Agent-Claim";

export interface JwtRequestContext {
  agentId: string;
  runId: string;
  toolName: string;
  organizationId: string;
  companyId?: string;
  adapterType?: string;
}

interface KeyConfig {
  privateKey: KeyObject;
  kid: string;
  issuer: string;
  audience: string;
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
  const issuer = process.env.PAPERCLIP_JWT_REQUEST_ISSUER ?? DEFAULT_ISSUER;
  const audience = process.env.PAPERCLIP_JWT_AUDIENCE ?? DEFAULT_AUDIENCE;
  const ttlRaw = Number(process.env.PAPERCLIP_JWT_REQUEST_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(ttlRaw) && ttlRaw > 0
    ? Math.floor(ttlRaw)
    : DEFAULT_TTL_SECONDS;

  return { privateKey, kid, issuer, audience, ttlSeconds };
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

/** Reset cache (tests / key rotation hooks). */
export function resetSignedFetchKeyCache(): void {
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

/**
 * Convert ASN.1 DER ECDSA signature → IEEE P1363 (raw r||s, 64 bytes for P-256).
 * Node's createSign().sign() emits DER by default; JWS ES256 requires P1363.
 */
function derToP1363(derSig: Buffer, byteLen = 32): Buffer {
  // DER: 30 [total] 02 [rLen] r... 02 [sLen] s...
  let offset = 0;
  if (derSig[offset++] !== 0x30) {
    throw new Error("Invalid DER signature: missing SEQUENCE tag");
  }
  // length byte (assume short form for P-256 sigs which fit in <128 bytes)
  let totalLen = derSig[offset++]!;
  if (totalLen & 0x80) {
    // long form length
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
  // strip leading 0x00 padding, then left-pad to byteLen
  while (r.length > byteLen && r[0] === 0) r = r.subarray(1);
  while (s.length > byteLen && s[0] === 0) s = s.subarray(1);
  if (r.length > byteLen || s.length > byteLen) {
    throw new Error(`ECDSA component longer than expected (${byteLen} bytes)`);
  }
  const padR = Buffer.alloc(byteLen - r.length, 0);
  const padS = Buffer.alloc(byteLen - s.length, 0);
  return Buffer.concat([padR, r, padS, s]);
}

export function computeBodySha256(body: unknown): string {
  let bodyStr = "";
  if (body !== undefined && body !== null) {
    bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  }
  return createHash("sha256").update(bodyStr).digest("hex");
}

interface SignParams {
  ctx: JwtRequestContext;
  method: string;
  path: string;
  body: unknown;
}

/**
 * Sign a per-request JWT for outbound calls. Throws if no key is configured.
 * Exported for unit tests; production callers go through `signedFetch`.
 */
export async function signRequestJwt(params: SignParams): Promise<string> {
  const cfg = getKeyConfig();
  if (!cfg) {
    throw new Error(
      "PAPERCLIP_JWT_PRIVATE_KEY not configured; cannot sign agent JWT (set PAPERCLIP_JWT_PRIVATE_KEY_PEM or _PATH)",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    kid: cfg.kid,
    typ: "JWT",
  };

  const payload: Record<string, unknown> = {
    iss: cfg.issuer,
    aud: cfg.audience,
    sub: `agent:${params.ctx.agentId}`,
    iat: now,
    nbf: now,
    exp: now + cfg.ttlSeconds,
    jti: randomUUID(),
    agent_id: params.ctx.agentId,
    run_id: params.ctx.runId,
    organization_id: params.ctx.organizationId,
    body_sha256: computeBodySha256(params.body),
    tool: params.ctx.toolName,
    method: params.method.toUpperCase(),
    path: params.path,
  };
  if (params.ctx.companyId) payload.company_id = params.ctx.companyId;
  if (params.ctx.adapterType) payload.adapter_type = params.ctx.adapterType;

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const derSig = signer.sign(cfg.privateKey);
  const p1363Sig = derToP1363(derSig, 32);
  const sigB64 = base64UrlEncode(p1363Sig);

  return `${signingInput}.${sigB64}`;
}

/**
 * Resolve the request path (pathname + search) from a URL-or-path string.
 * Kundeoversikt's verifier compares against `req.url.pathname + search`.
 */
function urlToPath(input: string): string {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const u = new URL(input);
    return `${u.pathname}${u.search}`;
  }
  // Already a path. Ensure leading slash.
  return input.startsWith("/") ? input : `/${input}`;
}

export interface SignedFetchOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  /** Optional override (raw string body that will be hashed). If omitted, options.body is hashed verbatim (or stringified if non-string). */
  rawBody?: string;
}

/**
 * Drop-in fetch replacement that adds `X-Paperclip-Agent-Claim: <jwt>` for
 * Kundeoversikt agent endpoints. The body passed to fetch is what gets hashed —
 * callers must serialize JSON before calling so the hash matches the wire body.
 */
export async function signedFetch(
  url: string,
  options: SignedFetchOptions,
  ctx: JwtRequestContext,
): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  const pathForClaim = urlToPath(url);

  // Determine what bytes were SENT to compute body_sha256 — must match exactly
  // what the server sees in `req.text()`. Strategy:
  //   - If rawBody is provided, hash that string verbatim.
  //   - Else if options.body is a string, hash it.
  //   - Else if options.body is undefined/null, hash empty string.
  //   - Else fail-fast — Buffers/streams are not supported because we cannot
  //     re-stringify them deterministically.
  let bodyForHash: unknown = "";
  if (options.rawBody !== undefined) {
    bodyForHash = options.rawBody;
  } else if (typeof options.body === "string") {
    bodyForHash = options.body;
  } else if (options.body === undefined || options.body === null) {
    bodyForHash = undefined;
  } else {
    throw new Error(
      "signedFetch requires `body` to be a string or omitted; pass `rawBody` for non-string payloads. Found: " +
        typeof options.body,
    );
  }

  const jwt = await signRequestJwt({
    ctx,
    method,
    path: pathForClaim,
    body: bodyForHash,
  });

  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    [JWT_HEADER_NAME]: jwt,
  };

  return fetch(url, {
    ...options,
    method,
    headers,
  });
}

/**
 * Returns true iff PAPERCLIP_AGENT_JWT_ENABLED env var is set to a truthy
 * value. Default false.
 */
export function isAgentJwtEnabled(): boolean {
  const raw = process.env.PAPERCLIP_AGENT_JWT_ENABLED;
  if (typeof raw !== "string") return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const _internals = {
  DEFAULT_ISSUER,
  DEFAULT_AUDIENCE,
  DEFAULT_TTL_SECONDS,
  JWT_HEADER_NAME,
  derToP1363,
  base64UrlEncode,
};
