import { describe, expect, it, vi } from "vitest";

import type { FikenMcpClient, McpToolResult } from "./fiken-mcp/index.js";
import {
  buildFikenMcpToolExecutor,
  FIKEN_MCP_CAPABILITIES,
  FIKEN_MCP_TOOL_DEFINITIONS,
  getFikenMcpCapability,
  isFikenMcpTool,
  resolveEnabledFikenMcpTools,
  shapeMcpResultForAgent,
  type FikenMcpExecutorContext,
} from "./fiken-mcp-tools.js";

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe("FIKEN_MCP_CAPABILITIES registry", () => {
  it("exposes the three M2.2 read-only capabilities marked approved+visible", () => {
    const reads = FIKEN_MCP_CAPABILITIES.filter(
      (c) => c.kind === "read" && c.approvedAndVisible,
    ).map((c) => c.wrapperName);
    expect(reads).toEqual([
      "fikenverktoy_accounts_list",
      "fikenverktoy_data_check_existing",
      "fikenverktoy_journal_build_free",
    ]);
  });

  it("includes write-capability schemas but flags them not-approved", () => {
    const writes = FIKEN_MCP_CAPABILITIES.filter((c) => c.kind === "write");
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const w of writes) {
      expect(w.approvedAndVisible).toBe(false);
    }
  });

  it("uses snake_case wrapper names and dot-form canonical names", () => {
    for (const c of FIKEN_MCP_CAPABILITIES) {
      expect(c.wrapperName).toMatch(/^fikenverktoy_[a-z][a-z0-9_]*$/);
      expect(c.canonicalName).toMatch(/^fiken\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });

  it("all wrapper names are unique", () => {
    const names = FIKEN_MCP_CAPABILITIES.map((c) => c.wrapperName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all canonical names are unique", () => {
    const names = FIKEN_MCP_CAPABILITIES.map((c) => c.canonicalName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("emits one ToolDefinition per capability", () => {
    expect(FIKEN_MCP_TOOL_DEFINITIONS.length).toBe(FIKEN_MCP_CAPABILITIES.length);
  });

  it("every tool schema is a closed object with required fields", () => {
    for (const def of FIKEN_MCP_TOOL_DEFINITIONS) {
      const schema = def.parametersSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(Array.isArray(schema.required)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

describe("isFikenMcpTool / getFikenMcpCapability", () => {
  it("recognises registered wrapper-tool names", () => {
    expect(isFikenMcpTool("fikenverktoy_accounts_list")).toBe(true);
    expect(isFikenMcpTool("fikenverktoy_data_check_existing")).toBe(true);
    expect(isFikenMcpTool("fikenverktoy_journal_build_free")).toBe(true);
  });

  it("rejects unrelated tool names (legacy fiken_* + arbitrary)", () => {
    expect(isFikenMcpTool("fiken_list_companies")).toBe(false);
    expect(isFikenMcpTool("kundeoversikt_get_inbox")).toBe(false);
    expect(isFikenMcpTool("totally_made_up")).toBe(false);
    expect(isFikenMcpTool("")).toBe(false);
  });

  it("getFikenMcpCapability returns the descriptor for known tools", () => {
    const cap = getFikenMcpCapability("fikenverktoy_accounts_list");
    expect(cap?.canonicalName).toBe("fiken.accounts.list");
    expect(cap?.scope).toEqual(["fiken.accounts.read"]);
  });

  it("returns undefined for unknown tools", () => {
    expect(getFikenMcpCapability("not_a_tool")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Feature-flag filter
// ---------------------------------------------------------------------------

describe("resolveEnabledFikenMcpTools", () => {
  it("returns [] when adapter_config is null/undefined", () => {
    expect(resolveEnabledFikenMcpTools(null)).toEqual([]);
    expect(resolveEnabledFikenMcpTools(undefined)).toEqual([]);
  });

  it("returns [] when fikenverktoy_mcp_enabled_tools is missing", () => {
    expect(resolveEnabledFikenMcpTools({})).toEqual([]);
  });

  it("returns [] when allowlist is empty", () => {
    expect(
      resolveEnabledFikenMcpTools({ fikenverktoy_mcp_enabled_tools: [] }),
    ).toEqual([]);
  });

  it("returns only the tool defs whose names are in the allowlist", () => {
    const enabled = resolveEnabledFikenMcpTools({
      fikenverktoy_mcp_enabled_tools: [
        "fikenverktoy_accounts_list",
        "fikenverktoy_journal_build_free",
      ],
    });
    expect(enabled.map((t) => t.name).sort()).toEqual([
      "fikenverktoy_accounts_list",
      "fikenverktoy_journal_build_free",
    ]);
  });

  it("ignores entries that aren't registered wrapper names", () => {
    const enabled = resolveEnabledFikenMcpTools({
      fikenverktoy_mcp_enabled_tools: [
        "fikenverktoy_accounts_list",
        "not_a_real_tool",
        42, // wrong type
      ] as unknown[],
    });
    expect(enabled.map((t) => t.name)).toEqual(["fikenverktoy_accounts_list"]);
  });

  it("ignores non-array allowlist values", () => {
    expect(
      resolveEnabledFikenMcpTools({
        fikenverktoy_mcp_enabled_tools: "fikenverktoy_accounts_list",
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Executor — name mapping + result shaping
// ---------------------------------------------------------------------------

function makeCtx(): FikenMcpExecutorContext {
  return {
    agentId: "agent-uuid-1",
    agentName: "Regnskapsfører",
    tenantId: "verkvelven-as",
    runId: "run-1",
    taskId: "task-1",
    correlationId: "01HXYZTEST",
    stepIndex: 0,
    companySlug: "fiken-demo-total-blomst-as",
  };
}

function makeStubClient(
  result: McpToolResult,
): { client: FikenMcpClient; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn().mockResolvedValue(result);
  const client = { callTool: spy } as unknown as FikenMcpClient;
  return { client, spy };
}

describe("buildFikenMcpToolExecutor", () => {
  it("translates wrapper name → canonical name when calling the MCP client", async () => {
    const { client, spy } = makeStubClient({
      kind: "success",
      toolName: "fiken.accounts.list",
      idempotencyKey: "01HXIDEMP",
      isReplay: false,
      raw: {},
      audit: { correlationId: "01HXAUDIT", capabilityKind: "read" },
      data: { accounts: [{ code: "1500", name: "Kundefordringer" }] },
    });

    const exec = buildFikenMcpToolExecutor(client);
    const out = (await exec(
      "fikenverktoy_accounts_list",
      { fromAccount: 1000 },
      makeCtx(),
    )) as Record<string, unknown>;

    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0][0];
    expect(call.toolName).toBe("fiken.accounts.list");
    expect(call.arguments).toEqual({ fromAccount: 1000 });
    expect(call.ctx.scope).toEqual(["fiken.accounts.read"]);
    expect(call.ctx.agentId).toBe("agent-uuid-1");
    expect(call.ctx.companySlug).toBe("fiken-demo-total-blomst-as");

    expect(out.kind).toBe("success");
    expect(out.toolName).toBe("fiken.accounts.list");
    expect((out.data as { accounts: unknown[] }).accounts).toHaveLength(1);
    expect(out.correlationId).toBe("01HXAUDIT");
    expect(out.capabilityKind).toBe("read");
  });

  it("returns pending_human (without calling MCP) when capability is not approved", async () => {
    const { client, spy } = makeStubClient({
      kind: "success",
      toolName: "x",
      idempotencyKey: "x",
      isReplay: false,
      raw: {},
      audit: {},
      data: {},
    });
    const exec = buildFikenMcpToolExecutor(client);
    const out = (await exec(
      "fikenverktoy_invoice_drafts_upsert_with_lines",
      {
        issueDate: "2026-04-30",
        lines: [
          { description: "Test", quantity: 1, unitPriceOreNok: 100000 },
        ],
      },
      makeCtx(),
    )) as Record<string, unknown>;

    expect(spy).not.toHaveBeenCalled();
    expect(out.kind).toBe("pending_human");
    expect(out.blockedBy).toEqual(["capability_not_yet_approved"]);
  });

  it("returns an error envelope for unknown tool names", async () => {
    const { client, spy } = makeStubClient({
      kind: "success",
      toolName: "x",
      idempotencyKey: "x",
      isReplay: false,
      raw: {},
      audit: {},
      data: {},
    });
    const exec = buildFikenMcpToolExecutor(client);
    const out = (await exec("not_a_tool", {}, makeCtx())) as Record<
      string,
      unknown
    >;
    expect(spy).not.toHaveBeenCalled();
    expect(typeof out.error).toBe("string");
    expect((out.error as string).toLowerCase()).toContain("ukjent");
  });

  it("propagates IdempotencyKeyConflictError as a non-retriable error envelope", async () => {
    const spy = vi.fn().mockRejectedValue(new Error("Idempotency conflict on (runId=r, stepIndex=0)"));
    const client = { callTool: spy } as unknown as FikenMcpClient;
    const exec = buildFikenMcpToolExecutor(client);
    const out = (await exec(
      "fikenverktoy_accounts_list",
      {},
      makeCtx(),
    )) as Record<string, unknown>;
    expect(out.kind).toBe("error");
    expect(out.retriable).toBe(false);
    expect((out.error as string).toLowerCase()).toContain("idempotency");
  });

  it("shapes pending_human result with blockedBy + pendingApprovalId", async () => {
    const { client } = makeStubClient({
      kind: "pending_human",
      toolName: "fiken.journal.build_free",
      idempotencyKey: "k",
      isReplay: false,
      raw: {},
      audit: {},
      pendingApprovalId: "pa-123",
      blockedBy: ["approval_required"],
    });
    const exec = buildFikenMcpToolExecutor(client);
    const out = (await exec(
      "fikenverktoy_journal_build_free",
      {
        date: "2026-04-30",
        description: "test",
        lines: [
          { accountCode: "1500", debitOreNok: 1000 },
          { accountCode: "1920", creditOreNok: 1000 },
        ],
      },
      makeCtx(),
    )) as Record<string, unknown>;
    expect(out.kind).toBe("pending_human");
    expect(out.blockedBy).toEqual(["approval_required"]);
    expect(out.pendingApprovalId).toBe("pa-123");
  });
});

// ---------------------------------------------------------------------------
// Result shaper (direct unit tests)
// ---------------------------------------------------------------------------

describe("shapeMcpResultForAgent", () => {
  it("includes data for success/partial/replay kinds", () => {
    const success = shapeMcpResultForAgent({
      kind: "success",
      toolName: "fiken.accounts.list",
      idempotencyKey: "k",
      isReplay: false,
      raw: {},
      audit: {},
      data: { ok: true },
    }) as Record<string, unknown>;
    expect(success.kind).toBe("success");
    expect(success.data).toEqual({ ok: true });
  });

  it("includes blockedBy for blocked kind", () => {
    const blocked = shapeMcpResultForAgent({
      kind: "blocked",
      toolName: "fiken.invoice_drafts.upsert_with_lines",
      idempotencyKey: "k",
      isReplay: false,
      raw: {},
      audit: {},
      blockedBy: ["above_max_total_amount"],
    }) as Record<string, unknown>;
    expect(blocked.blockedBy).toEqual(["above_max_total_amount"]);
  });

  it("includes code/message/retriable for error kind", () => {
    const errored = shapeMcpResultForAgent({
      kind: "error",
      toolName: "fiken.accounts.list",
      idempotencyKey: "k",
      isReplay: false,
      raw: {},
      audit: {},
      code: "service_unavailable",
      message: "MCP 503",
      retriable: true,
    }) as Record<string, unknown>;
    expect(errored.code).toBe("service_unavailable");
    expect(errored.retriable).toBe(true);
  });
});
