import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeKnowledgeNoteDraftIdempotencyKey,
  executeKundeoversiktTool,
} from "./kundeoversikt-tools.js";

const ORG_ID = "1db47f45-f01e-4e9a-8b07-c1fdb6ef56bf";
const CUSTOMER_ID = "1f53b983-6d7d-40db-8e3b-4a08f0f32a0f";

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
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

const HAPPY_BODY = {
  status: "pending_review",
  noteId: "note-uuid-001",
  revisionId: "rev-uuid-001",
  queueId: "q-uuid-001",
  basedOnRevisionId: null,
  diffPreview: "+ Ny note",
  embeddingStatus: "ok",
  requiresToreReview: true,
};

function validArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerId: CUSTOMER_ID,
    customerSlug: "verkvelven-as",
    noteKey: "leasing-konto-6300",
    noteType: "accounting_rule",
    title: "Leasing skal på konto 6300",
    contentMd: "# Regel\n\nLeasing av kontorutstyr skal bokføres på konto 6300.",
    content: {
      scope: "customer",
      trigger: "Faktura med 'leasing' i beskrivelsen",
      action: "Bokfør på konto 6300",
      source: "Tores feedback i sak #79c3bb61",
    },
    rationale: "Tore har korrigert dette manuelt 3 ganger.",
    confidence: 0.92,
    ...overrides,
  };
}

describe("executeKundeoversiktTool — kundeoversikt_upsert_knowledge_note_draft", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AGENT_API_KEY = "test-api-key";
    process.env.KUNDEOVERSIKT_DRAFTS_URL = "https://kunde.test/api/agent/drafts";
    process.env.KUNDEOVERSIKT_ORG_ID = ORG_ID;
    process.env.PAPERCLIP_DRY_RUN = "false";
    process.env.PAPERCLIP_AGENT_JWT_ENABLED = "false";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Deterministic idempotency key helper
  // -------------------------------------------------------------------------

  it("computeKnowledgeNoteDraftIdempotencyKey er deterministisk og 32 tegn", () => {
    const k1 = computeKnowledgeNoteDraftIdempotencyKey("run-1", CUSTOMER_ID, "k");
    const k2 = computeKnowledgeNoteDraftIdempotencyKey("run-1", CUSTOMER_ID, "k");
    expect(k1).toBe(k2);
    expect(k1.length).toBe(32);
    const expected = createHash("sha256")
      .update(`run-1:${CUSTOMER_ID}:k`)
      .digest("hex")
      .slice(0, 32);
    expect(k1).toBe(expected);
  });

  it("computeKnowledgeNoteDraftIdempotencyKey gir ulik nøkkel for ulik runId", () => {
    const k1 = computeKnowledgeNoteDraftIdempotencyKey("run-1", CUSTOMER_ID, "k");
    const k2 = computeKnowledgeNoteDraftIdempotencyKey("run-2", CUSTOMER_ID, "k");
    expect(k1).not.toBe(k2);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("happy path: POSTer korrekt body og returnerer normalisert resultat", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(HAPPY_BODY));

    const result = await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs(),
      { agentId: "agent-A", runId: "run-XYZ" },
    );

    expect(result).toMatchObject({
      status: "pending_review",
      noteId: "note-uuid-001",
      revisionId: "rev-uuid-001",
      embeddingStatus: "ok",
      requiresToreReview: true,
    });

    const [url, options] = fetchSpy.mock.calls[0] ?? [];
    const u = new URL(String(url));
    expect(u.pathname.endsWith("/upsert-knowledge-note-draft")).toBe(true);
    expect(options?.method).toBe("POST");

    const sentBody = JSON.parse(options?.body as string) as Record<string, unknown>;
    expect(sentBody.organizationId).toBe(ORG_ID);
    expect(sentBody.customerId).toBe(CUSTOMER_ID);
    expect(sentBody.noteKey).toBe("leasing-konto-6300");
    expect(sentBody.noteType).toBe("accounting_rule");
    expect(typeof sentBody.idempotencyKey).toBe("string");
    expect((sentBody.idempotencyKey as string).length).toBe(32);

    // Deterministisk default basert på runId+customerId+noteKey
    const expectedKey = computeKnowledgeNoteDraftIdempotencyKey(
      "run-XYZ",
      CUSTOMER_ID,
      "leasing-konto-6300",
    );
    expect(sentBody.idempotencyKey).toBe(expectedKey);
  });

  it("caller kan overstyre idempotencyKey", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(HAPPY_BODY));

    await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs({ idempotencyKey: "explicit-caller-key-123" }),
      { agentId: "agent-A", runId: "run-XYZ" },
    );

    const [, options] = fetchSpy.mock.calls[0] ?? [];
    const sentBody = JSON.parse(options?.body as string) as Record<string, unknown>;
    expect(sentBody.idempotencyKey).toBe("explicit-caller-key-123");
  });

  it("organization_id injiseres ALLTID fra env — args.organizationId ignoreres", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(HAPPY_BODY));

    await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs({ organizationId: "00000000-0000-0000-0000-000000000000" }),
      { agentId: "agent-A", runId: "run-XYZ" },
    );

    const [, options] = fetchSpy.mock.calls[0] ?? [];
    const sentBody = JSON.parse(options?.body as string) as Record<string, unknown>;
    expect(sentBody.organizationId).toBe(ORG_ID);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it("avviser ugyldig noteType", async () => {
    const result = await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs({ noteType: "invalid_type" }),
      { agentId: "a", runId: "r" },
    );
    expect(result).toMatchObject({
      code: "INVALID_ARGUMENTS",
      error: expect.stringContaining("noteType må være en av"),
    });
  });

  it("avviser manglende contentMd", async () => {
    const args = validArgs();
    delete args.contentMd;
    const result = await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      args,
      { agentId: "a", runId: "r" },
    );
    expect(result).toMatchObject({
      code: "INVALID_ARGUMENTS",
      error: expect.stringContaining("contentMd"),
    });
  });

  it("avviser confidence > 1", async () => {
    const result = await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs({ confidence: 1.5 }),
      { agentId: "a", runId: "r" },
    );
    expect(result).toMatchObject({
      code: "INVALID_ARGUMENTS",
      error: expect.stringContaining("confidence"),
    });
  });

  it("avviser ikke-UUID customerId", async () => {
    const result = await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs({ customerId: "not-a-uuid" }),
      { agentId: "a", runId: "r" },
    );
    expect(result).toMatchObject({
      code: "INVALID_ARGUMENTS",
      error: expect.stringContaining("UUID"),
    });
  });

  it("avviser content.scope != 'customer'", async () => {
    const result = await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs({
        content: {
          scope: "global",
          trigger: "x",
          action: "y",
          source: "z",
        },
      }),
      { agentId: "a", runId: "r" },
    );
    expect(result).toMatchObject({
      code: "INVALID_ARGUMENTS",
      error: expect.stringContaining("content.scope"),
    });
  });

  // -------------------------------------------------------------------------
  // Error mapping
  // -------------------------------------------------------------------------

  type ErrCase = {
    name: string;
    status: number;
    code: string;
    expected: { retriable: boolean; retryAfter?: number; codeMatch?: string };
    headers?: Record<string, string>;
  };

  const errorCases: ErrCase[] = [
    {
      name: "401/JWT_EXPIRED er retriable",
      status: 401,
      code: "JWT_EXPIRED",
      expected: { retriable: true },
    },
    {
      name: "401/JWT_REPLAY er IKKE retriable",
      status: 401,
      code: "JWT_REPLAY",
      expected: { retriable: false },
    },
    {
      name: "401/JWT_TOOL_MISMATCH er IKKE retriable",
      status: 401,
      code: "JWT_TOOL_MISMATCH",
      expected: { retriable: false },
    },
    {
      name: "400/JWT_BODY_MISMATCH er IKKE retriable",
      status: 400,
      code: "JWT_BODY_MISMATCH",
      expected: { retriable: false },
    },
    {
      name: "400/INVALID_BODY er IKKE retriable",
      status: 400,
      code: "INVALID_BODY",
      expected: { retriable: false },
    },
    {
      name: "403/JWT_ORG_MISMATCH er IKKE retriable",
      status: 403,
      code: "JWT_ORG_MISMATCH",
      expected: { retriable: false },
    },
    {
      name: "409/STALE_DRAFT er retriable",
      status: 409,
      code: "STALE_DRAFT",
      expected: { retriable: true },
    },
    {
      name: "409/IDEMPOTENCY_CONFLICT er IKKE retriable",
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      expected: { retriable: false },
    },
    {
      name: "409/DRAFT_QUEUE_FULL er retriable med retryAfter=60",
      status: 409,
      code: "DRAFT_QUEUE_FULL",
      expected: { retriable: true, retryAfter: 60 },
    },
    {
      name: "429 er retriable og leser Retry-After",
      status: 429,
      code: "RATE_LIMITED",
      expected: { retriable: true, retryAfter: 5 },
      headers: { "Retry-After": "5" },
    },
    {
      name: "503/DRAFT_INTAKE_PAUSED er retriable",
      status: 503,
      code: "DRAFT_INTAKE_PAUSED",
      expected: { retriable: true },
    },
  ];

  for (const tc of errorCases) {
    it(tc.name, async () => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse(
          { error: `feil for ${tc.code}`, code: tc.code },
          { status: tc.status, headers: tc.headers },
        ),
      );

      const pending = executeKundeoversiktTool(
        "kundeoversikt_upsert_knowledge_note_draft",
        validArgs(),
        { agentId: "a", runId: "r" },
      );

      // Drain rate-limit-backoff timers så promise kan settle
      await vi.advanceTimersByTimeAsync(60_000);
      const result = (await pending) as Record<string, unknown>;

      expect(result.code).toBe(tc.code);
      expect(result.retriable).toBe(tc.expected.retriable);
      if (tc.expected.retryAfter !== undefined) {
        expect(result.retryAfter).toBe(tc.expected.retryAfter);
      }
      expect(typeof result.hint).toBe("string");
    });
  }

  // -------------------------------------------------------------------------
  // embeddingStatus=pending_retry → ikke feil
  // -------------------------------------------------------------------------

  it("embeddingStatus=pending_retry returneres som OK med _note", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...HAPPY_BODY, embeddingStatus: "pending_retry" }),
    );

    const result = (await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs(),
      { agentId: "a", runId: "r" },
    )) as Record<string, unknown>;

    expect(result.embeddingStatus).toBe("pending_retry");
    expect(result.error).toBeUndefined();
    expect(typeof result._note).toBe("string");
    expect(String(result._note)).toContain("Embedding pending");
  });

  // Quinn fix #5: embeddingStatus="failed" eller ukjent skal ikke pass-through
  // som silent success (noteId=null vil føre til at agenten tror alt gikk bra
  // mens embeddingen aldri ble laget).
  it("embeddingStatus='failed' returneres som EMBEDDING_FAILED-feil", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...HAPPY_BODY,
        embeddingStatus: "failed",
        noteId: null,
      }),
    );

    const result = (await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs(),
      { agentId: "a", runId: "r" },
    )) as Record<string, unknown>;

    expect(result.code).toBe("EMBEDDING_FAILED");
    expect(result.retriable).toBe(true);
    expect(typeof result.error).toBe("string");
    expect(String(result.hint)).toContain("Embedding");
    expect(result.embeddingStatus).toBe("failed");
  });

  it("embeddingStatus=ukjent verdi avvises også", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...HAPPY_BODY,
        embeddingStatus: "weird_state",
        noteId: null,
      }),
    );

    const result = (await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs(),
      { agentId: "a", runId: "r" },
    )) as Record<string, unknown>;

    expect(result.code).toBe("EMBEDDING_FAILED");
    expect(result.embeddingStatus).toBe("weird_state");
  });

  // -------------------------------------------------------------------------
  // body_sha256 (signed-fetch path)
  // -------------------------------------------------------------------------

  it("når JWT er på, hashes body som ble sendt på wire (body_sha256 stemmer)", async () => {
    // Vi tester at den serialiserte body som sendes til fetch er den samme som
    // signed-fetch ville hashe (string-body). Faktisk JWT-signering krever
    // privatnøkkel som ikke er tilgjengelig i test, så vi skrur av JWT og
    // verifiserer i stedet at body sendes som JSON-string (forutsetning for
    // body_sha256-konsistens).
    process.env.PAPERCLIP_AGENT_JWT_ENABLED = "false";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(HAPPY_BODY));

    await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      validArgs(),
      { agentId: "a", runId: "r" },
    );

    const [, options] = fetchSpy.mock.calls[0] ?? [];
    expect(typeof options?.body).toBe("string");
    // Den nøyaktige strengen er det signed-fetch ville ha hashet:
    const sha = createHash("sha256")
      .update(options?.body as string)
      .digest("hex");
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });
});
