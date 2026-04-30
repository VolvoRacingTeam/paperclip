/**
 * M2.2 — Fikenverktøy MCP wrapper-tools exposed to agents.
 *
 * Per `paperclip-tier-b-mcp-wireup-spec.md` §1.2 (per-capability wrapper, not
 * generic dispatch) and §7 (M2.2 read-only swap = 3 approved+visible tools):
 *
 *   fikenverktoy_accounts_list          ↔ fiken.accounts.list
 *   fikenverktoy_data_check_existing    ↔ fiken.data.check_existing
 *   fikenverktoy_journal_build_free     ↔ fiken.journal.build_free
 *
 * Destructive write capabilities (upsert_with_lines, invoice_send,
 * journal_entry_create, attachments_replace, contact_upsert) are scoped to
 * M2.4+ in the spec — schemas added but the canonical names are NOT yet
 * exposed because Codex' Fikenverktøy 0.1.0-rc.1 has them candidate-gated.
 * They will activate when the operator adds the wrapper-tool name to
 * agent.adapterConfig.fikenverktoy_mcp_enabled_tools[].
 *
 * Feature-flag (per spec §3.1): the adapter filters this list against
 * agent.adapterConfig.fikenverktoy_mcp_enabled_tools — empty = nothing
 * exposed (default), so legacy fiken_* tools keep working until cutover.
 *
 * The executor is a thin shim over FikenMcpClient.callTool from M2.1; it
 * builds an McpCallContext per call and translates the wrapper-tool name
 * back to the canonical dot-form before dispatching.
 */

import type { ToolDefinition } from "./schema.js";
import type { FikenMcpClient, McpCallContext, McpToolResult } from "./fiken-mcp/index.js";

// ---------------------------------------------------------------------------
// Capability registry
// ---------------------------------------------------------------------------

export type FikenMcpCapabilityKind = "read" | "write" | "mutating";

export interface FikenMcpCapability {
  /** Wrapper-tool name (snake_case, agent-facing). */
  wrapperName: string;
  /** Canonical Fikenverktøy MCP capability id (dot-form). */
  canonicalName: string;
  /** Read / write / mutating. Drives audit + approval semantics. */
  kind: FikenMcpCapabilityKind;
  /** OAuth-style scope strings sent in the actor-claim. */
  scope: readonly string[];
  /** Whether Codex has promoted the capability to approved+visible. */
  approvedAndVisible: boolean;
  /** OpenAI-style tool definition. */
  toolDefinition: ToolDefinition;
}

// Read-only capabilities (spec §7 — M2.2 scope, already approved+visible).
const READ_CAPABILITIES: readonly FikenMcpCapability[] = [
  {
    wrapperName: "fikenverktoy_accounts_list",
    canonicalName: "fiken.accounts.list",
    kind: "read",
    scope: ["fiken.accounts.read"],
    approvedAndVisible: true,
    toolDefinition: {
      name: "fikenverktoy_accounts_list",
      description:
        "List Fiken-kontoplan via Fikenverktøy MCP. Returnerer kontonummer, " +
        "navn og type for selskapet i agent-konteksten. Bruk denne i stedet " +
        "for fiken_get_accounts når Tore har aktivert MCP-cutover.",
      parametersSchema: {
        type: "object",
        properties: {
          fromAccount: {
            type: "integer",
            description: "Filtrer fra kontonummer (f.eks. 6000).",
          },
          toAccount: {
            type: "integer",
            description: "Filtrer til kontonummer (f.eks. 7999).",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    wrapperName: "fikenverktoy_data_check_existing",
    canonicalName: "fiken.data.check_existing",
    kind: "read",
    scope: ["fiken.data.read"],
    approvedAndVisible: true,
    toolDefinition: {
      name: "fikenverktoy_data_check_existing",
      description:
        "Sjekk om en ressurs allerede finnes i Fiken (faktura-utkast, kontakt, " +
        "bilag) før du forsøker å opprette ny. Bruker server-side fingerprint " +
        "for å unngå duplikater.",
      parametersSchema: {
        type: "object",
        properties: {
          resourceType: {
            type: "string",
            enum: ["invoice_draft", "contact", "purchase", "journal_entry"],
            description: "Hvilken type ressurs som sjekkes.",
          },
          fingerprint: {
            type: "string",
            description:
              "Klient-side hint (valgfri). MCP beregner sin egen kanoniske hash.",
          },
          payload: {
            type: "object",
            description:
              "Normalisert payload som matcher fingerprint-input for ressurstypen.",
            additionalProperties: true,
          },
        },
        required: ["resourceType", "payload"],
        additionalProperties: false,
      },
    },
  },
  {
    wrapperName: "fikenverktoy_journal_build_free",
    canonicalName: "fiken.journal.build_free",
    kind: "read",
    scope: ["fiken.journal.read"],
    approvedAndVisible: true,
    toolDefinition: {
      name: "fikenverktoy_journal_build_free",
      description:
        "Bygg et fri-form journal-forslag (debet/kredit-linjer) basert på " +
        "kontekst. Returnerer policy-evaluering, men gjør ingen writes — " +
        "egnet for dry-run før Regnskapsfører eller Periodisk eskalerer til " +
        "Kvalitetskontrollør.",
      parametersSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Bokføringsdato (YYYY-MM-DD).",
          },
          description: {
            type: "string",
            description: "Beskrivelse av posten.",
          },
          lines: {
            type: "array",
            description: "Debet/kredit-linjer.",
            items: {
              type: "object",
              properties: {
                accountCode: { type: "string" },
                debitOreNok: { type: "integer", minimum: 0 },
                creditOreNok: { type: "integer", minimum: 0 },
                vatType: {
                  type: "string",
                  enum: ["HIGH", "MEDIUM", "LOW", "NONE", "EXEMPT"],
                },
              },
              required: ["accountCode"],
              additionalProperties: false,
            },
            minItems: 2,
          },
        },
        required: ["date", "description", "lines"],
        additionalProperties: false,
      },
    },
  },
] as const;

// Write capabilities — schemas defined for forward-compatibility with M2.4+.
// These will only be exposed when:
//   1. Codex flips fiken.<cap> to approved+visible in Fikenverktøy 0.1.0+
//   2. Operator adds the wrapper name to adapter_config.fikenverktoy_mcp_enabled_tools
const WRITE_CAPABILITIES: readonly FikenMcpCapability[] = [
  {
    wrapperName: "fikenverktoy_invoice_drafts_upsert_with_lines",
    canonicalName: "fiken.invoice_drafts.upsert_with_lines",
    kind: "write",
    scope: ["fiken.invoice_drafts.write"],
    approvedAndVisible: false, // candidate-gated to ~2026-05-04 per memory
    toolDefinition: {
      name: "fikenverktoy_invoice_drafts_upsert_with_lines",
      description:
        "Opprett eller oppdater et faktura-utkast med linjer i Fiken via " +
        "Fikenverktøy MCP. Sett dryRun=true første gang for å se " +
        "policy-evaluering. Skrive-tilgang krever at capabilityen er " +
        "approved+visible — wrapperen returnerer pending_human hvis ikke.",
      parametersSchema: {
        type: "object",
        properties: {
          dryRun: { type: "boolean" },
          contactId: { type: "string" },
          issueDate: { type: "string", description: "YYYY-MM-DD." },
          dueDate: { type: "string", description: "YYYY-MM-DD." },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                description: { type: "string" },
                quantity: { type: "number" },
                unitPriceOreNok: { type: "integer" },
                vatType: { type: "string" },
                accountCode: { type: "string" },
              },
              required: ["description", "quantity", "unitPriceOreNok"],
              additionalProperties: false,
            },
            minItems: 1,
          },
        },
        required: ["issueDate", "lines"],
        additionalProperties: false,
      },
    },
  },
  {
    wrapperName: "fikenverktoy_contacts_upsert",
    canonicalName: "fiken.contacts.find_or_create",
    kind: "write",
    scope: ["fiken.contacts.write"],
    approvedAndVisible: false,
    toolDefinition: {
      name: "fikenverktoy_contacts_upsert",
      description:
        "Finn eller opprett en kontakt (kunde/leverandør) i Fiken via MCP. " +
        "Idempotent på (orgNumber, name).",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          orgNumber: { type: "string" },
          email: { type: "string" },
          isCustomer: { type: "boolean" },
          isSupplier: { type: "boolean" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    wrapperName: "fikenverktoy_journal_entries_create",
    canonicalName: "fiken.journal_entries.create",
    kind: "write",
    scope: ["fiken.journal_entries.write"],
    approvedAndVisible: false,
    toolDefinition: {
      name: "fikenverktoy_journal_entries_create",
      description:
        "Opprett en journalpost i Fiken (manuell bilagsføring). Krever " +
        "balansert debet/kredit. Pending_human når approval er påkrevd.",
      parametersSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          description: { type: "string" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                accountCode: { type: "string" },
                debitOreNok: { type: "integer", minimum: 0 },
                creditOreNok: { type: "integer", minimum: 0 },
                vatType: { type: "string" },
              },
              required: ["accountCode"],
              additionalProperties: false,
            },
            minItems: 2,
          },
        },
        required: ["date", "description", "lines"],
        additionalProperties: false,
      },
    },
  },
];

const ALL_CAPABILITIES: readonly FikenMcpCapability[] = [
  ...READ_CAPABILITIES,
  ...WRITE_CAPABILITIES,
];

const CAPABILITIES_BY_WRAPPER_NAME: ReadonlyMap<string, FikenMcpCapability> =
  new Map(ALL_CAPABILITIES.map((c) => [c.wrapperName, c]));

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Full registry of MCP wrapper-tools (read + forward-compat writes).
 * The adapter MUST filter this against the agent's
 * `adapterConfig.fikenverktoy_mcp_enabled_tools` allowlist before adding
 * to the tool-loop catalog (default empty = none exposed).
 */
export const FIKEN_MCP_CAPABILITIES = ALL_CAPABILITIES;

/** Tool definitions for ALL capabilities (read + write). Filter before use. */
export const FIKEN_MCP_TOOL_DEFINITIONS: readonly ToolDefinition[] =
  ALL_CAPABILITIES.map((c) => c.toolDefinition);

/** True if the tool name is a registered Fikenverktøy MCP wrapper-tool. */
export function isFikenMcpTool(name: string): boolean {
  return CAPABILITIES_BY_WRAPPER_NAME.has(name);
}

/** Look up a capability descriptor by wrapper-tool name. */
export function getFikenMcpCapability(
  wrapperName: string,
): FikenMcpCapability | undefined {
  return CAPABILITIES_BY_WRAPPER_NAME.get(wrapperName);
}

/**
 * Resolve which wrapper-tool definitions to expose for an agent, given the
 * `adapterConfig.fikenverktoy_mcp_enabled_tools` allowlist. Returns []
 * if the allowlist is missing/empty (default behaviour — tools hidden).
 */
export function resolveEnabledFikenMcpTools(
  adapterConfig: unknown,
): ToolDefinition[] {
  const allowlist = readEnabledToolsList(adapterConfig);
  if (allowlist.length === 0) return [];
  return ALL_CAPABILITIES.filter((c) => allowlist.includes(c.wrapperName)).map(
    (c) => c.toolDefinition,
  );
}

function readEnabledToolsList(adapterConfig: unknown): string[] {
  if (!adapterConfig || typeof adapterConfig !== "object") return [];
  const raw = (adapterConfig as { fikenverktoy_mcp_enabled_tools?: unknown })
    .fikenverktoy_mcp_enabled_tools;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Per-tool-call context that the adapter must build. */
export interface FikenMcpExecutorContext {
  agentId: string;
  agentName: string;
  /** Paperclip companyId — used as MCP tenantId (open Q4 in spec — refine if it diverges). */
  tenantId: string;
  /** runId from AdapterExecutionContext. */
  runId: string;
  /** Paperclip task UUID — falls back to runId when no separate task is set. */
  taskId: string;
  /** Stable across all tool-calls within one task; ULID. Adapter generates per executeAdapter call. */
  correlationId: string;
  /** 0-based step counter within the run; adapter increments per tool call. */
  stepIndex: number;
  /** Optional override; falls back to AgentRunStateStore.getFikenCompanySlug. */
  companySlug?: string;
}

/**
 * Build a stateless executor that routes wrapper-tool calls to FikenMcpClient.
 * The adapter wires this once at boot (when env is configured) and dispatches
 * per call by calling executor(name, args, ctx).
 */
export function buildFikenMcpToolExecutor(client: FikenMcpClient) {
  return async function executeFikenMcpTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: FikenMcpExecutorContext,
  ): Promise<unknown> {
    const capability = CAPABILITIES_BY_WRAPPER_NAME.get(toolName);
    if (!capability) {
      return {
        error:
          `Ukjent Fikenverktøy MCP-verktøy '${toolName}'. ` +
          `Forventet et av: ${[...CAPABILITIES_BY_WRAPPER_NAME.keys()].join(", ")}.`,
      };
    }

    if (!capability.approvedAndVisible) {
      // Per spec §3.1 — capability not yet promoted by Codex; surface as
      // pending so the agent can mark awaits_human and Tore can manually
      // check status before flipping the flag.
      return {
        kind: "pending_human",
        toolName: capability.canonicalName,
        blockedBy: ["capability_not_yet_approved"],
        message:
          `Fikenverktøy capability '${capability.canonicalName}' er ikke ` +
          "approved+visible ennå. Vent på 0.1.0-rc.1 fra Codex før retry.",
      };
    }

    const mcpCtx: McpCallContext = {
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      taskId: ctx.taskId,
      stepIndex: ctx.stepIndex,
      scope: capability.scope,
      correlationId: ctx.correlationId,
      companySlug: ctx.companySlug,
    };

    let result: McpToolResult;
    try {
      result = await client.callTool({
        toolName: capability.canonicalName,
        arguments: args,
        ctx: mcpCtx,
      });
    } catch (err) {
      // IdempotencyKeyConflictError + MissingFikenCompanySlugError both surface
      // as escalation-worthy errors per spec §4.
      return {
        error: (err as Error).message,
        kind: "error",
        retriable: false,
      };
    }

    return shapeMcpResultForAgent(result);
  };
}

/**
 * Project an McpToolResult down to the JSON shape the agent sees in tool
 * output. The tool-loop logs the full object; this strips raw HTTP envelopes
 * to keep prompts small and predictable.
 */
export function shapeMcpResultForAgent(result: McpToolResult): unknown {
  const base: Record<string, unknown> = {
    kind: result.kind,
    toolName: result.toolName,
    isReplay: result.isReplay,
  };
  if (result.audit?.correlationId) base.correlationId = result.audit.correlationId;
  if (result.audit?.requestId) base.requestId = result.audit.requestId;
  if (result.audit?.capabilityKind) base.capabilityKind = result.audit.capabilityKind;
  if (result.audit?.compensationStatus) {
    base.compensationStatus = result.audit.compensationStatus;
  }

  switch (result.kind) {
    case "success":
    case "partial":
    case "replay":
      base.data = result.data;
      return base;
    case "pending_human":
      base.blockedBy = [...result.blockedBy];
      if (result.pendingApprovalId) base.pendingApprovalId = result.pendingApprovalId;
      return base;
    case "blocked":
      base.blockedBy = [...result.blockedBy];
      return base;
    case "error":
      base.code = result.code;
      base.message = result.message;
      base.retriable = result.retriable;
      return base;
  }
}
