/**
 * agentFetch() rate-limit retrofit (SON-97).
 *
 * Verifies the 5 spec scenarios:
 *   1. 429 + Retry-After=2 → ÉN retry, 200 → success
 *   2. 429 + Retry-After=999 → ingen retry, RATE_LIMITED umiddelbart
 *   3. 200 + X-RateLimit-Remaining=0 → cache oppdateres
 *   4. Cache viser remaining=0 → kortslutter pre-call (ingen fetch)
 *   5. 429 + 429 (retry feiler også) → RATE_LIMITED med attempts=2
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __peekRateLimitCacheForTest,
  __resetRateLimitCacheForTest,
  executeKundeoversiktTool,
} from "./kundeoversikt-tools.js";

const ORG_ID = "3f7f2f5c-83cf-4f2b-9a4f-7fbc2e7c91be";
const CUSTOMER_ID = "11111111-2222-3333-4444-555555555555";

function rlResponse(
  body: unknown,
  init: {
    status?: number;
    remaining?: number;
    resetEpoch?: number;
    retryAfter?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-RateLimit-Limit": "60",
    "X-RateLimit-Remaining": String(init.remaining ?? 10),
    "X-RateLimit-Reset": String(init.resetEpoch ?? 1893456000),
    ...(init.extraHeaders ?? {}),
  };
  if (init.retryAfter !== undefined) {
    headers["Retry-After"] = init.retryAfter;
  }
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

describe("agentFetch rate-limit retrofit", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AGENT_API_KEY = "test-api-key";
    process.env.KUNDEOVERSIKT_DRAFTS_URL =
      "https://kunde.test/api/agent/drafts";
    process.env.KUNDEOVERSIKT_ORG_ID = ORG_ID;
    process.env.PAPERCLIP_DRY_RUN = "false";
    process.env.PAPERCLIP_AGENT_JWT_ENABLED = "false";
    __resetRateLimitCacheForTest();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    __resetRateLimitCacheForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retrier én gang ved 429 + Retry-After=2 og returnerer success body", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        rlResponse(
          { error: "rate limited" },
          { status: 429, retryAfter: "2", remaining: 0 },
        ),
      )
      .mockResolvedValueOnce(
        rlResponse({ name: "Verkvelven AS" }, { remaining: 9 }),
      );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
    );
    // Drive the 2s vent() backoff.
    await vi.advanceTimersByTimeAsync(2_500);

    const result = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ name: "Verkvelven AS" });
  });

  it("returnerer RATE_LIMITED uten retry når Retry-After > 60 s", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      rlResponse(
        { error: "rate limited" },
        { status: 429, retryAfter: "999", remaining: 0 },
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      error: "RATE_LIMITED",
      retryAfter: 999,
      attempts: 1,
      source: "server",
    });
  });

  it("oppdaterer org-bucket fra 200-respons med X-RateLimit-Remaining=0", async () => {
    // Quinn fix #3: uten disambiguating header skal customer-bucket IKKE
    // caches (vi vet ikke om den ene rate-limit-headeren refererer til
    // org-, agent- eller customer-bucket; over-pessimisme på org er trygt,
    // over-pessimisme på customer:A blokkerer fremtidige calls mot kunde B).
    const futureResetEpoch = Math.floor(Date.now() / 1000) + 30; // 30s i framtiden
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      rlResponse({ name: "Verkvelven AS" }, {
        remaining: 0,
        resetEpoch: futureResetEpoch,
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
    );

    expect(result).toEqual({ name: "Verkvelven AS" });
    const cache = __peekRateLimitCacheForTest();
    // Org-bucket alltid populert (KUNDEOVERSIKT_ORG_ID satt).
    expect(cache.get(`org:${ORG_ID}`)).toEqual({
      remaining: 0,
      resetEpoch: futureResetEpoch,
    });
    // Customer-bucket skal IKKE populeres uten X-RateLimit-Bucket/Scope.
    expect(cache.get(`customer:${CUSTOMER_ID}`)).toBeUndefined();
  });

  it("cacher customer-bucket KUN når X-RateLimit-Bucket=customer er satt", async () => {
    const futureResetEpoch = Math.floor(Date.now() / 1000) + 30;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      rlResponse({ name: "Verkvelven AS" }, {
        remaining: 2,
        resetEpoch: futureResetEpoch,
        extraHeaders: { "X-RateLimit-Bucket": "customer" },
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
    );

    const cache = __peekRateLimitCacheForTest();
    expect(cache.get(`org:${ORG_ID}`)).toEqual({
      remaining: 2,
      resetEpoch: futureResetEpoch,
    });
    expect(cache.get(`customer:${CUSTOMER_ID}`)).toEqual({
      remaining: 2,
      resetEpoch: futureResetEpoch,
    });
  });

  it("kortslutter pre-call når cache viser remaining=0 — ingen fetch utføres", async () => {
    const futureResetEpoch = Math.floor(Date.now() / 1000) + 30;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        rlResponse({ name: "first" }, {
          remaining: 0,
          resetEpoch: futureResetEpoch,
        }),
      );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Første kall: cacher remaining=0 (org + customer-bucket)
    const first = await executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
    );
    expect(first).toEqual({ name: "first" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Andre kall mot samme customer: skal kortsluttes uten fetch.
    const second = await executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1); // ingen ny fetch
    expect(second).toMatchObject({
      error: "RATE_LIMITED",
      attempts: 0,
      source: "cache",
    });
    // Bucket skal være satt til en av de cachede nøklene (org eller customer)
    expect((second as { bucket: string }).bucket).toMatch(
      /^(org:|customer:)/,
    );
  });

  it("returnerer RATE_LIMITED med attempts=2 når retry også får 429", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        rlResponse(
          { error: "rate limited" },
          { status: 429, retryAfter: "2", remaining: 0 },
        ),
      )
      .mockResolvedValueOnce(
        rlResponse(
          { error: "still rate limited" },
          { status: 429, retryAfter: "5", remaining: 0 },
        ),
      );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
    );
    await vi.advanceTimersByTimeAsync(2_500);

    const result = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      error: "RATE_LIMITED",
      attempts: 2,
      source: "server",
      retryAfter: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// Quinn fixes: extended rate-limit edge cases
// ---------------------------------------------------------------------------

describe("Quinn fix #2: extractCustomerIdFromPathOrBody UUID-strict", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AGENT_API_KEY = "test-api-key";
    process.env.KUNDEOVERSIKT_DRAFTS_URL = "https://kunde.test/api/agent/drafts";
    process.env.KUNDEOVERSIKT_ORG_ID = ORG_ID;
    process.env.PAPERCLIP_DRY_RUN = "false";
    process.env.PAPERCLIP_AGENT_JWT_ENABLED = "false";
    __resetRateLimitCacheForTest();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    __resetRateLimitCacheForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ikke-UUID etter /customers/ skal ikke trigge customer-bucket cache", async () => {
    // Bruker /customers/anonymous/foo i en hypotetisk path. agentFetch tar
    // path som første arg; vi går via et eksisterende verktøy som lar oss
    // mate inn ikke-UUID. kundeoversikt_get_customer_context krever string
    // customerId men validerer ikke UUID på adapter-side, så vi kan misbruke.
    const futureResetEpoch = Math.floor(Date.now() / 1000) + 30;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "anon" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(futureResetEpoch),
          "X-RateLimit-Bucket": "customer", // selv med disambiguating header
        },
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: "anonymous" }, // ikke en UUID
    );

    const cache = __peekRateLimitCacheForTest();
    // Org skal caches (felles bucket).
    expect(cache.get(`org:${ORG_ID}`)).toBeDefined();
    // Customer-bucket må ikke caches under en non-UUID nøkkel — det ville
    // tilsvart å blokkere alle "anonymous"-kunder.
    expect(cache.get(`customer:anonymous`)).toBeUndefined();
    // Ingen customer-key i det hele tatt:
    const customerKeys = Array.from(cache.keys()).filter((k) =>
      k.startsWith("customer:"),
    );
    expect(customerKeys).toEqual([]);
  });
});

describe("Quinn fix #4: backoff floor mot busy-loop", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AGENT_API_KEY = "test-api-key";
    process.env.KUNDEOVERSIKT_DRAFTS_URL = "https://kunde.test/api/agent/drafts";
    process.env.KUNDEOVERSIKT_ORG_ID = ORG_ID;
    process.env.PAPERCLIP_DRY_RUN = "false";
    process.env.PAPERCLIP_AGENT_JWT_ENABLED = "false";
    __resetRateLimitCacheForTest();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    __resetRateLimitCacheForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("429 uten Retry-After + resetEpoch i fortiden gir minst 5s backoff", async () => {
    // Server returnerer 429 med X-RateLimit-Reset i fortiden (race condition).
    // Uten floor ville agentFetch retry'e umiddelbart, treffe 429 igjen, og
    // returnere RATE_LIMITED med retryAfter:1 → agent busy-loop.
    vi.useFakeTimers();
    const pastResetEpoch = Math.floor(Date.now() / 1000) - 10;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(pastResetEpoch),
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "Verkvelven AS" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "9",
            "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60),
          },
        }),
      );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
    );

    // Etter 4 sekunder skal retry IKKE ha skjedd ennå (floor=5s).
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Etter 5+ sekunder skal retry ha skjedd.
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ name: "Verkvelven AS" });
  });

  it("429 med Retry-After:0 (no-guidance) gir minst 5s backoff", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        rlResponse(
          { error: "rate limited" },
          { status: 429, retryAfter: "0", remaining: 0 },
        ),
      )
      .mockResolvedValueOnce(
        rlResponse({ name: "ok" }, { remaining: 9 }),
      );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
    );

    // Før 5s: retry skal IKKE ha skjedd.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Etter 5s+: retry skal ha skjedd.
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ name: "ok" });
  });
});

describe("Quinn fix #1: knowledge-note-draft (agentBookkeepingFetch) respekterer rate-limit", () => {
  const originalEnv = { ...process.env };
  const KNOWLEDGE_NOTE_ARGS = {
    customerId: CUSTOMER_ID,
    customerSlug: "verkvelven-as",
    noteKey: "test-key",
    noteType: "accounting_rule",
    title: "Test",
    contentMd: "# Test",
    content: {
      scope: "customer",
      trigger: "x",
      action: "y",
      source: "z",
    },
    rationale: "test rationale",
    confidence: 0.9,
  };

  function knResponse(
    body: unknown,
    init: {
      status?: number;
      retryAfter?: string;
      remaining?: number;
      resetEpoch?: number;
      extraHeaders?: Record<string, string>;
    } = {},
  ): Response {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Kundeoversikt-Contract-Version": "1",
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": String(init.remaining ?? 10),
      "X-RateLimit-Reset": String(init.resetEpoch ?? 1893456000),
      ...(init.extraHeaders ?? {}),
    };
    if (init.retryAfter !== undefined) {
      headers["Retry-After"] = init.retryAfter;
    }
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers,
    });
  }

  beforeEach(() => {
    process.env.AGENT_API_KEY = "test-api-key";
    process.env.KUNDEOVERSIKT_DRAFTS_URL = "https://kunde.test/api/agent/drafts";
    process.env.KUNDEOVERSIKT_ORG_ID = ORG_ID;
    process.env.PAPERCLIP_DRY_RUN = "false";
    process.env.PAPERCLIP_AGENT_JWT_ENABLED = "false";
    __resetRateLimitCacheForTest();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    __resetRateLimitCacheForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("knowledge-note 429 + Retry-After=2 → vent + ÉN retry → success", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        knResponse(
          { error: "rate limited" },
          { status: 429, retryAfter: "2", remaining: 0 },
        ),
      )
      .mockResolvedValueOnce(
        knResponse(
          {
            status: "pending_review",
            noteId: "n1",
            revisionId: "r1",
            queueId: "q1",
            basedOnRevisionId: null,
            diffPreview: "+ x",
            embeddingStatus: "ok",
            requiresToreReview: true,
          },
          { remaining: 9 },
        ),
      );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      { ...KNOWLEDGE_NOTE_ARGS },
      { agentId: "agent-A", runId: "run-1" },
    );
    await vi.advanceTimersByTimeAsync(2_500);

    const result = (await promise) as Record<string, unknown>;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.noteId).toBe("n1");
    expect(result.embeddingStatus).toBe("ok");
  });

  it("knowledge-note treffer cache pre-call gate når org-bucket viser remaining=0", async () => {
    const futureResetEpoch = Math.floor(Date.now() / 1000) + 30;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        knResponse({ name: "first" }, {
          remaining: 0,
          resetEpoch: futureResetEpoch,
        }),
      );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Først: gjør et agentFetch-kall mot get_customer_context for å fylle
    // org-bucket cache med remaining=0.
    const first = await executeKundeoversiktTool(
      "kundeoversikt_get_customer_context",
      { customerId: CUSTOMER_ID },
      { agentId: "agent-A", runId: "run-1" },
    );
    expect(first).toEqual({ name: "first" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Nå: knowledge-note skal kortsluttes uten å kalle fetch.
    const second = await executeKundeoversiktTool(
      "kundeoversikt_upsert_knowledge_note_draft",
      { ...KNOWLEDGE_NOTE_ARGS },
      { agentId: "agent-A", runId: "run-1" },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1); // ingen ny fetch
    expect(second).toMatchObject({
      error: "RATE_LIMITED",
      attempts: 0,
      source: "cache",
    });
  });
});
