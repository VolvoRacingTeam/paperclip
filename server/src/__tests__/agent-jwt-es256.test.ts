import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";

import {
  buildJwksDocument,
  computeBodySha256,
  getEs256KeyMaterial,
  resetEs256KeyMaterialCache,
  signAgentEs256Jwt,
  signRequestJwt,
} from "../agent-jwt-es256.js";

const ENV_KEYS = [
  "PAPERCLIP_JWT_PRIVATE_KEY_PEM",
  "PAPERCLIP_JWT_PRIVATE_KEY_PATH",
  "PAPERCLIP_JWT_KID",
  "PAPERCLIP_JWT_ISSUER",
  "PAPERCLIP_JWT_REQUEST_ISSUER",
  "PAPERCLIP_JWT_AUDIENCE",
  "PAPERCLIP_JWT_TTL_SECONDS",
  "PAPERCLIP_JWT_REQUEST_TTL_SECONDS",
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

const VERKVELVEN_ORG_ID = "10ca8f03-1f23-4d63-a350-b6d0664ef5a4";

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

  describe("computeBodySha256 (Task #27)", () => {
    it("returns SHA-256 of empty string when body is undefined", () => {
      const expected = createHash("sha256").update("").digest("hex");
      expect(computeBodySha256(undefined)).toBe(expected);
    });

    it("returns SHA-256 of empty string when body is null", () => {
      const expected = createHash("sha256").update("").digest("hex");
      expect(computeBodySha256(null)).toBe(expected);
    });

    it("returns SHA-256 of JSON.stringify(body) for objects", () => {
      const body = { a: 1, b: "x" };
      const expected = createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex");
      expect(computeBodySha256(body)).toBe(expected);
    });

    it("returns SHA-256 of the raw string when body is already a string", () => {
      const body = '{"already":"serialized"}';
      const expected = createHash("sha256").update(body).digest("hex");
      expect(computeBodySha256(body)).toBe(expected);
    });
  });

  describe("signRequestJwt — Kundeoversikt 2026-04-24 spec", () => {
    beforeEach(() => {
      process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM = makeEcPrivatePem();
      process.env.PAPERCLIP_JWT_KID = "paperclip-test";
      // intentionally set generic ISSUER to https://... — request JWT must
      // ignore it and use the bare hostname per spec.
      process.env.PAPERCLIP_JWT_ISSUER = "https://paperclip.nullmas.no";
      process.env.PAPERCLIP_JWT_AUDIENCE = "kundeoversikt.no";
      resetEs256KeyMaterialCache();
    });

    it("uses bare-hostname issuer 'paperclip.nullmas.no' (no scheme)", async () => {
      const jwt = await signRequestJwt({
        agentId: "agent-xyz",
        runId: "run-42",
        toolName: "kundeoversikt_create_draft_reply",
        method: "POST",
        path: "/api/agent/drafts",
        body: { hello: "world" },
        organizationId: VERKVELVEN_ORG_ID,
      });
      const payload = decodeJwt(jwt);
      expect(payload.iss).toBe("paperclip.nullmas.no");
    });

    it("subject is prefixed with 'agent:' and agent_id claim is raw", async () => {
      const jwt = await signRequestJwt({
        agentId: "test-agent",
        runId: "run-42",
        toolName: "kundeoversikt_create_draft_reply",
        method: "POST",
        path: "/api/agent/drafts",
        organizationId: VERKVELVEN_ORG_ID,
      });
      const payload = decodeJwt(jwt);
      expect(payload.sub).toBe("agent:test-agent");
      expect(payload.agent_id).toBe("test-agent");
    });

    it("includes nbf == iat and exp == iat + 90 (90-second TTL per spec)", async () => {
      const jwt = await signRequestJwt({
        agentId: "agent-xyz",
        runId: "run-42",
        toolName: "kundeoversikt_create_draft_reply",
        method: "POST",
        path: "/api/agent/drafts",
        organizationId: VERKVELVEN_ORG_ID,
      });
      const payload = decodeJwt(jwt);
      expect(typeof payload.iat).toBe("number");
      expect(typeof payload.nbf).toBe("number");
      expect(typeof payload.exp).toBe("number");
      expect(payload.nbf).toBe(payload.iat);
      expect((payload.exp as number) - (payload.iat as number)).toBe(90);
    });

    it("includes organization_id claim from caller", async () => {
      const jwt = await signRequestJwt({
        agentId: "agent-xyz",
        runId: "run-42",
        toolName: "kundeoversikt_create_draft_reply",
        method: "POST",
        path: "/api/agent/drafts",
        organizationId: VERKVELVEN_ORG_ID,
      });
      const payload = decodeJwt(jwt);
      expect(payload.organization_id).toBe(VERKVELVEN_ORG_ID);
    });

    it("uses claim name 'tool' (not 'tool_name')", async () => {
      const jwt = await signRequestJwt({
        agentId: "agent-xyz",
        runId: "run-42",
        toolName: "kundeoversikt_upsert_knowledge_note_draft",
        method: "POST",
        path: "/api/agent/upsert-knowledge-note-draft",
        organizationId: VERKVELVEN_ORG_ID,
      });
      const payload = decodeJwt(jwt);
      expect(payload.tool).toBe("kundeoversikt_upsert_knowledge_note_draft");
      expect(payload.tool_name).toBeUndefined();
    });

    it("includes per-request claims method, path, tool, body_sha256, jti", async () => {
      const body = { hello: "world" };
      const jwt = await signRequestJwt({
        agentId: "agent-xyz",
        runId: "run-42",
        toolName: "kundeoversikt_create_draft_reply",
        method: "POST",
        path: "/api/agent/drafts",
        body,
        organizationId: VERKVELVEN_ORG_ID,
      });

      const payload = decodeJwt(jwt);
      expect(payload.run_id).toBe("run-42");
      expect(payload.tool).toBe("kundeoversikt_create_draft_reply");
      expect(payload.method).toBe("POST");
      expect(payload.path).toBe("/api/agent/drafts");
      expect(payload.body_sha256).toBe(computeBodySha256(body));
      expect(typeof payload.jti).toBe("string");
      expect((payload.jti as string).length).toBeGreaterThan(8);
    });

    it("computes body_sha256 of empty string when no body is provided (GET)", async () => {
      const jwt = await signRequestJwt({
        agentId: "agent-xyz",
        runId: "run-42",
        toolName: "kundeoversikt_list_unprocessed_emails",
        method: "GET",
        path: "/api/agent/emails/unprocessed?limit=10",
        organizationId: VERKVELVEN_ORG_ID,
      });
      const payload = decodeJwt(jwt);
      expect(payload.body_sha256).toBe(computeBodySha256(undefined));
      expect(payload.method).toBe("GET");
    });

    it("produces unique jti per call", async () => {
      const jwt1 = await signRequestJwt({
        agentId: "a",
        runId: "r",
        toolName: "t",
        method: "GET",
        path: "/p",
        organizationId: VERKVELVEN_ORG_ID,
      });
      const jwt2 = await signRequestJwt({
        agentId: "a",
        runId: "r",
        toolName: "t",
        method: "GET",
        path: "/p",
        organizationId: VERKVELVEN_ORG_ID,
      });
      const p1 = decodeJwt(jwt1);
      const p2 = decodeJwt(jwt2);
      expect(p1.jti).not.toBe(p2.jti);
    });

    it("verifies against published JWKS with bare-hostname issuer", async () => {
      const jwt = await signRequestJwt({
        agentId: "agent-1",
        runId: "run-1",
        toolName: "kundeoversikt_log_action",
        method: "POST",
        path: "/api/agent/actions",
        body: { actionType: "x" },
        organizationId: VERKVELVEN_ORG_ID,
      });

      const jwks = buildJwksDocument();
      const keySet = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
      const { payload, protectedHeader } = await jwtVerify(jwt, keySet, {
        issuer: "paperclip.nullmas.no",
        audience: "kundeoversikt.no",
      });
      expect(protectedHeader.alg).toBe("ES256");
      expect(protectedHeader.kid).toBe("paperclip-test");
      expect(payload.tool).toBe("kundeoversikt_log_action");
      expect(payload.sub).toBe("agent:agent-1");
      expect(payload.organization_id).toBe(VERKVELVEN_ORG_ID);
    });

    it("respects PAPERCLIP_JWT_REQUEST_TTL_SECONDS override", async () => {
      process.env.PAPERCLIP_JWT_REQUEST_TTL_SECONDS = "120";
      const jwt = await signRequestJwt({
        agentId: "agent-xyz",
        runId: "run-42",
        toolName: "kundeoversikt_create_draft_reply",
        method: "POST",
        path: "/api/agent/drafts",
        organizationId: VERKVELVEN_ORG_ID,
      });
      const payload = decodeJwt(jwt);
      expect((payload.exp as number) - (payload.iat as number)).toBe(120);
    });

    it("respects PAPERCLIP_JWT_REQUEST_ISSUER override", async () => {
      process.env.PAPERCLIP_JWT_REQUEST_ISSUER = "paperclip-staging.nullmas.no";
      const jwt = await signRequestJwt({
        agentId: "agent-xyz",
        runId: "run-42",
        toolName: "kundeoversikt_create_draft_reply",
        method: "POST",
        path: "/api/agent/drafts",
        organizationId: VERKVELVEN_ORG_ID,
      });
      const payload = decodeJwt(jwt);
      expect(payload.iss).toBe("paperclip-staging.nullmas.no");
    });
  });
});
