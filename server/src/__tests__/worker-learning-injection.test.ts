import { beforeEach, describe, expect, it, vi } from "vitest";

import { workerLearningInjectionService } from "../services/worker-learning-injection.js";

/**
 * Unit-tester for Tier 1 pattern-injection.
 * Fokus: query-rangering, TTL-filtrering, max-tokens-truncation.
 */

function makeDb(rows: any[]) {
  // Enkel mock som returnerer rows uansett query.
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: (cb: any) => Promise.resolve(rows).then(cb),
    })),
  } as any;
}

function makePattern(overrides: any) {
  return {
    id: overrides.id ?? "pat-1",
    companyId: "c-1",
    workerAgentId: overrides.workerAgentId ?? "worker-1",
    patternTag: overrides.patternTag ?? "some_tag",
    patternDescription: overrides.patternDescription ?? "[severity=warning] Default description",
    exampleCorrect: overrides.exampleCorrect ?? null,
    exampleWrong: overrides.exampleWrong ?? null,
    occurrenceCount: overrides.occurrenceCount ?? 1,
    lastSeenAt: overrides.lastSeenAt ?? new Date(),
    injectedToPrompt: false,
    injectedAt: null,
    ruleInAgentsMd: false,
    knowledgeBaseEntryId: null,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    archivedAt: overrides.archivedAt ?? null,
  };
}

describe("workerLearningInjectionService", () => {
  const ENV_KEY = "PAPERCLIP_WORKER_PATTERN_INJECTION_ENABLED";

  beforeEach(() => {
    process.env[ENV_KEY] = "true";
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("returnerer null naar env-flag er av", async () => {
    delete process.env[ENV_KEY];
    const db = makeDb([makePattern({})]);
    const svc = workerLearningInjectionService(db);
    const md = await svc.buildLearningMarkdownForWorker("w-1");
    expect(md).toBeNull();
  });

  it("returnerer null naar ingen patterns finnes", async () => {
    const db = makeDb([]);
    const svc = workerLearningInjectionService(db);
    const md = await svc.buildLearningMarkdownForWorker("w-1");
    expect(md).toBeNull();
  });

  it("filtrerer ut patterns som er over TTL for severity", async () => {
    const now = new Date("2026-04-24T12:00:00Z");
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const db = makeDb([
      // info TTL = 10d; 40d gammel -> skal filtreres bort
      makePattern({
        id: "too-old-info",
        patternDescription: "[severity=info] stale",
        lastSeenAt: fortyDaysAgo,
      }),
      // critical TTL = 45d; 40d gammel -> beholdes
      makePattern({
        id: "fresh-crit",
        patternDescription: "[severity=critical] recent critical",
        lastSeenAt: fortyDaysAgo,
      }),
      // warning TTL = 21d; 1d gammel -> beholdes
      makePattern({
        id: "fresh-warn",
        patternDescription: "[severity=warning] recent warning",
        lastSeenAt: oneDayAgo,
      }),
    ]);
    const svc = workerLearningInjectionService(db);
    const patterns = await svc.fetchTopPatterns("w-1", { now });
    const ids = patterns.map((p) => p.id);
    expect(ids).toContain("fresh-crit");
    expect(ids).toContain("fresh-warn");
    expect(ids).not.toContain("too-old-info");
  });

  it("sorterer severity (critical > warning > info)", async () => {
    const now = new Date("2026-04-24T12:00:00Z");
    const db = makeDb([
      makePattern({ id: "w", patternDescription: "[severity=warning] W", occurrenceCount: 5 }),
      makePattern({ id: "i", patternDescription: "[severity=info] I", occurrenceCount: 10 }),
      makePattern({ id: "c", patternDescription: "[severity=critical] C", occurrenceCount: 1 }),
    ]);
    const svc = workerLearningInjectionService(db);
    const patterns = await svc.fetchTopPatterns("w-1", { now });
    const severities = patterns.map((p) => p.patternDescription.match(/severity=(\w+)/)?.[1]);
    expect(severities[0]).toBe("critical");
    expect(severities[1]).toBe("warning");
    expect(severities[2]).toBe("info");
  });

  it("ekskluderer archivedAt-satte patterns hvis archivedAtAvailable=true", async () => {
    const db = makeDb([
      makePattern({ id: "archived", archivedAt: new Date() }),
      makePattern({ id: "active" }),
    ]);
    const svc = workerLearningInjectionService(db);
    const patterns = await svc.fetchTopPatterns("w-1", { archivedAtAvailable: true });
    const ids = patterns.map((p) => p.id);
    expect(ids).toContain("active");
    expect(ids).not.toContain("archived");
  });

  it("respekterer limit", async () => {
    const db = makeDb(
      Array.from({ length: 10 }, (_, i) =>
        makePattern({ id: `p-${i}`, patternTag: `tag_${i}`, occurrenceCount: 10 - i }),
      ),
    );
    const svc = workerLearningInjectionService(db);
    const patterns = await svc.fetchTopPatterns("w-1", { limit: 3 });
    expect(patterns).toHaveLength(3);
  });

  it("rendrer markdown med header og numbered patterns", async () => {
    const db = makeDb([
      makePattern({
        id: "p1",
        patternTag: "missing_grounding",
        patternDescription: "[severity=critical] Unngaa pastander uten evidens",
        exampleWrong: { text: "Kunde godkjente X" },
        exampleCorrect: { text: "Godkjenning ikke bekreftet" },
      }),
    ]);
    const svc = workerLearningInjectionService(db);
    const md = await svc.buildLearningMarkdownForWorker("w-1");
    expect(md).toContain("## Tier 1 Learned Patterns");
    expect(md).toContain("1. [critical] `missing_grounding`");
    expect(md).toContain("Feil:");
    expect(md).toContain("Riktig:");
  });

  it("truncater examples aggressivt ved token-overflow", async () => {
    const longText = "A".repeat(2000);
    const manyPatterns = Array.from({ length: 5 }, (_, i) =>
      makePattern({
        id: `p-${i}`,
        patternTag: `tag_${i}`,
        patternDescription: "[severity=warning] " + "B".repeat(300),
        exampleWrong: { text: longText },
        exampleCorrect: { text: longText },
      }),
    );
    const db = makeDb(manyPatterns);
    const svc = workerLearningInjectionService(db);
    const patterns = await svc.fetchTopPatterns("w-1", { limit: 5 });
    const md = svc.renderPatternsMarkdown(patterns, { maxTokensApprox: 400 });
    const approxTokens = svc._approxTokens(md);
    expect(approxTokens).toBeLessThanOrEqual(420); // allow small slack
  });

  it("severity-ekstraksjon defaulter til warning hvis marker mangler", () => {
    const db = makeDb([]);
    const svc = workerLearningInjectionService(db);
    expect(svc._extractSeverity("plain description")).toBe("warning");
    expect(svc._extractSeverity("[severity=critical] desc")).toBe("critical");
    expect(svc._extractSeverity(null)).toBe("warning");
  });
});

// afterEach import
import { afterEach } from "vitest";
