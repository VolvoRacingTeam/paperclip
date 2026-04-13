/**
 * Built-in Fiken tools for the ollama_local adapter.
 *
 * Tools for reading/writing to Fiken accounting API.
 * Uses Fiken personal API tokens stored in env or via
 * Kundeoversikt credentials endpoint.
 *
 * Environment variables:
 *   FIKEN_API_TOKEN â€” Default Fiken bearer token (for Verkvelven's own companies)
 *   AGENT_API_KEY   â€” For fetching per-company tokens from Kundeoversikt
 */

import type { ToolDefinition } from "./schema.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FIKEN_BASE = "https://api.fiken.no/api/v2";

function defaultFikenToken(): string {
  // Use first available token from env
  const token = process.env.FIKEN_API_TOKEN;
  if (!token) throw new Error("Missing env: FIKEN_API_TOKEN or FIKEN_API_KEY_1");
  return token;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function fikenFetch(
  path: string,
  token?: string,
  options?: RequestInit,
): Promise<unknown> {
  const url = `${FIKEN_BASE}${path}`;
  const bearer = token ?? defaultFikenToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...(options?.headers as Record<string, string> ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `Fiken API ${res.status}: ${text.slice(0, 300)}` };
    }
    return res.json();
  } catch (err) {
    return { error: `Fiken fetch failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all pages from a paginated Fiken endpoint.
 * Fiken returns arrays directly (not wrapped in an object with pagination info).
 * We fetch pages of 100 until we get less than pageSize results.
 */
async function fikenFetchAll(
  basePath: string,
  token?: string,
  maxPages = 10,
): Promise<unknown[]> {
  const allResults: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    const result = await fikenFetch(
      `${basePath}${sep}page=${page}&pageSize=100`,
      token,
    );
    if (!Array.isArray(result)) {
      if (page === 0) return [result]; // error on first page
      break; // error on subsequent page, return what we have
    }
    allResults.push(...result);
    if (result.length < 100) break; // last page
  }
  return allResults;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const FIKEN_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === 1. List companies ===
  {
    name: "fiken_list_companies",
    description:
      "List alle selskaper i Fiken som du har tilgang til. " +
      "Returnerer navn, slug, orgnummer, MVA-type for hvert selskap.",
    parametersSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },

  // === 2. Get inbox (bilag) ===
  {
    name: "fiken_get_inbox",
    description:
      "Hent innboks-bilag for et selskap i Fiken. " +
      "Returnerer bilag med beskrivelse, belÃ¸p, dato, leverandÃ¸r. " +
      "Sett unusedOnly=true for Ã¥ kun se bilag som ikke er bokfÃ¸rt ennÃ¥.",
    parametersSchema: {
      type: "object",
      properties: {
        companySlug: { type: "string", description: "Selskapets slug i Fiken." },
        unusedOnly: { type: "boolean", description: "Kun ubrukte bilag (standard: true)." },
      },
      required: ["companySlug"],
      additionalProperties: false,
    },
  },

  // === 3. Get accounts (kontoplan) ===
  {
    name: "fiken_get_accounts",
    description:
      "Hent kontoplan for et selskap. Returnerer kontonummer, navn og type. " +
      "Bruk for Ã¥ finne riktig konto ved bokfÃ¸ring.",
    parametersSchema: {
      type: "object",
      properties: {
        companySlug: { type: "string", description: "Selskapets slug." },
        fromAccount: { type: "integer", description: "Filtrer fra kontonummer (f.eks. 6000 for driftskostnader)." },
        toAccount: { type: "integer", description: "Filtrer til kontonummer (f.eks. 7999)." },
      },
      required: ["companySlug"],
      additionalProperties: false,
    },
  },

  // === 4. Get bank transactions (journal entries) ===
  {
    name: "fiken_get_journal_entries",
    description:
      "Hent journalposter (inkludert banktransaksjoner) for et selskap. " +
      "Filtrer pÃ¥ dato. Bruk for Ã¥ finne uavstemte bankposter.",
    parametersSchema: {
      type: "object",
      properties: {
        companySlug: { type: "string", description: "Selskapets slug." },
        fromDate: { type: "string", description: "Fra dato (YYYY-MM-DD)." },
        toDate: { type: "string", description: "Til dato (YYYY-MM-DD)." },
        page: { type: "integer", description: "Sidenummer (standard 0)." },
      },
      required: ["companySlug"],
      additionalProperties: false,
    },
  },

  // === 5. Get contacts (leverandÃ¸rer/kunder) ===
  {
    name: "fiken_get_contacts",
    description:
      "Hent kontakter (leverandÃ¸rer og kunder) for et selskap i Fiken. " +
      "Bruk for Ã¥ finne leverandÃ¸r-ID ved bokfÃ¸ring.",
    parametersSchema: {
      type: "object",
      properties: {
        companySlug: { type: "string", description: "Selskapets slug." },
        supplierOnly: { type: "boolean", description: "Kun leverandÃ¸rer (standard: false)." },
      },
      required: ["companySlug"],
      additionalProperties: false,
    },
  },

  // === 6. Get bank accounts ===
  {
    name: "fiken_get_bank_accounts",
    description:
      "Hent bankkontoer for et selskap. Returnerer kontonavn, type og saldo.",
    parametersSchema: {
      type: "object",
      properties: {
        companySlug: { type: "string", description: "Selskapets slug." },
      },
      required: ["companySlug"],
      additionalProperties: false,
    },
  },

  // === 7. Submit bookkeeping proposal ===
  {
    name: "fiken_submit_bookkeeping",
    description:
      "Send et bokfÃ¸ringsforslag til Tores godkjenningskÃ¸ i Kundeoversikt. " +
      "Tore godkjenner eller avviser. Godkjente poster bokfÃ¸res automatisk i Fiken. " +
      "ALDRI bokfÃ¸r direkte â€” alt MÃ… gÃ¥ gjennom godkjenningskÃ¸en.",
    parametersSchema: {
      type: "object",
      properties: {
        companySlug: { type: "string", description: "Selskapets slug." },
        customerId: { type: "string", description: "Kunde-UUID i Kundeoversikt (valgfri)." },
        bookingType: { type: "string", enum: ["purchase", "journal_entry"], description: "Type bokfÃ¸ring." },
        date: { type: "string", description: "BokfÃ¸ringsdato (YYYY-MM-DD)." },
        accountCode: { type: "string", description: "Kontokode (f.eks. '6340')." },
        amount: { type: "number", description: "BelÃ¸p i NOK (positiv)." },
        vatType: { type: "string", enum: ["HIGH", "MEDIUM", "LOW", "NONE", "EXEMPT"], description: "MVA-type." },
        description: { type: "string", description: "Beskrivelse av bilaget." },
        inboxDocumentId: { type: "integer", description: "Fiken innboks-bilag-ID (hvis matcher)." },
        transactionDesc: { type: "string", description: "Banktransaksjon-beskrivelse (hvis matcher)." },
        aiReasoning: { type: "string", description: "Begrunnelse for kontovalg og matching." },
        aiConfidence: { type: "number", description: "Konfidens 0.0-1.0.", minimum: 0, maximum: 1 },
      },
      required: ["companySlug", "bookingType", "date", "accountCode", "amount", "vatType", "description", "aiReasoning", "aiConfidence"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export async function executeFikenTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "fiken_list_companies": {
      const companies = await fikenFetchAll("/companies") as Array<Record<string, unknown>>;
      if (!Array.isArray(companies)) return companies; // error object
      return companies.map((c) => ({
        name: c.name,
        slug: c.slug,
        orgNumber: c.organizationNumber,
        vatType: c.vatType,
        hasApiAccess: c.hasApiAccess,
      }));
    }

    case "fiken_get_inbox": {
      const slug = args.companySlug as string;
      if (!slug) return { error: "companySlug er pÃ¥krevd" };
      const unusedOnly = args.unusedOnly !== false; // default true

      // Fetch all inbox documents
      const docs = await fikenFetchAll(`/companies/${slug}/inbox?sortBy=createdDate&descending=true`) as Array<Record<string, unknown>>;
      if (!Array.isArray(docs)) return docs;

      let filtered = docs;
      if (unusedOnly) {
        // Cross-reference: fetch all purchases to find which inbox docs are used.
        // Extract file UUIDs from purchase attachments and inbox documentUrls.
        const purchases = await fikenFetchAll(`/companies/${slug}/purchases?sortBy=date&descending=true`) as Array<Record<string, unknown>>;
        const usedFileUuids = new Set<string>();
        if (Array.isArray(purchases)) {
          for (const purchase of purchases) {
            const atts = purchase.purchaseAttachments as Array<Record<string, unknown>> | undefined;
            if (atts) {
              for (const att of atts) {
                const url = att.downloadUrl as string;
                if (url) {
                  // Extract UUID from URL: .../files/{uuid}/filename
                  const match = url.match(/\/files\/([0-9a-f-]{36})\//) ;
                  if (match) usedFileUuids.add(match[1]);
                }
              }
            }
          }
        }

        filtered = docs.filter((d) => {
          const docUrl = d.documentUrl as string;
          if (!docUrl) return true; // no URL = assume unused
          const match = docUrl.match(/\/files\/([0-9a-f-]{36})\//) ;
          if (!match) return true;
          return !usedFileUuids.has(match[1]);
        });
      }

      return {
        total: docs.length,
        unused: filtered.length,
        documents: filtered.slice(0, 30).map((d) => ({
          documentId: d.documentId,
          name: d.name,
          description: d.description,
          filename: d.filename,
          createdDate: d.createdAt ?? d.createdDate,
        })),
      };
    }

    case "fiken_get_accounts": {
      const slug = args.companySlug as string;
      if (!slug) return { error: "companySlug er pÃ¥krevd" };
      const from = typeof args.fromAccount === "number" ? args.fromAccount : undefined;
      const to = typeof args.toAccount === "number" ? args.toAccount : undefined;
      let path = `/companies/${slug}/accounts?pageSize=200`;
      if (from) path += `&fromAccount=${from}`;
      if (to) path += `&toAccount=${to}`;
      const accounts = await fikenFetchAll(path) as Array<Record<string, unknown>>;
      if (!Array.isArray(accounts)) return accounts;
      return {
        count: accounts.length,
        accounts: accounts.slice(0, 50).map((a) => ({
          code: a.code,
          name: a.name,
        })),
        hint: accounts.length > 50 ? "Bruk fromAccount/toAccount for ï¿½ï¿½ filtrere (f.eks. 6000-7999 for driftskostnader)" : undefined,
      };
    }

    case "fiken_get_journal_entries": {
      const slug = args.companySlug as string;
      if (!slug) return { error: "companySlug er pÃ¥krevd" };
      const from = (args.fromDate as string) ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const to = (args.toDate as string) ?? new Date().toISOString().slice(0, 10);
      const page = typeof args.page === "number" ? args.page : 0;
      const entries = await fikenFetch(
        `/companies/${slug}/journalEntries?date_ge=${from}&date_le=${to}&page=${page}&pageSize=50`,
      ) as Array<Record<string, unknown>>;
      if (!Array.isArray(entries)) return entries;
      return {
        count: entries.length,
        entries: entries.slice(0, 30).map((e) => ({
          journalEntryId: e.journalEntryId,
          date: e.date,
          description: e.description,
          lines: e.lines,
        })),
      };
    }

    case "fiken_get_contacts": {
      const slug = args.companySlug as string;
      if (!slug) return { error: "companySlug er pÃ¥krevd" };
      const contacts = await fikenFetchAll(`/companies/${slug}/contacts`) as Array<Record<string, unknown>>;
      if (!Array.isArray(contacts)) return contacts;
      let filtered = contacts;
      if (args.supplierOnly) {
        filtered = contacts.filter((c) => c.supplier === true);
      }
      return filtered.slice(0, 50).map((c) => ({
        contactId: c.contactId,
        name: c.name,
        email: c.email,
        organizationNumber: c.organizationNumber,
        supplier: c.supplier,
        customer: c.customer,
      }));
    }

    case "fiken_get_bank_accounts": {
      const slug = args.companySlug as string;
      if (!slug) return { error: "companySlug er pÃ¥krevd" };
      const accounts = await fikenFetchAll(`/companies/${slug}/bankAccounts`) as Array<Record<string, unknown>>;
      if (!Array.isArray(accounts)) return accounts;
      return accounts.map((a) => ({
        bankAccountId: a.bankAccountId,
        name: a.name,
        accountCode: a.accountCode,
        bankAccountNumber: a.bankAccountNumber,
        type: a.type,
      }));
    }

    case "fiken_submit_bookkeeping": {

      // Accept documentId as alias for inboxDocumentId (Gemma 4 guesses wrong name)
      if (args.inboxDocumentId === undefined && args.documentId !== undefined) {
        args = { ...args, inboxDocumentId: args.documentId };
      }

      // Validate required fields — return helpful error so agent retries with correct data
      const _missing: string[] = [];
      if (typeof args.amount !== 'number') _missing.push('amount (beloep i NOK, f.eks. 299.00)');
      if (!args.date) _missing.push('date (bokforingsdato YYYY-MM-DD)');
      if (!args.vatType) _missing.push('vatType (NONE/HIGH/MEDIUM/LOW/EXEMPT)');
      if (!args.description) _missing.push('description (bilagets filnavn/navn)');
      if (_missing.length > 0) {
        return { error: 'fiken_submit_bookkeeping mangler obligatoriske felter: ' + _missing.join(', ') + '. Send alle felter pa nytt.' };
      }
      // Route to Kundeoversikt bookkeeping queue â€” NOT directly to Fiken
      const baseUrl = (process.env.KUNDEOVERSIKT_DRAFTS_URL ?? "https://www.kundeoversikt.no/api/agent/drafts").replace(/\/drafts$/, "");
      const apiKey = process.env.AGENT_API_KEY;
      const orgId = process.env.KUNDEOVERSIKT_ORG_ID;
      if (!apiKey || !orgId) return { error: "Missing AGENT_API_KEY or KUNDEOVERSIKT_ORG_ID" };

      const body = {
        organizationId: orgId,
        companySlug: args.companySlug,
        customerId: args.customerId ?? undefined,
        bookingType: args.bookingType ?? "purchase",
        fikenPayload: {
          date: args.date,
          kind: "cash_purchase",
          lines: [{
            accountCode: args.accountCode,
            amount: Math.round((args.amount as number) * 100), // NOK â†’ Ã¸re
            vatType: args.vatType,
            description: args.description,
          }],
          inboxDocumentId: args.inboxDocumentId ?? null,
        },
        inboxDocumentId: args.inboxDocumentId ?? null,
        transactionDesc: args.transactionDesc ?? "",
        suggestedAccount: args.accountCode as string,
        amountNok: typeof args.amount === 'number' ? args.amount : 0,
        aiConfidence: typeof args.aiConfidence === "number" ? args.aiConfidence : 0.5,
        aiReasoning: (args.aiReasoning as string) ?? "",
        actorName: "paperclip-regnskapsforer",
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(`${baseUrl}/bookkeeping/queue`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        const result = await res.json() as Record<string, unknown>;
        if (!res.ok) return { error: `HTTP ${res.status}: ${JSON.stringify(result)}` };
        return result;
      } catch (err) {
        return { error: `Submit failed: ${(err as Error).message}` };
      } finally {
        clearTimeout(timer);
      }
    }

    default:
      return { error: `Ukjent Fiken-verktÃ¸y: ${toolName}` };
  }
}

export function isFikenTool(name: string): boolean {
  return name.startsWith("fiken_");
}
