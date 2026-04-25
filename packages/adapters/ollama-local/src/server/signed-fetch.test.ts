import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, createVerify, type KeyObject } from "node:crypto";

import {
  computeBodySha256,
  isAgentJwtEnabled,
  resetSignedFetchKeyCache,
  signRequestJwt,
  signedFetch,
  _internals,
} from "./signed-fetch.js";

const ENV_KEYS = [
  "PAPERCLIP_JWT_PRIVATE_KEY_PEM",
  "PAPERCLIP_JWT_PRIVATE_KEY_PATH",
  "PAPERCLIP_JWT_KID",
  "PAPERCLIP_JWT_AUDIENCE",
  "PAPERCLIP_JWT_REQUEST_ISSUER",
  "PAPERCLIP_JWT_REQUEST_TTL_SECONDS",
  "PAPERCLIP_AGENT_JWT_ENABLED",
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

function makeEcKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey,
  };
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signature: Buffer; signingInput: string } {
  const [headerB64, payloadB64, sigB64] = jwt.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("malformed jwt");
  const decode = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const header = JSON.parse(decode(headerB64).toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(decode(payloadB64).toString("utf8")) as Record<string, unknown>;
  const signature = decode(sigB64);
  return { header, payload, signature, signingInput: `${headerB64}.${payloadB64}` };
}

/**
 * Verify a JWS ES256 signature manually given a P-256 public key.
 * Converts the IEEE-P1363 (raw r||s, 64 bytes) signature back to DER for node:crypto.verify().
 */
function verifyJws(jwt: string, publicKey: KeyObject): boolean {
  const { signature, signingInput } = decodeJwt(jwt);
  if (signature.length !== 64) return false;
  const r = signature.subarray(0, 32);
  const s = signature.subarray(32, 64);
  // Re-encode as DER
  const stripLead = (buf: Buffer) => {
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0 && (buf[i + 1]! & 0x80) === 0) i++;
    let trimmed = buf.subarray(i);
    if (trimmed[0]! & 0x80) trimmed = Buffer.concat([Buffer.from([0]), trimmed]);
    return trimmed;
  };
  const rDer = stripLead(r);
  const sDer = stripLead(s);
  const rTlv = Buffer.concat([Buffer.from([0x02, rDer.length]), rDer]);
  const sTlv = Buffer.concat([Buffer.from([0x02, sDer.length]), sDer]);
  const seqContent = Buffer.concat([rTlv, sTlv]);
  const der = Buffer.concat([Buffer.from([0x30, seqContent.length]), seqContent]);

  const verifier = createVerify("SHA256");
  verifier.update(signingInput);
  verifier.end();
  return verifier.verify(publicKey, der);
}

const VERKVELVEN_ORG_ID = "10ca8f03-1f23-4d63-a350-b6d0664ef5a4";

describe("signed-fetch (adapter side, Kundeoversikt 2026-04-24 spec)", () => {
  const originalEnv = snapshotEnv();

  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    resetSignedFetchKeyCache();
  });

  afterEach(() => {
    restoreEnv(originalEnv);
    resetSignedFetchKeyCache();
  });

  describe("isAgentJwtEnabled", () => {
    it("defaults to false when env var unset", () => {
      expect(isAgentJwtEnabled()).toBe(false);
    });

    it("returns true for truthy values", () => {
      process.env.PAPERCLIP_AGENT_JWT_ENABLED = "true";
      expect(isAgentJwtEnabled()).toBe(true);
      process.env.PAPERCLIP_AGENT_JWT_ENABLED = "1";
      expect(isAgentJwtEnabled()).toBe(true);
      process.env.PAPERCLIP_AGENT_JWT_ENABLED = "YES";
      expect(isAgentJwtEnabled()).toBe(true);
    });

    it("returns false for falsy values", () => {
      process.env.PAPERCLIP_AGENT_JWT_ENABLED = "false";
      expect(isAgentJwtEnabled()).toBe(false);
      process.env.PAPERCLIP_AGENT_JWT_ENABLED = "0";
      expect(isAgentJwtEnabled()).toBe(false);
      process.env.PAPERCLIP_AGENT_JWT_ENABLED = "";
      expect(isAgentJwtEnabled()).toBe(false);
    });
  });

  describe("signRequestJwt produces spec-compliant ES256 JWT", () => {
    let publicKey: KeyObject;

    beforeEach(() => {
      const { privatePem, publicKey: pub } = makeEcKeyPair();
      process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM = privatePem;
      process.env.PAPERCLIP_JWT_KID = "test-kid";
      publicKey = pub;
      resetSignedFetchKeyCache();
    });

    it("uses ES256 header with kid + typ JWT", async () => {
      const jwt = await signRequestJwt({
        ctx: {
          agentId: "test-agent",
          runId: "run-1",
          toolName: "kundeoversikt_upsert_knowledge_note_draft",
          organizationId: VERKVELVEN_ORG_ID,
        },
        method: "POST",
        path: "/api/agent/upsert-knowledge-note-draft",
        body: '{"hello":"world"}',
      });
      const { header } = decodeJwt(jwt);
      expect(header.alg).toBe("ES256");
      expect(header.kid).toBe("test-kid");
      expect(header.typ).toBe("JWT");
    });

    it("includes all spec-mandated claims with bare-hostname iss + agent: sub prefix", async () => {
      const body = '{"actionType":"x"}';
      const jwt = await signRequestJwt({
        ctx: {
          agentId: "test-agent",
          runId: "run-1",
          toolName: "kundeoversikt_upsert_knowledge_note_draft",
          organizationId: VERKVELVEN_ORG_ID,
        },
        method: "POST",
        path: "/api/agent/upsert-knowledge-note-draft",
        body,
      });
      const { payload } = decodeJwt(jwt);
      expect(payload.iss).toBe("paperclip.nullmas.no");
      expect(payload.aud).toBe("kundeoversikt.no");
      expect(payload.sub).toBe("agent:test-agent");
      expect(payload.agent_id).toBe("test-agent");
      expect(payload.run_id).toBe("run-1");
      expect(payload.organization_id).toBe(VERKVELVEN_ORG_ID);
      expect(payload.body_sha256).toBe(computeBodySha256(body));
      expect(payload.tool).toBe("kundeoversikt_upsert_knowledge_note_draft");
      expect(payload.method).toBe("POST");
      expect(payload.path).toBe("/api/agent/upsert-knowledge-note-draft");
      expect(typeof payload.jti).toBe("string");
      expect((payload.jti as string).length).toBeGreaterThan(8);
      expect(typeof payload.iat).toBe("number");
      expect(typeof payload.nbf).toBe("number");
      expect(typeof payload.exp).toBe("number");
      expect(payload.nbf).toBe(payload.iat);
      expect((payload.exp as number) - (payload.iat as number)).toBe(90);
      // tool_name should NOT exist
      expect(payload.tool_name).toBeUndefined();
    });

    it("signature verifies against P-256 public key (round-trip)", async () => {
      const jwt = await signRequestJwt({
        ctx: {
          agentId: "test-agent",
          runId: "run-1",
          toolName: "kundeoversikt_log_action",
          organizationId: VERKVELVEN_ORG_ID,
        },
        method: "POST",
        path: "/api/agent/actions",
        body: '{"x":1}',
      });
      expect(verifyJws(jwt, publicKey)).toBe(true);
    });

    it("body_sha256 matches empty string when body is undefined (GET)", async () => {
      const jwt = await signRequestJwt({
        ctx: {
          agentId: "a",
          runId: "r",
          toolName: "t",
          organizationId: VERKVELVEN_ORG_ID,
        },
        method: "GET",
        path: "/api/agent/emails/unprocessed?limit=10",
        body: undefined,
      });
      const { payload } = decodeJwt(jwt);
      expect(payload.body_sha256).toBe(computeBodySha256(undefined));
      expect(payload.method).toBe("GET");
    });

    it("includes optional company_id and adapter_type when provided", async () => {
      const jwt = await signRequestJwt({
        ctx: {
          agentId: "a",
          runId: "r",
          toolName: "t",
          organizationId: VERKVELVEN_ORG_ID,
          companyId: "company-uuid-123",
          adapterType: "ollama_local",
        },
        method: "POST",
        path: "/p",
        body: "",
      });
      const { payload } = decodeJwt(jwt);
      expect(payload.company_id).toBe("company-uuid-123");
      expect(payload.adapter_type).toBe("ollama_local");
    });

    it("respects PAPERCLIP_JWT_REQUEST_ISSUER / TTL overrides", async () => {
      process.env.PAPERCLIP_JWT_REQUEST_ISSUER = "paperclip-staging.nullmas.no";
      process.env.PAPERCLIP_JWT_REQUEST_TTL_SECONDS = "120";
      resetSignedFetchKeyCache();
      const jwt = await signRequestJwt({
        ctx: {
          agentId: "a",
          runId: "r",
          toolName: "t",
          organizationId: VERKVELVEN_ORG_ID,
        },
        method: "GET",
        path: "/p",
        body: undefined,
      });
      const { payload } = decodeJwt(jwt);
      expect(payload.iss).toBe("paperclip-staging.nullmas.no");
      expect((payload.exp as number) - (payload.iat as number)).toBe(120);
    });

    it("produces unique jti per call", async () => {
      const ctx = {
        agentId: "a",
        runId: "r",
        toolName: "t",
        organizationId: VERKVELVEN_ORG_ID,
      };
      const jwt1 = await signRequestJwt({ ctx, method: "GET", path: "/p", body: undefined });
      const jwt2 = await signRequestJwt({ ctx, method: "GET", path: "/p", body: undefined });
      expect(decodeJwt(jwt1).payload.jti).not.toBe(decodeJwt(jwt2).payload.jti);
    });
  });

  describe("signedFetch wires header X-Paperclip-Agent-Claim", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      const { privatePem } = makeEcKeyPair();
      process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM = privatePem;
      process.env.PAPERCLIP_JWT_KID = "test-kid";
      resetSignedFetchKeyCache();
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("attaches X-Paperclip-Agent-Claim header (not Authorization)", async () => {
      let observedHeaders: Record<string, string> = {};
      let observedUrl = "";
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        observedUrl = url;
        observedHeaders = init.headers as Record<string, string>;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const res = await signedFetch(
        "https://www.kundeoversikt.no/api/agent/drafts?organizationId=" + VERKVELVEN_ORG_ID,
        {
          method: "POST",
          body: JSON.stringify({ subject: "hi" }),
          headers: { "Content-Type": "application/json" },
        },
        {
          agentId: "test-agent",
          runId: "run-1",
          toolName: "kundeoversikt_create_draft_reply",
          organizationId: VERKVELVEN_ORG_ID,
        },
      );

      expect(res.status).toBe(200);
      expect(observedUrl).toContain("kundeoversikt.no");
      expect(observedHeaders[_internals.JWT_HEADER_NAME]).toBeTruthy();
      expect(observedHeaders.Authorization).toBeUndefined();
      // Path claim should match pathname + search
      const jwt = observedHeaders[_internals.JWT_HEADER_NAME]!;
      const { payload } = decodeJwt(jwt);
      expect(payload.path).toBe("/api/agent/drafts?organizationId=" + VERKVELVEN_ORG_ID);
      expect(payload.method).toBe("POST");
    });

    it("computes body_sha256 over the exact string body sent", async () => {
      const bodyStr = JSON.stringify({ subject: "hello", body: "world" });
      let observedHeaders: Record<string, string> = {};
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        observedHeaders = init.headers as Record<string, string>;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      await signedFetch(
        "https://example.com/api/agent/drafts",
        { method: "POST", body: bodyStr, headers: { "Content-Type": "application/json" } },
        {
          agentId: "a",
          runId: "r",
          toolName: "kundeoversikt_create_draft_reply",
          organizationId: VERKVELVEN_ORG_ID,
        },
      );

      const jwt = observedHeaders[_internals.JWT_HEADER_NAME]!;
      const { payload } = decodeJwt(jwt);
      expect(payload.body_sha256).toBe(computeBodySha256(bodyStr));
    });

    it("rejects non-string body without rawBody to avoid hash mismatches", async () => {
      globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
      await expect(
        signedFetch(
          "https://example.com/api/agent/drafts",
          { method: "POST", body: Buffer.from("{}") as unknown as BodyInit },
          {
            agentId: "a",
            runId: "r",
            toolName: "t",
            organizationId: VERKVELVEN_ORG_ID,
          },
        ),
      ).rejects.toThrow(/string or omitted/);
    });
  });
});
