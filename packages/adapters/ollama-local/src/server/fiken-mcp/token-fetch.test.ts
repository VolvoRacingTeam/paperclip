import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FikenAccessTokenFetcher } from "./token-fetch.js";

interface MockFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function makeMockFetch(handler: (call: MockFetchCall) => Promise<Response> | Response) {
  const calls: MockFetchCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ORIGINAL_AGENT_API_KEY = process.env.AGENT_API_KEY;

describe("FikenAccessTokenFetcher", () => {
  beforeEach(() => {
    delete process.env.AGENT_API_KEY;
    delete process.env.KUNDEOVERSIKT_BASE_URL;
  });

  afterEach(() => {
    if (ORIGINAL_AGENT_API_KEY === undefined) delete process.env.AGENT_API_KEY;
    else process.env.AGENT_API_KEY = ORIGINAL_AGENT_API_KEY;
  });

  it("requires an AGENT_API_KEY", () => {
    expect(() => new FikenAccessTokenFetcher()).toThrow(/AGENT_API_KEY/);
  });

  it("calls Kundeoversikt with the agent api key header", async () => {
    const { fn, calls } = makeMockFetch(() =>
      jsonResponse(200, {
        accessToken: "tok-1",
        companySlug: "fiken-demo-total-blomst-as",
      }),
    );
    const fetcher = new FikenAccessTokenFetcher({
      apiKey: "secret-key",
      baseUrl: "https://kundeoversikt.test",
      fetchImpl: fn,
      nowMs: () => 1_000,
    });

    const creds = await fetcher.getCredentials({
      tenantId: "tenant-1",
      companySlug: "fiken-demo-total-blomst-as",
    });

    expect(creds.accessToken).toBe("tok-1");
    expect(creds.companySlug).toBe("fiken-demo-total-blomst-as");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://kundeoversikt.test/api/agent/fiken-credentials/tenant-1");
    const headers = calls[0]!.init?.headers as Record<string, string> | undefined;
    expect(headers?.["X-Agent-Api-Key"]).toBe("secret-key");
  });

  it("caches results within the TTL", async () => {
    let now = 1_000;
    const { fn, calls } = makeMockFetch(() =>
      jsonResponse(200, {
        accessToken: "tok-cached",
        companySlug: "fiken-demo-total-blomst-as",
      }),
    );
    const fetcher = new FikenAccessTokenFetcher({
      apiKey: "k",
      fetchImpl: fn,
      nowMs: () => now,
      cacheTtlMs: 60_000,
    });

    await fetcher.getCredentials({ tenantId: "t1" });
    now += 30_000; // within TTL
    await fetcher.getCredentials({ tenantId: "t1" });
    expect(calls).toHaveLength(1);
  });

  it("refetches after the TTL expires", async () => {
    let now = 1_000;
    const { fn, calls } = makeMockFetch(() =>
      jsonResponse(200, {
        accessToken: "tok-new",
        companySlug: "fiken-demo-total-blomst-as",
      }),
    );
    const fetcher = new FikenAccessTokenFetcher({
      apiKey: "k",
      fetchImpl: fn,
      nowMs: () => now,
      cacheTtlMs: 60_000,
    });

    await fetcher.getCredentials({ tenantId: "t1" });
    now += 70_000; // past TTL
    await fetcher.getCredentials({ tenantId: "t1" });
    expect(calls).toHaveLength(2);
  });

  it("forceRefresh bypasses the cache", async () => {
    const { fn, calls } = makeMockFetch(() =>
      jsonResponse(200, {
        accessToken: "tok-x",
        companySlug: "fiken-demo-total-blomst-as",
      }),
    );
    const fetcher = new FikenAccessTokenFetcher({
      apiKey: "k",
      fetchImpl: fn,
      nowMs: () => 1_000,
    });

    await fetcher.getCredentials({ tenantId: "t1" });
    await fetcher.getCredentials({ tenantId: "t1", forceRefresh: true });
    expect(calls).toHaveLength(2);
  });

  it("invalidate() drops a single cache entry", async () => {
    const { fn, calls } = makeMockFetch(() =>
      jsonResponse(200, {
        accessToken: "tok-y",
        companySlug: "fiken-demo-total-blomst-as",
      }),
    );
    const fetcher = new FikenAccessTokenFetcher({
      apiKey: "k",
      fetchImpl: fn,
      nowMs: () => 1_000,
    });
    await fetcher.getCredentials({ tenantId: "t1", companySlug: "fiken-demo-total-blomst-as" });
    fetcher.invalidate({ tenantId: "t1", companySlug: "fiken-demo-total-blomst-as" });
    await fetcher.getCredentials({ tenantId: "t1", companySlug: "fiken-demo-total-blomst-as" });
    expect(calls).toHaveLength(2);
  });

  it("rejects when companySlug from server doesn't match the requested one", async () => {
    const { fn } = makeMockFetch(() =>
      jsonResponse(200, {
        accessToken: "tok",
        companySlug: "fiken-other-as",
      }),
    );
    const fetcher = new FikenAccessTokenFetcher({
      apiKey: "k",
      fetchImpl: fn,
      nowMs: () => 0,
    });

    await expect(
      fetcher.getCredentials({ tenantId: "t1", companySlug: "fiken-demo-total-blomst-as" }),
    ).rejects.toThrow(/companySlug='fiken-other-as'/);
  });

  it("maps 401/403 to an unauthorized error", async () => {
    const { fn } = makeMockFetch(() => jsonResponse(401, { error: "unauthorized" }));
    const fetcher = new FikenAccessTokenFetcher({
      apiKey: "k",
      fetchImpl: fn,
      nowMs: () => 0,
    });
    await expect(fetcher.getCredentials({ tenantId: "t1" })).rejects.toThrow(
      /unauthorized \(401\)/,
    );
  });

  it("maps 404 to a no-credentials error", async () => {
    const { fn } = makeMockFetch(() => jsonResponse(404, { error: "not_found" }));
    const fetcher = new FikenAccessTokenFetcher({
      apiKey: "k",
      fetchImpl: fn,
      nowMs: () => 0,
    });
    await expect(fetcher.getCredentials({ tenantId: "t1" })).rejects.toThrow(
      /no Fiken credentials/,
    );
  });

  it("rejects responses missing accessToken", async () => {
    const { fn } = makeMockFetch(() =>
      jsonResponse(200, { companySlug: "fiken-demo-total-blomst-as" }),
    );
    const fetcher = new FikenAccessTokenFetcher({
      apiKey: "k",
      fetchImpl: fn,
      nowMs: () => 0,
    });
    await expect(fetcher.getCredentials({ tenantId: "t1" })).rejects.toThrow(
      /accessToken/,
    );
  });
});
