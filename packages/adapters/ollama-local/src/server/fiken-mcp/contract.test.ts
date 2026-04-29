/**
 * Contract test for the Fikenverktøy MCP wrapper-laget.
 *
 * Verifies round-trip parity with Codex' canonical fixture
 * `Fikenverktøy/fixtures/paperclip/fiken-invoice-draft-upsert-smoke.json`
 * (commit 5cb335f). If Codex changes the fixture (e.g. tightens normalisation
 * → planHash drifts), this test fails — coordinate in
 * `fiken-mcp-konsolidering-og-audit` thread before re-syncing.
 *
 * Spec § 5.2 (paperclip-tier-b-mcp-wireup-spec.md).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  FikenAccessTokenFetcher,
  FikenMcpClient,
  InMemoryAgentRunStateStore,
  type McpCallContext,
} from "./index.js";

const PLAN_HASH_BASELINE =
  "7eed046114bf16ee438f50abd5134e673573c479520a0c79beaf44b5afc08763";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "fiken-invoice-draft-upsert-smoke.json",
);

interface Fixture {
  _planHashBaseline: string;
  request: { tool: string; arguments: Record<string, unknown> };
  response: {
    status: string;
    data: Record<string, unknown>;
    audit: {
      correlation_id: string;
      request_id: string;
      plan_hash: string;
      capability_id: string;
      capability_kind: "read" | "write" | "mutating";
      compensation_status: string;
    };
  };
}

function loadFixture(): Fixture {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as Fixture;
}

const ctx: McpCallContext = {
  agentId: "agent-regnskapsforer",
  agentName: "Regnskapsfører",
  tenantId: "tenant-verkvelven",
  runId: "run-contract-1",
  taskId: "task-contract-1",
  stepIndex: 0,
  scope: ["fiken.invoice_drafts.write"],
  correlationId: "01HXYZ0000000000000000CORR",
  companySlug: "fiken-demo-total-blomst-as",
};

describe("Fikenverktøy MCP wrapper — contract test against fixture", () => {
  it("baseline planHash in fixture matches the published value", () => {
    const fixture = loadFixture();
    expect(fixture._planHashBaseline).toBe(PLAN_HASH_BASELINE);
    expect(fixture.response.audit.plan_hash).toBe(PLAN_HASH_BASELINE);
  });

  it("wrapper sends a JSON-RPC envelope that matches the fixture's expected request", async () => {
    const fixture = loadFixture();
    const calls: { url: string; init: RequestInit | undefined }[] = [];

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "ignored",
          result: fixture.response,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const tokenFetcher = new FikenAccessTokenFetcher({
      apiKey: "test-agent-key",
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            accessToken: "fiken-pat-contract",
            companySlug: "fiken-demo-total-blomst-as",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ) as unknown as typeof fetch,
      nowMs: () => 0,
    });

    const client = new FikenMcpClient({
      endpoint: "https://fikenverktoy.test",
      mcpPath: "/api/mcp",
      store: new InMemoryAgentRunStateStore(),
      tokenFetcher,
      fetchImpl,
      maxRetries: 0,
      backoffMs: [],
      signActorClaim: async () => "test.jwt.signature",
    });

    const result = await client.callTool({
      toolName: fixture.request.tool,
      arguments: fixture.request.arguments,
      ctx,
    });

    expect(calls).toHaveLength(1);
    const sentBody = JSON.parse(calls[0]!.init?.body as string);
    expect(sentBody.jsonrpc).toBe("2.0");
    expect(sentBody.method).toBe("tools/call");
    expect(sentBody.params.name).toBe(fixture.request.tool);
    expect(sentBody.params.arguments).toEqual(fixture.request.arguments);
    expect(sentBody.params.idempotency_key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-MCP-Actor-Claim"]).toBe("test.jwt.signature");
    expect(headers["X-Fiken-Access-Token"]).toBe("fiken-pat-contract");

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.audit.planHash).toBe(PLAN_HASH_BASELINE);
      expect(result.audit.capabilityId).toBe(fixture.request.tool);
      expect(result.audit.capabilityKind).toBe("write");
      expect(result.audit.compensationStatus).toBe("not_required");
      expect(result.audit.correlationId).toBe(ctx.correlationId);
    }
  });

  it("preserves the planHash on a same-payload replay", async () => {
    const fixture = loadFixture();
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "1", result: fixture.response }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "2",
          result: {
            idempotency_replay: true,
            data: fixture.response.data,
            audit: fixture.response.audit,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const tokenFetcher = new FikenAccessTokenFetcher({
      apiKey: "test-agent-key",
      fetchImpl: vi.fn(async () =>
        new Response(
          JSON.stringify({
            accessToken: "fiken-pat-replay",
            companySlug: "fiken-demo-total-blomst-as",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ) as unknown as typeof fetch,
      nowMs: () => 0,
    });

    const store = new InMemoryAgentRunStateStore();
    const client = new FikenMcpClient({
      endpoint: "https://fikenverktoy.test",
      mcpPath: "/api/mcp",
      store,
      tokenFetcher,
      fetchImpl,
      maxRetries: 0,
      backoffMs: [],
      signActorClaim: async () => "test.jwt.signature",
    });

    const first = await client.callTool({
      toolName: fixture.request.tool,
      arguments: fixture.request.arguments,
      ctx,
    });
    const second = await client.callTool({
      toolName: fixture.request.tool,
      arguments: fixture.request.arguments,
      ctx,
    });

    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(second.kind).toBe("replay");
    expect(second.audit.planHash).toBe(PLAN_HASH_BASELINE);
  });
});
