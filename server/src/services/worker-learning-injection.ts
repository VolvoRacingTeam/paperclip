import { and, eq, gte, or, sql, isNotNull, isNull, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workerLearningPatterns, type WorkerLearningPattern } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Tier 1 pattern-injection for workers.
 *
 * Naar en worker-agent vekkes, laster vi opptil N aktive patterns fra
 * worker_learning_patterns og rendrer dem som en "Tier 1 Learned Patterns"
 * markdown-seksjon. Seksjonen appends til slutten av worker's system-prompt.
 *
 * TTL per severity:
 *   critical -> 45 dager
 *   warning  -> 21 dager
 *   info     -> 10 dager
 *
 * Severity utledes fra pattern_description-prefixet [severity=X] som
 * workerReviewService.upsertWorkerPattern skriver.
 *
 * Guard: env-var PAPERCLIP_WORKER_PATTERN_INJECTION_ENABLED (default false).
 */

export interface WorkerLearningInjectionOpts {
  limit?: number;
  maxTokensApprox?: number;
  now?: Date;
  archivedAtAvailable?: boolean; // sett av caller etter 0048-migration
}

type Severity = "info" | "warning" | "critical";

const SEVERITY_RANK: Record<Severity, number> = { info: 1, warning: 2, critical: 3 };

function extractSeverity(desc: string | null): Severity {
  if (!desc) return "warning";
  const m = /^\[severity=(info|warning|critical)\]/u.exec(desc);
  return (m?.[1] as Severity | undefined) ?? "warning";
}

function stripSeverityMarker(desc: string): string {
  return desc.replace(/^\[severity=(info|warning|critical)\]\s*/u, "");
}

function severityTtlDays(severity: Severity): number {
  switch (severity) {
    case "critical":
      return 45;
    case "warning":
      return 21;
    default:
      return 10;
  }
}

function approxTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for Norwegian/English mixed text.
  return Math.ceil(text.length / 4);
}

/**
 * Truncate string at word boundary within maxChars.
 */
function truncateAt(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 40 ? slice.slice(0, lastSpace) : slice).trim() + "…";
}

export function workerLearningInjectionService(db: Db) {
  /**
   * Hent og rangere patterns for en worker.
   * 1. Filtrer paa freshness (>= now - ttl[severity]).
   * 2. Filtrer ut archived_at hvis kolonnen finnes.
   * 3. Sorter: severity DESC, occurrence_count DESC, last_seen_at DESC.
   * 4. Limit N.
   */
  async function fetchTopPatterns(
    workerAgentId: string,
    opts: WorkerLearningInjectionOpts = {},
  ): Promise<WorkerLearningPattern[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
    const now = opts.now ?? new Date();

    // Vi kan ikke filtrere per-row-severity i SQL saa lenge severity er
    // kodet som prefix i description. Henter de siste 40 for workeren
    // sortert paa occurrence+freshness og filtrerer i memory.
    const baseQuery = db
      .select()
      .from(workerLearningPatterns)
      .where(eq(workerLearningPatterns.workerAgentId, workerAgentId))
      .orderBy(
        desc(workerLearningPatterns.occurrenceCount),
        desc(workerLearningPatterns.lastSeenAt),
      )
      .limit(40);

    const rows = await baseQuery;

    // In-memory: apply per-severity TTL og archived_at-sjekk hvis tilgjengelig.
    const kept: WorkerLearningPattern[] = [];
    for (const row of rows) {
      // Archived guard — hvis archived_at-kolonnen eksisterer og er satt, skip.
      if (opts.archivedAtAvailable) {
        const r = row as unknown as Record<string, unknown>;
        if (r["archivedAt"] != null) continue;
      }
      const sev = extractSeverity(row.patternDescription);
      const ttlMs = severityTtlDays(sev) * 24 * 60 * 60 * 1000;
      const lastSeen = row.lastSeenAt instanceof Date
        ? row.lastSeenAt
        : new Date(row.lastSeenAt as unknown as string);
      if (now.getTime() - lastSeen.getTime() > ttlMs) continue;
      kept.push(row);
    }

    // Final sort by (severity, occurrence, freshness)
    kept.sort((a, b) => {
      const sevA = SEVERITY_RANK[extractSeverity(a.patternDescription)];
      const sevB = SEVERITY_RANK[extractSeverity(b.patternDescription)];
      if (sevA !== sevB) return sevB - sevA;
      const occA = a.occurrenceCount ?? 1;
      const occB = b.occurrenceCount ?? 1;
      if (occA !== occB) return occB - occA;
      const tsA = a.lastSeenAt instanceof Date ? a.lastSeenAt.getTime() : new Date(a.lastSeenAt as unknown as string).getTime();
      const tsB = b.lastSeenAt instanceof Date ? b.lastSeenAt.getTime() : new Date(b.lastSeenAt as unknown as string).getTime();
      return tsB - tsA;
    });

    return kept.slice(0, limit);
  }

  /**
   * Rendrer patterns som markdown. Respekterer maxTokens-budsjett ved at vi
   * aggressivt truncater examples, deretter faerre patterns, hvis noedvendig.
   */
  function renderPatternsMarkdown(
    patterns: WorkerLearningPattern[],
    opts: { maxTokensApprox?: number } = {},
  ): string {
    if (patterns.length === 0) return "";
    const maxTokens = opts.maxTokensApprox ?? 400;

    const header =
      "## Tier 1 Learned Patterns\n" +
      "Disse er nylige manager-laerte korreksjoner for dine egne gjentatte feil. " +
      "Anvend dem foer innlevering. Kilde-evidens for naavaerende oppgave overstyrer alltid et laert moenster.\n";

    // Foerste runde: full rendering
    let rendered = renderAllPatterns(patterns, 240);
    if (approxTokens(header + rendered) <= maxTokens) {
      return header + rendered;
    }
    // 2. runde: korte examples
    rendered = renderAllPatterns(patterns, 120);
    if (approxTokens(header + rendered) <= maxTokens) {
      return header + rendered;
    }
    // 3. runde: drop examples
    rendered = renderAllPatterns(patterns, 0);
    if (approxTokens(header + rendered) <= maxTokens) {
      return header + rendered;
    }
    // 4. runde: redusere antall patterns
    for (let n = patterns.length - 1; n >= 1; n--) {
      rendered = renderAllPatterns(patterns.slice(0, n), 0);
      if (approxTokens(header + rendered) <= maxTokens) {
        return header + rendered;
      }
    }
    // Siste utvei: korteste mulige
    return header + renderAllPatterns(patterns.slice(0, 1), 0);
  }

  function renderAllPatterns(
    patterns: WorkerLearningPattern[],
    exampleCharCap: number,
  ): string {
    return patterns
      .map((p, idx) => renderOnePattern(p, idx + 1, exampleCharCap))
      .join("\n");
  }

  function renderOnePattern(
    p: WorkerLearningPattern,
    index: number,
    exampleCharCap: number,
  ): string {
    const severity = extractSeverity(p.patternDescription);
    const desc = stripSeverityMarker(p.patternDescription);
    const lines: string[] = [];
    lines.push(`${index}. [${severity}] \`${p.patternTag}\``);
    lines.push(truncateAt(desc, 220));
    if (exampleCharCap > 0) {
      const ew = (p.exampleWrong as Record<string, unknown> | null)?.text;
      if (typeof ew === "string" && ew.trim().length > 0) {
        lines.push(`Feil: ${truncateAt(ew, exampleCharCap)}`);
      }
      const ec = (p.exampleCorrect as Record<string, unknown> | null)?.text;
      if (typeof ec === "string" && ec.trim().length > 0) {
        lines.push(`Riktig: ${truncateAt(ec, exampleCharCap)}`);
      }
    }
    return lines.join("\n");
  }

  /**
   * Build markdown for a worker. Returnerer null hvis injection er avslaatt
   * eller ingen patterns.
   */
  async function buildLearningMarkdownForWorker(
    workerAgentId: string,
    opts: WorkerLearningInjectionOpts = {},
  ): Promise<string | null> {
    const enabled = process.env.PAPERCLIP_WORKER_PATTERN_INJECTION_ENABLED === "true";
    if (!enabled) return null;
    try {
      const patterns = await fetchTopPatterns(workerAgentId, opts);
      if (patterns.length === 0) return null;
      return renderPatternsMarkdown(patterns, { maxTokensApprox: opts.maxTokensApprox });
    } catch (err) {
      logger.warn({ err, workerAgentId }, "worker-learning-injection: failed to build markdown");
      return null;
    }
  }

  return {
    fetchTopPatterns,
    renderPatternsMarkdown,
    buildLearningMarkdownForWorker,
    // Exported for tests
    _extractSeverity: extractSeverity,
    _approxTokens: approxTokens,
    _severityTtlDays: severityTtlDays,
  };
}

export type WorkerLearningInjectionService = ReturnType<typeof workerLearningInjectionService>;
