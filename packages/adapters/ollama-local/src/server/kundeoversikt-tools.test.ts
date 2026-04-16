import { readFile } from "node:fs/promises";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { pruneExpiredKeys } from "./idempotency.js";
import { executeKundeoversiktTool } from "./kundeoversikt-tools.js";

type Fixtures = Record<string, unknown>;

let fixtures: Fixtures;

function jsonResponse(
  body: unknown,
  init?: {
    status?: number;
    headers?: Record<string, string>;
  },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "X-Kundeoversikt-Contract-Version": "1",
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": "10",
      "X-RateLimit-Reset": "1893456000",
      ...(init?.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  const raw = await readFile(
    new URL("./__fixtures__/kundeoversikt-bookkeeping.json", import.meta.url),
    "utf8",
  );
  fixtures = JSON.parse(raw) as Fixtures;
});

describe("executeKundeoversiktTool bookkeeping tools", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AGENT_API_KEY = "test-api-key";
    process.env.KUNDEOVERSIKT_DRAFTS_URL = "https://kunde.test/api/agent/drafts";
    process.env.PAPERCLIP_DRY_RUN = "false";
    pruneExpiredKeys(Number.MAX_SAFE_INTEGER);
  });

  afterEach(() => {
    pruneExpiredKeys(Number.MAX_SAFE_INTEGER);
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("henter pending revisions og filtrerer ut needs_human_escalation", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(fixtures.listPendingRevisions_happy),
      );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await executeKundeoversiktTool(
      "kundeoversikt_list_pending_revisions",
      {
        organizationId: "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be",
        companySlug: "verkvelven-as",
        limit: 5,
      },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect((result as Array<{ status: string }>)[0]?.status).toBe("needs_revision");

    const [url, options] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/agent/bookkeeping/queue?");
    const parsedUrl = new URL(String(url));
    expect(parsedUrl.searchParams.get("status")).toBe("needs_revision");
    expect(parsedUrl.searchParams.get("organization_id")).toBe("3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be");
    expect(parsedUrl.searchParams.get("company_slug")).toBe("verkvelven-as");

    const headers = new Headers((options?.headers ?? {}) as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer test-api-key");
    expect(headers.get("X-Paperclip-Contract-Version")).toBe("1");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("needs_human_escalation"),
    );
  });

  it("henter feedback-eksempler på happy path uten expandToOrg", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(fixtures.getBookkeepingFeedback_happy),
      );

    const result = await executeKundeoversiktTool(
      "kundeoversikt_get_bookkeeping_feedback",
      {
        customerId: "1f53b983-6d7d-40db-8e3b-4a08f0f32a0f",
        organizationId: "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be",
        limit: 5,
      },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);

    const [url] = fetchSpy.mock.calls[0] ?? [];
    const parsedUrl = new URL(String(url));
    expect(parsedUrl.pathname).toBe("/api/agent/bookkeeping/feedback-examples");
    expect(parsedUrl.searchParams.get("customerId")).toBe("1f53b983-6d7d-40db-8e3b-4a08f0f32a0f");
    expect(parsedUrl.searchParams.get("organization_id")).toBe("3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be");
    expect(parsedUrl.searchParams.get("expandToOrg")).toBeNull();
  });

  it("returnerer tom liste når learning loop er deaktivert", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(fixtures.getBookkeepingFeedback_disabled, {
        status: 409,
        headers: {
          "X-Kundeoversikt-Learning-Enabled": "false",
        },
      }),
    );

    const result = await executeKundeoversiktTool(
      "kundeoversikt_get_bookkeeping_feedback",
      {
        customerId: "1f53b983-6d7d-40db-8e3b-4a08f0f32a0f",
        organizationId: "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be",
      },
    );

    expect(result).toEqual([]);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("learning_disabled_skipped"),
    );
  });

  it("gjør backoff ved 429 før strukturert feil returneres", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        { error: "For mange forespørsler", code: "RATE_LIMITED" },
        {
          status: 429,
          headers: {
            "Retry-After": "1",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": "1893456001",
          },
        },
      ),
    );

    const pending = executeKundeoversiktTool(
      "kundeoversikt_list_pending_revisions",
      {
        organizationId: "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be",
        companySlug: "verkvelven-as",
      },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result).toEqual({
      error: "For mange forespørsler",
      code: "RATE_LIMITED",
    });
  });

  it("sender samme Idempotency-Key ved retry av identisk payload", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(fixtures.submitRevision_happy),
      );

    const args = {
      queueId: "79c3bb61-58df-4f4f-a978-1b31c9f02a66",
      organizationId: "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be",
      companySlug: "verkvelven-as",
      fikenPayload: {
        date: "2026-04-14",
        kind: "cash_purchase",
        lines: [
          {
            accountCode: "6300",
            amount: 29900,
            vatType: "HIGH",
            description: "Månedsfaktura leasing",
          },
        ],
      },
      aiReasoning: "Brukte menneskelig note og tidligere læringseksempler.",
      aiConfidence: 0.93,
    };

    await executeKundeoversiktTool("kundeoversikt_submit_bookkeeping_revision", args);
    const result = await executeKundeoversiktTool("kundeoversikt_submit_bookkeeping_revision", args);

    expect((result as { status?: string }).status).toBe("pending");

    const firstHeaders = new Headers((fetchSpy.mock.calls[0]?.[1]?.headers ?? {}) as HeadersInit);
    const secondHeaders = new Headers((fetchSpy.mock.calls[1]?.[1]?.headers ?? {}) as HeadersInit);

    const firstKey = firstHeaders.get("Idempotency-Key");
    const secondKey = secondHeaders.get("Idempotency-Key");

    expect(firstKey).toBeTruthy();
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("returnerer oppdatert sak på vellykket revision-submit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(fixtures.submitRevision_happy),
    );

    const result = await executeKundeoversiktTool(
      "kundeoversikt_submit_bookkeeping_revision",
      {
        queueId: "79c3bb61-58df-4f4f-a978-1b31c9f02a66",
        organizationId: "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be",
        companySlug: "verkvelven-as",
        fikenPayload: {
          date: "2026-04-14",
          kind: "cash_purchase",
          lines: [
            {
              accountCode: "6300",
              amount: 29900,
              vatType: "HIGH",
              description: "Månedsfaktura leasing",
            },
          ],
        },
        aiReasoning: "Brukte menneskelig note og tidligere læringseksempler.",
        aiConfidence: 0.93,
      },
    );

    expect(result).toMatchObject({
      id: "79c3bb61-58df-4f4f-a978-1b31c9f02a66",
      status: "pending",
      idempotent_replay: false,
    });
  });

  it("mapper compliance-blokkering og revisjonsgrense til strukturerte feil", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(fixtures.submitRevision_complianceBlocked, {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(fixtures.submitRevision_escalated, {
          status: 422,
        }),
      );

    const baseArgs = {
      queueId: "79c3bb61-58df-4f4f-a978-1b31c9f02a66",
      organizationId: "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be",
      companySlug: "verkvelven-as",
      fikenPayload: { date: "2026-04-14" },
      aiReasoning: "Ny vurdering.",
      aiConfidence: 0.7,
    };

    const complianceResult = await executeKundeoversiktTool(
      "kundeoversikt_submit_bookkeeping_revision",
      baseArgs,
    );
    const escalatedResult = await executeKundeoversiktTool(
      "kundeoversikt_submit_bookkeeping_revision",
      {
        ...baseArgs,
        queueId: "9ac8d808-1a0f-4c19-a375-d0fc7d87a228",
      },
    );

    expect(complianceResult).toEqual({
      error: "Saken kan ikke revideres mens en compliance-sak er åpen for samme bilag",
      code: "COMPLIANCE_CASE_OPEN",
      retry_after: "Etter at compliance-saken er lukket.",
    });
    expect(escalatedResult).toEqual({
      error: "revision_count >= 3. Ny AI-revisjon er ikke tillatt",
      code: "REVISION_LIMIT_REACHED",
    });
  });

  it("returnerer tydelige feil ved manglende felter", async () => {
    const pendingResult = await executeKundeoversiktTool(
      "kundeoversikt_list_pending_revisions",
      {
        companySlug: "verkvelven-as",
      },
    );
    const feedbackResult = await executeKundeoversiktTool(
      "kundeoversikt_get_bookkeeping_feedback",
      {
        organizationId: "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be",
      },
    );
    const submitResult = await executeKundeoversiktTool(
      "kundeoversikt_submit_bookkeeping_revision",
      {
        queueId: "79c3bb61-58df-4f4f-a978-1b31c9f02a66",
        organizationId: "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be",
        companySlug: "verkvelven-as",
      },
    );

    expect(pendingResult).toEqual({
      error: "organizationId er påkrevd.",
      code: "INVALID_ARGUMENTS",
    });
    expect(feedbackResult).toEqual({
      error: "customerId er påkrevd.",
      code: "INVALID_ARGUMENTS",
    });
    expect(submitResult).toEqual({
      error: "fikenPayload må være et objekt.",
      code: "INVALID_ARGUMENTS",
    });
  });
});
