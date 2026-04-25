/**
 * ES256 agent JWT signing + JWKS material for Paperclip.
 *
 * Task #26 (2026-04-24): Kundeoversikt Sprint 35 requires Paperclip to sign
 * agent runtime JWTs with an asymmetric key so Kundeoversikt backend can
 * verify them by fetching the public key from
 *   https://paperclip.nullmas.no/.well-known/jwks.json
 *
 * Task #27 (2026-04-24): Adds signRequestJwt() helper for per-request claims
 * (method/path/tool/body_sha256/jti). Adapter-side outbound fetch wrappers
 * mirror this contract independently to avoid a circular workspace dependency
 * (server depends on adapters, not the reverse). Both callers MUST keep the
 * claims shape in lockstep with Kundeoversikt's verify-paperclip-jwt.ts.
 *
 * The private key is loaded from (in order):
 *   1. PAPERCLIP_JWT_PRIVATE_KEY_PEM (full PEM, newline-separated).
 *   2. PAPERCLIP_JWT_PRIVATE_KEY_PATH (path to PEM file).
 *   3. /paperclip/secrets/paperclip-es256-private.pem (default on-disk path).
 *
 * If no key is configured the module exports `null` accessors so callers
 * degrade gracefully (JWKS endpoint returns `{ keys: [] }` and signing
 * throws a descriptive error).
 */

import { readFileSync } from "node:fs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { SignJWT, type JWK } from "jose";

const DEFAULT_PRIVATE_KEY_PATH = "/paperclip/secrets/paperclip-es256-private.pem";
const DEFAULT_KID = "paperclip-2026-04";
const DEFAULT_ISSUER = "https://paperclip.nullmas.no";
const DEFAULT_AUDIENCE = "kundeoversikt.no";
const DEFAULT_TTL_SECONDS = 10 * 60; // 10 minutes per Task #24 design

export interface AgentJwtClaims {
  sub: string; // agent_id
  run_id: string;
  company_id?: string;
  adapter_type?: string;
  [key: string]: unknown;
}

export interface Es256KeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicJwk: JWK;
  kid: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

let cached: Es256KeyMaterial | null = null;
let cacheInitialized = false;
let cacheLoadError: Error | null = null;

function loadPrivateKeyPem(): string | null {
  const inlinePem = process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM;
  if (inlinePem && inlinePem.trim().length > 0) {
    // Support \n-escaped single-line env vars as well as real newlines.
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
      // fall through to next candidate
    }
  }
  return null;
}

function buildKeyMaterialSync(): Es256KeyMaterial | null {
  const pem = loadPrivateKeyPem();
  if (!pem) return null;

  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  if (privateKey.asymmetricKeyType !== "ec") {
    throw new Error(
      "PAPERCLIP_JWT_PRIVATE_KEY must be an EC (P-256) key for ES256 signing",
    );
  }
  const publicKey = createPublicKey(privateKey);

  // Derive JWK representation (Node 22 supports KeyObject.export({format: 'jwk'})).
  const rawJwk = publicKey.export({ format: "jwk" }) as JWK;
  if (rawJwk.kty !== "EC" || rawJwk.crv !== "P-256") {
    throw new Error(
      `Unsupported key type for ES256 JWKS: kty=${rawJwk.kty} crv=${rawJwk.crv}`,
    );
  }

  const kid = process.env.PAPERCLIP_JWT_KID ?? DEFAULT_KID;
  const issuer = process.env.PAPERCLIP_JWT_ISSUER ?? DEFAULT_ISSUER;
  const audience = process.env.PAPERCLIP_JWT_AUDIENCE ?? DEFAULT_AUDIENCE;
  const ttlRaw = Number(process.env.PAPERCLIP_JWT_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : DEFAULT_TTL_SECONDS;

  const publicJwk: JWK = {
    kty: "EC",
    crv: "P-256",
    x: rawJwk.x,
    y: rawJwk.y,
    use: "sig",
    alg: "ES256",
    kid,
  };

  return { privateKey, publicKey, publicJwk, kid, issuer, audience, ttlSeconds };
}

/**
 * Returns cached key material, or null if no key is configured.
 * Throws if configuration is present but invalid (e.g. wrong key type).
 */
export function getEs256KeyMaterial(): Es256KeyMaterial | null {
  if (!cacheInitialized) {
    try {
      cached = buildKeyMaterialSync();
      cacheLoadError = null;
    } catch (err) {
      cacheLoadError = err instanceof Error ? err : new Error(String(err));
      cached = null;
    }
    cacheInitialized = true;
  }
  if (cacheLoadError) throw cacheLoadError;
  return cached;
}

/**
 * Reset the cached key material. Intended for tests and key rotation hooks.
 */
export function resetEs256KeyMaterialCache() {
  cached = null;
  cacheInitialized = false;
  cacheLoadError = null;
}

/**
 * Returns the JWKS document exposed at /.well-known/jwks.json.
 * Always returns a valid shape (possibly empty keys array).
 */
export function buildJwksDocument(): { keys: JWK[] } {
  let material: Es256KeyMaterial | null = null;
  try {
    material = getEs256KeyMaterial();
  } catch {
    material = null;
  }
  if (!material) return { keys: [] };
  return { keys: [material.publicJwk] };
}

/**
 * Sign an agent JWT with ES256 for downstream consumers (Kundeoversikt etc.).
 * Throws if no ES256 key is configured.
 */
export async function signAgentEs256Jwt(
  claims: AgentJwtClaims,
  opts: { audience?: string; ttlSeconds?: number } = {},
): Promise<string> {
  const material = getEs256KeyMaterial();
  if (!material) {
    throw new Error(
      "PAPERCLIP_JWT_PRIVATE_KEY not configured; cannot sign ES256 agent JWT",
    );
  }
  const audience = opts.audience ?? material.audience;
  const ttl = opts.ttlSeconds ?? material.ttlSeconds;
  const jtiFromClaim = typeof claims.jti === "string" ? claims.jti : undefined;
  const jti = jtiFromClaim ?? `${claims.sub}:${claims.run_id}:${Date.now()}`;

  return await new SignJWT({ ...claims, jti })
    .setProtectedHeader({ alg: "ES256", kid: material.kid, typ: "JWT" })
    .setIssuer(material.issuer)
    .setAudience(audience)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .setJti(jti)
    .sign(material.privateKey);
}

/**
 * Per-request claims used by Paperclip agent fetch wrappers (ollama_local etc.).
 *
 * Kundeoversikt's verify-paperclip-jwt.ts validates body_sha256 matches
 * SHA-256(request.body), jti uniqueness (Redis-replay 11 min TTL), and that
 * method/path/tool match the actual HTTP request.
 */
export interface AgentRequestClaims {
  agentId: string;
  runId: string;
  toolName: string;
  method: string; // "GET" | "POST" | etc.
  path: string;   // full path including query string
  body?: unknown; // request body, will be SHA-256-hashed
  companyId?: string;
  adapterType?: string;
}

/**
 * Compute hex SHA-256 of the canonical body string (empty string for no body).
 * Exported for tests and adapter-side helpers that re-implement signing
 * (the adapter package has no @paperclipai/server dependency on purpose).
 */
export function computeBodySha256(body: unknown): string {
  let bodyStr = "";
  if (body !== undefined && body !== null) {
    bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  }
  return createHash("sha256").update(bodyStr).digest("hex");
}

/**
 * Sign a per-request agent JWT for outbound calls (Kundeoversikt etc.).
 * Server-side verifier checks body_sha256 matches the request body, that
 * method/path/tool match, and that jti has not been replayed.
 */
export async function signRequestJwt(
  claims: AgentRequestClaims,
): Promise<string> {
  const bodySha256 = computeBodySha256(claims.body);
  return signAgentEs256Jwt({
    sub: claims.agentId,
    run_id: claims.runId,
    tool: claims.toolName,
    method: claims.method,
    path: claims.path,
    body_sha256: bodySha256,
    jti: randomUUID(),
    company_id: claims.companyId,
    adapter_type: claims.adapterType,
  });
}

/**
 * Export helpers used in tests.
 */
export const _internals = {
  DEFAULT_PRIVATE_KEY_PATH,
  DEFAULT_KID,
  DEFAULT_ISSUER,
  DEFAULT_AUDIENCE,
  DEFAULT_TTL_SECONDS,
};
