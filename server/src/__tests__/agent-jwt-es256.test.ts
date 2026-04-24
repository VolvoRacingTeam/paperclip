import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";

import {
  buildJwksDocument,
  getEs256KeyMaterial,
  resetEs256KeyMaterialCache,
  signAgentEs256Jwt,
} from "../agent-jwt-es256.js";

const ENV_KEYS = [
  "PAPERCLIP_JWT_PRIVATE_KEY_PEM",
  "PAPERCLIP_JWT_PRIVATE_KEY_PATH",
  "PAPERCLIP_JWT_KID",
  "PAPERCLIP_JWT_ISSUER",
  "PAPERCLIP_JWT_AUDIENCE",
  "PAPERCLIP_JWT_TTL_SECONDS",
] as const;

function snapshotEnv() {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function makeEcPrivatePem() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

describe("agent-jwt-es256", () => {
  const originalEnv = snapshotEnv();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "pcp-es256-"));
    // Clear all related env vars for a clean slate.
    for (const k of ENV_KEYS) delete process.env[k];
    resetEs256KeyMaterialCache();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv(originalEnv);
    resetEs256KeyMaterialCache();
  });

  it("returns empty JWKS when no key is configured and default path missing", () => {
    process.env.PAPERCLIP_JWT_PRIVATE_KEY_PATH = path.join(tmpDir, "missing.pem");
    expect(getEs256KeyMaterial()).toBeNull();
    expect(buildJwksDocument()).toEqual({ keys: [] });
  });

  it("loads private key from PAPERCLIP_JWT_PRIVATE_KEY_PEM and exposes JWKS", async () => {
    const pem = makeEcPrivatePem();
    process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM = pem;
    process.env.PAPERCLIP_JWT_KID = "test-kid-1";

    const jwks = buildJwksDocument();
    expect(jwks.keys).toHaveLength(1);
    const jwk = jwks.keys[0]!;
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    expect(jwk.alg).toBe("ES256");
    expect(jwk.use).toBe("sig");
    expect(jwk.kid).toBe("test-kid-1");
    expect(typeof jwk.x).toBe("string");
    expect(typeof jwk.y).toBe("string");
  });

  it("loads private key from a file path", () => {
    const pem = makeEcPrivatePem();
    const pemPath = path.join(tmpDir, "key.pem");
    writeFileSync(pemPath, pem, { mode: 0o600 });
    process.env.PAPERCLIP_JWT_PRIVATE_KEY_PATH = pemPath;

    const material = getEs256KeyMaterial();
    expect(material).not.toBeNull();
    expect(material!.publicJwk.kty).toBe("EC");
  });

  it("signs a JWT that verifies against the published JWKS", async () => {
    const pem = makeEcPrivatePem();
    process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM = pem;
    process.env.PAPERCLIP_JWT_KID = "paperclip-test";
    process.env.PAPERCLIP_JWT_ISSUER = "https://paperclip.nullmas.no";
    process.env.PAPERCLIP_JWT_AUDIENCE = "kundeoversikt.no";

    const jwt = await signAgentEs256Jwt({
      sub: "agent-123",
      run_id: "run-abc",
      company_id: "verkvelven",
      adapter_type: "ollama_local",
    });

    const jwks = buildJwksDocument();
    const keySet = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
    const { payload, protectedHeader } = await jwtVerify(jwt, keySet, {
      issuer: "https://paperclip.nullmas.no",
      audience: "kundeoversikt.no",
    });

    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.kid).toBe("paperclip-test");
    expect(payload.sub).toBe("agent-123");
    expect(payload.run_id).toBe("run-abc");
    expect(payload.company_id).toBe("verkvelven");
    expect(typeof payload.jti).toBe("string");
    expect(typeof payload.exp).toBe("number");
    expect(typeof payload.iat).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBeGreaterThan(0);
  });

  it("signAgentEs256Jwt throws when no key configured", async () => {
    process.env.PAPERCLIP_JWT_PRIVATE_KEY_PATH = path.join(tmpDir, "missing.pem");
    await expect(
      signAgentEs256Jwt({ sub: "a", run_id: "r" }),
    ).rejects.toThrow(/not configured/);
  });

  it("rejects non-EC keys", () => {
    // Generate an RSA key – should fail when ES256 is required.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM = pem;
    expect(() => getEs256KeyMaterial()).toThrow(/EC \(P-256\)/);
  });
});
