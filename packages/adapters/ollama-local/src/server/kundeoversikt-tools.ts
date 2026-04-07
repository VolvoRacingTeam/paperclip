/**
 * Built-in Kundeoversikt tools for the ollama_local adapter.
 *
 * 8 tools covering: email listing, customer context, draft replies,
 * email classification, action logging, and prospect management.
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
  // === 1. List unprocessed emails ===
  {
    name: "kundeoversikt_list_unprocessed_emails",
    description:
      "Hent innkommende e-poster som ikke er behandlet. " +
      "Returnerer subject, bodyText (maks 2000 tegn), avsender, kunde-info. " +
      "Kall dette FØRST for å finne nye e-poster.",
    parametersSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maks antall (1-50, standard 10).", minimum: 1, maximum: 50 },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // === 2. Get customer context ===
  {
    name: "kundeoversikt_get_customer_context",
    description:
      "Hent kundekontekst: kundedata, preferanser, regnskapsinstruksjoner, observasjoner. " +
      "Bruk customerId fra e-post-listen.",
    parametersSchema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "UUID for kunden." },
      },
      required: ["customerId"],
      additionalProperties: false,
    },
  },

  // === 3. Create draft reply ===
  {
    name: "kundeoversikt_create_draft_reply",
    description:
      "Opprett svar-utkast som venter på Tores godkjenning. " +
      "INGEN e-post sendes uten godkjenning.",
    parametersSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Mottaker-e-poster." },
        subject: { type: "string", description: "Emne (typisk 'Sv: <original>')." },
        bodyHtml: { type: "string", description: "HTML-svar med <p>-tagger." },
        replyToEmailLogId: { type: "string", description: "UUID for e-posten dette svarer på." },
        customerId: { type: "string", description: "UUID for kunden (valgfri)." },
        aiReasoning: { type: "string", description: "Begrunnelse for svaret — vises til Tore." },
        aiConfidence: { type: "number", description: "Konfidens 0.0-1.0.", minimum: 0, maximum: 1 },
      },
      required: ["to", "subject", "bodyHtml", "replyToEmailLogId", "aiReasoning", "aiConfidence"],
      additionalProperties: false,
    },
  },

  // === 4. Classify email (Fase 2) ===
  {
    name: "kundeoversikt_classify_email",
    description:
      "Klassifiser en e-post etter innholdstype. Kall dette for HVER e-post du behandler. " +
      "Typer: 'prospect' (ny kundehenvendelse), 'bilag' (faktura/kvittering), " +
      "'sporsmal' (spørsmål fra kunde), 'system' (automatisk melding), 'annet'.",
    parametersSchema: {
      type: "object",
      properties: {
        emailLogId: { type: "string", description: "UUID for e-posten." },
        contentCategory: {
          type: "string",
          enum: ["prospect", "bilag", "sporsmal", "system", "annet"],
          description: "Innholdstype.",
        },
        confidence: { type: "number", description: "Konfidens 0.0-1.0.", minimum: 0, maximum: 1 },
        summary: { type: "string", description: "1-2 setningers oppsummering av e-posten." },
        recommendedAction: { type: "string", description: "Anbefalt handling (f.eks. 'route_to_kundebehandler', 'draft_reply', 'skip')." },
      },
      required: ["emailLogId", "contentCategory", "confidence", "summary"],
      additionalProperties: false,
    },
  },

  // === 5. Log action (Fase 1 — allerede deployet) ===
  {
    name: "kundeoversikt_log_action",
    description:
      "Logg en handling i Kundeoversikt (POST /api/agent/actions/log). " +
      "Brukes for sporbarhet og audit-trail. " +
      "Logg ALLE handlinger: klassifisering, prospect-opprettelse, routing, draft-opprettelse. " +
      "Bruk emailLogId og customerId fra listen over ubehandlede e-poster.",
    parametersSchema: {
      type: "object",
      properties: {
        actionType: { type: "string", description: "Type handling: 'classify_email', 'create_prospect', 'route_to_agent', 'draft_reply', 'skip_system_email'." },
        actionSummary: { type: "string", description: "Menneskelig lesbar beskrivelse av handlingen (1-2 setninger)." },
        emailLogId: { type: "string", description: "UUID for e-posten som handlingen gjelder. Hentes fra emailLogId i list_unprocessed_emails." },
        customerId: { type: "string", description: "UUID for kunden. Hentes fra customerId i list_unprocessed_emails." },
        resultSummary: { type: "string", description: "Kort oppsummering av resultatet av handlingen." },
        actionDetails: { type: "object", description: "Valgfri: ekstra strukturert data om handlingen (nøkkel-verdi)." },
        prospectId: { type: "string", description: "Valgfri: UUID for prospect (kun ved prospect-relaterte handlinger)." },
      },
      required: ["actionType", "actionSummary", "emailLogId", "customerId", "resultSummary"],
      additionalProperties: false,
    },
  },

  // === 6. Create prospect (Fase 3) ===
  {
    name: "kundeoversikt_create_prospect",
    description:
      "Opprett en prospect (potensiell ny kunde) i Kundeoversikt. " +
      "Ekstraher info fra e-posten: firmanavn, orgnummer, kontakt-epost, telefon, behov. " +
      "Kundeoversikt kjører automatisk BRREG-oppslag og sanksjonssjekk.",
    parametersSchema: {
      type: "object",
      properties: {
        companyName: { type: "string", description: "Firmanavn (fra e-post/signatur)." },
        orgNumber: { type: "string", description: "9-sifret norsk orgnummer (hvis funnet)." },
        contactEmail: { type: "string", description: "Kontaktpersonens e-post." },
        contactPhone: { type: "string", description: "Telefonnummer (hvis funnet)." },
        contactName: { type: "string", description: "Kontaktpersonens navn." },
        needsDescription: { type: "string", description: "Hva kunden trenger (regnskap, lønn, MVA, etc.)." },
        sourceEmailLogId: { type: "string", description: "UUID for e-posten som utløste dette." },
      },
      required: ["contactEmail", "sourceEmailLogId"],
      additionalProperties: false,
    },
  },

  // === 7. Get prospect ===
  {
    name: "kundeoversikt_get_prospect",
    description: "Hent en prospect med sjekk-resultater og anbefaling.",
    parametersSchema: {
      type: "object",
      properties: {
        prospectId: { type: "string", description: "UUID for prospect." },
      },
      required: ["prospectId"],
      additionalProperties: false,
    },
  },

  // === 8. List prospects ===
  {
    name: "kundeoversikt_list_prospects",
    description: "List prospects filtrert på status.",
    parametersSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["new", "checking", "ready", "converted", "rejected"], description: "Status-filter." },
        limit: { type: "integer", description: "Maks antall (standard 20).", minimum: 1, maximum: 100 },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export async function executeKundeoversiktTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "kundeoversikt_list_unprocessed_emails": {
      const limit = typeof args.limit === "number" ? args.limit : 10;
      const raw = await agentFetch(
        `/emails/unprocessed?organizationId=${orgId()}&limit=${limit}&excludeClassificationMethods=rule_firma_sender`,
      ) as Record<string, unknown>;
      if (raw.emails && Array.isArray(raw.emails)) {
        raw.emails = (raw.emails as Array<Record<string, unknown>>).map((e) => ({
          emailLogId: e.id,
          subject: e.subject,
          bodyText: typeof e.bodyText === "string" ? (e.bodyText as string).slice(0, 2000) : "",
          from: e.from,
          fromName: e.fromName,
          receivedAt: e.receivedAt,
          customerId: e.customerId,
          customerName: e.customerName,
          graphConversationId: e.graphConversationId,
          hasAttachments: e.hasAttachments,
          classificationMethod: e.classificationMethod,
        }));
      }
      return raw;
    }

    case "kundeoversikt_get_customer_context": {
      const customerId = args.customerId as string;
      if (!customerId) return { error: "customerId er påkrevd" };
      return agentFetch(`/customers/${customerId}/context?organizationId=${orgId()}`);
    }

    case "kundeoversikt_create_draft_reply": {
      return agentFetch("/drafts", {
        method: "POST",
        body: JSON.stringify({
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
        }),
      });
    }

    case "kundeoversikt_classify_email": {
      const emailLogId = args.emailLogId as string;
      if (!emailLogId) return { error: "emailLogId er påkrevd" };
      return agentFetch(`/emails/${emailLogId}/classify`, {
        method: "PATCH",
        body: JSON.stringify({
          organizationId: orgId(),
          actorName: "paperclip-email-assistant",
          contentCategory: args.contentCategory,
          confidence: args.confidence,
          summary: args.summary,
          recommendedAction: args.recommendedAction,
        }),
      });
    }

    case "kundeoversikt_log_action": {
      return agentFetch("/actions/log", {
        method: "POST",
        body: JSON.stringify({
          organizationId: orgId(),
          actorName: "paperclip-email-assistant",
          actionType: args.actionType,
          actionSummary: args.actionSummary,
          emailLogId: args.emailLogId,
          customerId: args.customerId,
          resultSummary: args.resultSummary,
          actionDetails: args.actionDetails ?? undefined,
          prospectId: args.prospectId ?? undefined,
        }),
      });
    }

    case "kundeoversikt_create_prospect": {
      return agentFetch("/prospects", {
        method: "POST",
        body: JSON.stringify({
          organizationId: orgId(),
          actorName: "paperclip-email-assistant",
          companyName: args.companyName ?? null,
          orgNumber: args.orgNumber ?? null,
          contactEmail: args.contactEmail,
          contactPhone: args.contactPhone ?? null,
          contactName: args.contactName ?? null,
          needsDescription: args.needsDescription ?? null,
          sourceEmailLogId: args.sourceEmailLogId ?? null,
        }),
      });
    }

    case "kundeoversikt_get_prospect": {
      const prospectId = args.prospectId as string;
      if (!prospectId) return { error: "prospectId er påkrevd" };
      return agentFetch(`/prospects/${prospectId}?organizationId=${orgId()}`);
    }

    case "kundeoversikt_list_prospects": {
      const status = typeof args.status === "string" ? `&status=${args.status}` : "";
      const limit = typeof args.limit === "number" ? args.limit : 20;
      return agentFetch(`/prospects?organizationId=${orgId()}&limit=${limit}${status}`);
    }

    default:
      return { error: `Ukjent Kundeoversikt-verktøy: ${toolName}` };
  }
}

export function isKundeoversiktTool(name: string): boolean {
  return name.startsWith("kundeoversikt_");
}
