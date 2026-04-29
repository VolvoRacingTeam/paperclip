import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FikenAccessTokenFetcher,
  FikenMcpClient,
  IdempotencyKeyConflictError,
  InMemoryAgentRunStateStore,
  MissingFikenCompanySlugError,
  type McpCallContext,
} from "./index.js";

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function makeMockFetch(
  responder: (call: MockFetchCall) => Promise<Response> | Response,
) {
  const calls: MockFetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responder({ url, init });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function jsonRpcSuccess(body: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: "x", result: body }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonRpcError(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "x",
      error: { code, message },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function rawHttp(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const baseCtx: McpCallContext = {
  agentId: "agent-1",
  agentName: "Bankavstemmer",
  tenantId: "tenant-1",
  runId: "run-1",
  taskId: "task-1",
  stepIndex: 0,
  scope: ["fiken.read", "fiken.write"],
  correlationId: "01HXYZ0000000000000000CORR",
  companySlug: "fiken-demo-total-blomst-as",
};

function buildClient(opts: {
  fetchImpl: typeof fetch;
  store?: InMemoryAgentRunStateStore;
  tokenFetcher?: FikenAccessTokenFetcher;
  maxRetries?: number;
  backoffMs?: readonly number[];
}) {
  const store = opts.store ?? new InMemoryAgentRunStateStore();
  const tokenFetcher =
    opts.tokenFetcher ??
    new FikenAccessTokenFetcher({
      apiKey: "test-agent-key",
      fetchImpl: vi.fn(async () =>
        rawHttp(200, {
          accessToken: "fiken-pat-test",
          companySlug: "fiken-demo-total-blomst-as",
        }),
      ) as unknown as typeof fetch,
      nowMs: () => 0,
    });
  return new FikenMcpClient({
    endpoint: "https://fikenverktoy.test",
    mcpPath: "/api/mcp",
    store,
    tokenFetcher,
    fetchImpl: opts.fetchImpl,
    nowMs: () => 1_700_000_000_000,
    maxRetries: opts.maxRetries ?? 3,
    backoffMs: opts.backoffMs ?? [0, 0, 0],
    signActorClaim: async () => "test.jwt.signature",
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FikenMcpClient.callTool — happy path", () => {
  it("posts a JSON-RPC envelope with idempotency_key and headers", async () => {
    const { fn, calls } = makeMockFetch(() =>
      jsonRpcSuccess({
        status: "success",
        data: { id: "draft-123" },
        audit: {
          correlation_id: "01HXYZ0000000000000000CORR",
          request_id: "req-abc",
          plan_hash: "7eed046114bf16ee438f50abd5134e673573c479520a0c79beaf44b5afc08763",
          capability_id: "fiken.invoice_drafts.upsert_with_lines",
          capability_kind: "write",
          compensation_status: "not_required",
        },
      }),
    );
    const client = buildClient({ fetchImpl: fn });

    const res = await client.callTool({
      toolName: "fiken.invoice_drafts.upsert_with_lines",
      arguments: { externalRef: "ko-billing-1-2026Q1", amountOre: 100_000 },
      ctx: baseCtx,
    });

    expect(res.kind).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://fikenverktoy.test/api/mcp");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-MCP-Actor-Claim"]).toBe("test.jwt.signature");
    expect(headers["X-Fiken-Access-Token"]).toBe("fiken-pat-test");
    expect(headers["X-Idempotency-Key"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "fiken.invoice_drafts.upsert_with_lines",
        arguments: { externalRef: "ko-billing-1-2026Q1", amountOre: 100_000 },
      },
    });
    expect(body.params.idempotency_key).toBe(headers["X-Idempotency-Key"]);
    if (res.kind === "success") {
      expect(res.audit.planHash).toBe(
        "7eed046114bf16ee438f50abd5134e673573c479520a0c79beaf44b5afc08763",
      );
      expect(res.audit.capabilityKind).toBe("write");
    }
  });

  it("preserves the same idempotency_key on a same-payload replay", async () => {
    let callCount = 0;
    const { fn } = makeMockFetch(() => {
      callCount += 1;
      if (callCount === 1) {
        return jsonRpcSuccess({ status: "success", data: { id: "first" } });
      }
      return jsonRpcSuccess({
        idempotency_replay: true,
        data: { id: "first" },
        audit: {
          correlation_id: baseCtx.correlationId,
          plan_hash: "deadbeef",
        },
      });
    });
    const store = new InMemoryAgentRunStateStore();
    const client = buildClient({ fetchImpl: fn, store });

    const first = await client.callTool({
      toolName: "fiken.invoice_drafts.upsert_with_lines",
      arguments: { x: 1 },
      ctx: baseCtx,
    });
    const second = await client.callTool({
      toolName: "fiken.invoice_drafts.upsert_with_lines",
      arguments: { x: 1 },
      ctx: baseCtx,
    });

    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(second.kind).toBe("replay");
    expect(second.isReplay).toBe(true);
  });
});

describe("FikenMcpClient.callTool — replay/conflict semantics", () => {
  it("throws IdempotencyKeyConflictError when same step has different payload", async () => {
    const { fn } = makeMockFetch(() =>
      jsonRpcSuccess({ status: "success", data: { ok: true } }),
    );
    const store = new InMemoryAgentRunStateStore();
    const client = buildClient({ fetchImpl: fn, store });

    await client.callTool({
      toolName: "fiken.contacts.create",
      arguments: { name: "Acme" },
      ctx: baseCtx,
    });

    await expect(
      client.callTool({
        toolName: "fiken.contacts.create",
        arguments: { name: "Different" },
        ctx: baseCtx,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it("flags MCP-side replay (idempotency_replay=true)", async () => {
    const { fn } = makeMockFetch(() =>
      jsonRpcSuccess({
        idempotency_replay: true,
        data: { ok: true },
        audit: { correlation_id: baseCtx.correlationId },
      }),
    );
    const client = buildClient({ fetchImpl: fn });

    const res = await client.callTool({
      toolName: "fiken.contacts.create",
      arguments: { name: "Acme" },
      ctx: baseCtx,
    });
    expect(res.kind).toBe("replay");
    expect(res.isReplay).toBe(true);
  });
});

describe("FikenMcpClient.callTool — policy outcomes", () => {
  it("returns kind=blocked when policy blocks the call", async () => {
    const { fn } = makeMockFetch(() =>
      jsonRpcSuccess({
        policy_evaluation: {
          status: "blocked",
          blocked_by: ["above_max_total_amount"],
        },
      }),
    );
    const client = buildClient({ fetchImpl: fn });
    const res = await client.callTool({
      toolName: "fiken.invoice_drafts.upsert_with_lines",
      arguments: { amountOre: 100_000_00 },
      ctx: baseCtx,
    });
    expect(res.kind).toBe("blocked");
    if (res.kind === "blocked") {
      expect(res.blockedBy).toEqual(["above_max_total_amount"]);
    }
  });

  it("returns kind=pending_human when human approval is required", async () => {
    const { fn } = makeMockFetch(() =>
      jsonRpcSuccess({
        policy_evaluation: {
          status: "pending_human",
          blocked_by: ["approval_required"],
          pending_approval_id: "pa-42",
        },
      }),
    );
    const client = buildClient({ fetchImpl: fn });
    const res = await client.callTool({
      toolName: "fiken.invoice_drafts.upsert_with_lines",
      arguments: {},
      ctx: baseCtx,
    });
    expect(res.kind).toBe("pending_human");
    if (res.kind === "pending_human") {
      expect(res.pendingApprovalId).toBe("pa-42");
    }
  });

  it("returns kind=partial when compensation_failed", async () => {
    const { fn } = makeMockFetch(() =>
      jsonRpcSuccess({
        status: "success",
        data: { id: "draft-x" },
        audit: { compensation_status: "compensation_failed" },
      }),
    );
    const client = buildClient({ fetchImpl: fn });
    const res = await client.callTool({
      toolName: "fiken.invoice_drafts.upsert_with_lines",
      arguments: {},
      ctx: baseCtx,
    });
    expect(res.kind).toBe("partial");
  });
});

describe("FikenMcpClient.callTool — retry policy", () => {
  it("retries 503 up to maxRetries and surfaces error after exhaustion", async () => {
    const { fn, calls } = makeMockFetch(() =>
      new Response("upstream", { status: 503 }),
    );
    const client = buildClient({ fetchImpl: fn, maxRetries: 2, backoffMs: [0, 0] });
    const res = await client.callTool({
      toolName: "fiken.contacts.list",
      arguments: {},
      ctx: baseCtx,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.code).toBe("service_unavailable");
    }
    expect(calls.length).toBe(3); // initial + 2 retries
  });

  it("re-signs and retries on 401 actor_claim_expired", async () => {
    let attempt = 0;
    const { fn, calls } = makeMockFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        return jsonRpcError(401, "actor_claim_expired", "expired");
      }
      return jsonRpcSuccess({ status: "success", data: { ok: true } });
    });
    const client = buildClient({ fetchImpl: fn, maxRetries: 1, backoffMs: [0] });
    const res = await client.callTool({
      toolName: "fiken.contacts.list",
      arguments: {},
      ctx: baseCtx,
    });
    expect(res.kind).toBe("success");
    expect(calls.length).toBe(2);
  });

  it("does not retry on 403 forbidden", async () => {
    const { fn, calls } = makeMockFetch(() =>
      jsonRpcError(403, "tenant_mismatch", "wrong tenant"),
    );
    const client = buildClient({ fetchImpl: fn, maxRetries: 3, backoffMs: [0, 0, 0] });
    const res = await client.callTool({
      toolName: "fiken.contacts.list",
      arguments: {},
      ctx: baseCtx,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.code).toBe("tenant_mismatch");
      expect(res.retriable).toBe(false);
    }
    expect(calls.length).toBe(1);
  });
});

describe("FikenMcpClient.callTool — companySlug resolution", () => {
  it("falls back to AgentRunStateStore.getFikenCompanySlug when ctx.companySlug is missing", async () => {
    const { fn, calls } = makeMockFetch(() =>
      jsonRpcSuccess({ status: "success", data: {} }),
    );
    const store = new InMemoryAgentRunStateStore();
    await store.setFikenCompanySlug?.("agent-1", "fiken-demo-total-blomst-as");
    const tokenCalls: string[] = [];
    const tokenFetcher = new FikenAccessTokenFetcher({
      apiKey: "k",
      fetchImpl: vi.fn(async (url: string) => {
        tokenCalls.push(url as string);
        return rawHttp(200, {
          accessToken: "fiken-pat",
          companySlug: "fiken-demo-total-blomst-as",
        });
      }) as unknown as typeof fetch,
      nowMs: () => 0,
    });
    const client = buildClient({ fetchImpl: fn, store, tokenFetcher });

    await client.callTool({
      toolName: "fiken.contacts.list",
      arguments: {},
      ctx: { ...baseCtx, companySlug: undefined },
    });
    expect(calls).toHaveLength(1);
  });

  it("throws MissingFikenCompanySlugError when neither ctx nor store has it", async () => {
    const { fn } = makeMockFetch(() => jsonRpcSuccess({}));
    const store = new InMemoryAgentRunStateStore();
    const client = buildClient({ fetchImpl: fn, store });

    await expect(
      client.callTool({
        toolName: "fiken.contacts.list",
        arguments: {},
        ctx: { ...baseCtx, companySlug: undefined },
      }),
    ).rejects.toBeInstanceOf(MissingFikenCompanySlugError);
  });
});
