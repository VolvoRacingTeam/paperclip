import { describe, expect, it } from "vitest";

import {
  backoffFor429,
  computeBackoffMs,
  parseRateLimitHeaders,
} from "./rate-limit-client.js";

describe("parseRateLimitHeaders", () => {
  it("parser gyldige rate-limit-headere", () => {
    const headers = new Headers({
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": "7",
      "X-RateLimit-Reset": "1713356400",
    });

    expect(parseRateLimitHeaders(headers)).toEqual({
      limit: 60,
      remaining: 7,
      resetEpoch: 1713356400,
    });
  });

  it("returnerer null ved manglende headere", () => {
    const headers = new Headers({
      "X-RateLimit-Limit": "60",
    });

    expect(parseRateLimitHeaders(headers)).toBeNull();
  });
});

describe("computeBackoffMs", () => {
  it("venter til reset når remaining er på eller under threshold", () => {
    const backoffMs = computeBackoffMs(
      { limit: 60, remaining: 4, resetEpoch: 200 },
      { nowMs: 195_000 },
    );

    expect(backoffMs).toBe(5_000);
    expect(
      computeBackoffMs(
        { limit: 60, remaining: 6, resetEpoch: 200 },
        { nowMs: 195_000 },
      ),
    ).toBe(0);
  });
});

describe("backoffFor429", () => {
  it("bruker Retry-After når headeren finnes", () => {
    const response = new Response(JSON.stringify({ error: "For mange forespørsler" }), {
      status: 429,
      headers: {
        "Retry-After": "12",
        "X-RateLimit-Limit": "60",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "200",
      },
    });

    expect(backoffFor429(response, 195_000)).toBe(12_000);
  });

  it("faller tilbake til X-RateLimit-Reset når Retry-After mangler", () => {
    const response = new Response(JSON.stringify({ error: "For mange forespørsler" }), {
      status: 429,
      headers: {
        "X-RateLimit-Limit": "60",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "200",
      },
    });

    expect(backoffFor429(response, 195_000)).toBe(5_000);
  });
});
