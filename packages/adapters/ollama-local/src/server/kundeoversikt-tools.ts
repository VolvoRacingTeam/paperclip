/**
 * Built-in Kundeoversikt tools for the ollama_local adapter.
 *
 * These tools let E-postansvarlig (and other agents) interact with
 * Kundeoversikt's agent API directly from the tool-loop, without
 * requiring a full Paperclip plugin installation.
 *
 * Environment variables (set in /opt/paperclip/.env):
 *   AGENT_API_KEY            — Bearer token for Kundeoversikt agent API
 *   KUNDEOVERSIKT_DRAFTS_URL — Base URL for drafts endpoint
 *   KUNDEOVERSIKT_ORG_ID     — Organization UUID for Verkvelven AS
 */

import type { ToolDefinition } from "./schema.js";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

function baseUrl(): string {
  const draftsUrl = env("KUNDEOVERSIKT_DRAFTS_URL", "https://www.kundeoversikt.no/api/agent/drafts");
  // Strip /drafts to get /api/agent base
  return draftsUrl.replace(/\/drafts$/, "");
}

function orgId(): string {
  return env("KUNDEOVERSIKT_ORG_ID");
}

function apiKey(): string {
  return env("AGENT_API_KEY");
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function agentFetch(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
        ...(options?.headers as Record<string, string> ?? {}),
      },
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${JSON.stringify(body)}` };
    }
    return body;
  } catch (err) {
    return { error: `Fetch failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tool definitions (for JSON schema)
// ---------------------------------------------------------------------------

export const KUNDEOVERSIKT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "kundeoversikt_list_unprocessed_emails",
    description:
      "Hent liste over innkommende e-poster som ikke har blitt besvart ennå. " +
      "Returnerer e-poster med subject, bodyText, avsender, kunde-info og ID-er. " +
      "Kall dette FØRST i hver kjøring for å finne nye e-poster å besvare.",
    parametersSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maks antall e-poster å hente (1-50). Standard: 5.",
          minimum: 1,
          maximum: 50,
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "kundeoversikt_get_customer_context",
    description:
      "Hent full kundekontekst for en spesifikk kunde. " +
      "Inkluderer kundedata (navn, bransje, kontaktpersoner), preferanser, " +
      "regnskapsinstruksjoner, kjente utfordringer, og siste observasjoner. " +
      "Bruk customerId fra e-post-listen.",
    parametersSchema: {
      type: "object",
      properties: {
        customerId: {
          type: "string",
          description: "UUID for kunden (fra e-post-listens customerId-felt).",
        },
      },
      required: ["customerId"],
      additionalProperties: false,
    },
  },
  {
    name: "kundeoversikt_create_draft_reply",
    description:
      "Opprett et svar-utkast som venter på manuell godkjenning i Kundeoversikt. " +
      "Tore ser utkastet i e-post-huben og kan godkjenne eller avvise det. " +
      "INGEN e-post sendes uten at Tore har godkjent. " +
      "Bruk replyToEmailLogId fra e-post-listen for å lenke svaret til riktig tråd.",
    parametersSchema: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "Mottaker-e-postadresser.",
        },
        subject: {
          type: "string",
          description: "E-post-emne (typisk 'Sv: <original emne>').",
        },
        bodyHtml: {
          type: "string",
          description: "HTML-innhold for svaret. Bruk <p>-tagger for avsnitt.",
        },
        replyToEmailLogId: {
          type: "string",
          description: "UUID for den innkommende e-posten dette svarer på.",
        },
        customerId: {
          type: "string",
          description: "UUID for kunden (valgfri, men anbefalt for sporbarhet).",
        },
        aiReasoning: {
          type: "string",
          description:
            "Din begrunnelse for svarforslaget. Vises til Tore i UI-et. " +
            "Forklar kort hva du baserte svaret på.",
        },
        aiConfidence: {
          type: "number",
          description: "Konfidensnivå 0.0-1.0 for forslaget.",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["to", "subject", "bodyHtml", "replyToEmailLogId", "aiReasoning", "aiConfidence"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

/**
 * Execute a Kundeoversikt built-in tool. Returns the API response or error.
 */
export async function executeKundeoversiktTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "kundeoversikt_list_unprocessed_emails": {
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const raw = await agentFetch(
        `/emails/unprocessed?organizationId=${orgId()}&limit=${limit}`,
      ) as Record<string, unknown>;
      // Truncate email bodies to prevent context overflow (llama.cpp 16K ctx)
      if (raw.emails && Array.isArray(raw.emails)) {
        raw.emails = (raw.emails as Array<Record<string, unknown>>).map((e) => ({
          id: e.id,
          subject: e.subject,
          bodyText: typeof e.bodyText === "string" ? (e.bodyText as string).slice(0, 2000) : "",
          from: e.from,
          fromName: e.fromName,
          receivedAt: e.receivedAt,
          customerId: e.customerId,
          customerName: e.customerName,
          graphConversationId: e.graphConversationId,
          hasAttachments: e.hasAttachments,
          // bodyHtml intentionally omitted — too large for context
        }));
      }
      return raw;
    }

    case "kundeoversikt_get_customer_context": {
      const customerId = args.customerId as string;
      if (!customerId) return { error: "customerId er påkrevd" };
      return agentFetch(
        `/customers/${customerId}/context?organizationId=${orgId()}`,
      );
    }

    case "kundeoversikt_create_draft_reply": {
      const body = {
        organizationId: orgId(),
        agentName: "paperclip-email-assistant",
        to: args.to,
        cc: [],
        subject: args.subject,
        bodyHtml: args.bodyHtml,
        customerId: args.customerId ?? null,
        replyToEmailLogId: args.replyToEmailLogId ?? null,
        aiReasoning: args.aiReasoning ?? "",
        aiConfidence: typeof args.aiConfidence === "number" ? args.aiConfidence : 0.5,
      };
      return agentFetch("/drafts", {
        method: "POST",
        body: JSON.stringify(body),
      });
    }

    default:
      return { error: `Ukjent Kundeoversikt-verktøy: ${toolName}` };
  }
}

/**
 * Check if a tool name is a Kundeoversikt built-in tool.
 */
export function isKundeoversiktTool(name: string): boolean {
  return name.startsWith("kundeoversikt_");
}
