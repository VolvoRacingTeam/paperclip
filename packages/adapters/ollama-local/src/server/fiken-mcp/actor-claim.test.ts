import { generateKeyPairSync, createPublicKey, createVerify } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  buildActorClaimPayload,
  resetActorClaimKeyCache,
  signActorClaim,
  _actorClaimInternals,
} from "./index.js";

let privatePem = "";
let publicKeyDer: Buffer;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "PAPERCLIP_JWT_PRIVATE_KEY_PEM",
  "PAPERCLIP_JWT_PRIVATE_KEY_PATH",
  "PAPERCLIP_JWT_KID",
  "PAPERCLIP_MCP_JWT_ISSUER",
  "PAPERCLIP_MCP_JWT_AUDIENCE",
  "PAPERCLIP_MCP_JWT_TTL_SECONDS",
  "PAPERCLIP_MCP_SURFACE",
];

function snapshotEnv(): void {
  for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
}

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  snapshotEnv();
});

beforeEach(() => {
  // Clear all related env vars before each test, then re-set what the test needs.
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM = privatePem;
  process.env.PAPERCLIP_JWT_KID = "paperclip-test-kid";
  resetActorClaimKeyCache();
});

afterEach(() => {
  restoreEnv();
  resetActorClaimKeyCache();
});

const baseCtx = {
  actorType: "agent" as const,
  actorAgentId: "11111111-2222-3333-4444-555555555555",
  actorAgentName: "Bankavstemmer",
  tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  companySlug: "fiken-demo-total-blomst-as",
  scope: ["fiken.read", "fiken.write"] as const,
  correlationId: "01HXYZ0000000000000000CORR",
  taskId: "task-1234",
  agentRunStateStepIndex: 2,
};

describe("buildActorClaimPayload", () => {
  it("returns the canonical payload shape with iat=nbf and exp=iat+ttl", () => {
    const payload = buildActorClaimPayload({
      ctx: baseCtx,
      nowSeconds: 1_700_000_000,
      ttlSecondsOverride: 300,
      jtiOverride: "fixed-jti",
    });

    expect(payload).toMatchObject({
      iss: "paperclip.nullmas.no",
      aud: "fikenverktoy.vercel.app",
      sub: "agent:11111111-2222-3333-4444-555555555555",
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 1_700_000_300,
      jti: "fixed-jti",
      actor_type: "agent",
      actor_agent_id: baseCtx.actorAgentId,
      actor_agent_name: "Bankavstemmer",
      surface: "paperclip",
      tenant_id: baseCtx.tenantId,
      company_slug: "fiken-demo-total-blomst-as",
      correlation_id: "01HXYZ0000000000000000CORR",
      task_id: "task-1234",
      agent_run_state_step_index: 2,
    });
    expect(payload.scope).toEqual(["fiken.read", "fiken.write"]);
  });

  it("respects PAPERCLIP_MCP_SURFACE env override", () => {
    process.env.PAPERCLIP_MCP_SURFACE = "paperclip-staging";
    resetActorClaimKeyCache();
    const payload = buildActorClaimPayload({
      ctx: baseCtx,
      nowSeconds: 1_700_000_000,
    });
    expect(payload.surface).toBe("paperclip-staging");
  });

  it("rejects empty required fields", () => {
    expect(() =>
      buildActorClaimPayload({
        ctx: { ...baseCtx, actorAgentName: "" },
        nowSeconds: 1_700_000_000,
      }),
    ).toThrow(/actorAgentName/);

    expect(() =>
      buildActorClaimPayload({
        ctx: { ...baseCtx, taskId: "" },
        nowSeconds: 1_700_000_000,
      }),
    ).toThrow(/taskId/);
  });

  it("rejects invalid actor_type", () => {
    expect(() =>
      buildActorClaimPayload({
        ctx: { ...baseCtx, actorType: "robot" as never },
        nowSeconds: 1_700_000_000,
      }),
    ).toThrow(/actor_type/);
  });

  it("rejects negative or non-integer step indices", () => {
    expect(() =>
      buildActorClaimPayload({
        ctx: { ...baseCtx, agentRunStateStepIndex: -1 },
        nowSeconds: 1_700_000_000,
      }),
    ).toThrow(/agent_run_state_step_index/);

    expect(() =>
      buildActorClaimPayload({
        ctx: { ...baseCtx, agentRunStateStepIndex: 1.5 },
        nowSeconds: 1_700_000_000,
      }),
    ).toThrow(/agent_run_state_step_index/);
  });
});

describe("signActorClaim", () => {
  it("produces a 3-segment JWT that verifies against the matching public key", async () => {
    const jwt = await signActorClaim({ ctx: baseCtx, nowSeconds: 1_700_000_000 });
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8"));
    expect(header).toMatchObject({ alg: "ES256", typ: "JWT", kid: "paperclip-test-kid" });

    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    expect(payload.actor_type).toBe("agent");
    expect(payload.surface).toBe("paperclip");
    expect(payload.task_id).toBe("task-1234");

    // Verify ES256: convert P1363 r||s back to DER, then verify.
    const rawSig = Buffer.from(sigB64!, "base64url");
    expect(rawSig).toHaveLength(64);
    const der = p1363ToDer(rawSig);
    const verifier = createVerify("SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const ok = verifier.verify(
      createPublicKey({ key: publicKeyDer, format: "der", type: "spki" }),
      der,
    );
    expect(ok).toBe(true);
  });

  it("throws when no private key is configured", async () => {
    delete process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM;
    delete process.env.PAPERCLIP_JWT_PRIVATE_KEY_PATH;
    resetActorClaimKeyCache();

    await expect(
      signActorClaim({ ctx: baseCtx, nowSeconds: 1_700_000_000 }),
    ).rejects.toThrow(/PAPERCLIP_JWT_PRIVATE_KEY/);
  });

  it("uses a non-EC key as a hard failure", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    resetActorClaimKeyCache();

    await expect(
      signActorClaim({ ctx: baseCtx, nowSeconds: 1_700_000_000 }),
    ).rejects.toThrow(/EC \(P-256\)/);
  });
});

describe("_actorClaimInternals", () => {
  it("base64UrlEncode strips padding and uses URL-safe alphabet", () => {
    const encoded = _actorClaimInternals.base64UrlEncode("hello?world>");
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });
});

// ---------------------------------------------------------------------------
// Test helper — convert P1363 (raw r||s) back to ASN.1 DER for verify().
// ---------------------------------------------------------------------------

function p1363ToDer(raw: Buffer): Buffer {
  const half = raw.length / 2;
  const r = stripLeadingZeros(raw.subarray(0, half));
  const s = stripLeadingZeros(raw.subarray(half));
  const rEnc = encodeInteger(r);
  const sEnc = encodeInteger(s);
  const seqBody = Buffer.concat([rEnc, sEnc]);
  return Buffer.concat([Buffer.from([0x30, seqBody.length]), seqBody]);
}

function stripLeadingZeros(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let result = buf.subarray(i);
  // ASN.1 INTEGER must not have the high bit set without a leading 0x00.
  if ((result[0]! & 0x80) !== 0) result = Buffer.concat([Buffer.from([0]), result]);
  return result;
}

function encodeInteger(intBuf: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x02, intBuf.length]), intBuf]);
}
