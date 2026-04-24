/**
 * manager-sonnet-usage service - Pakke D (SON-97).
 *
 * Skriver telemetri for hver claude_local-run hvor agenten opererer som
 * manager (basert paa wakeReason). Eksponerer:
 *   - record(): persister en run
 *   - aggregateByAgent(): aggregert per agent siste N timer
 *   - hourlyAggregateAndLog(): kjores hver time, logger
 *     activity_log-event 'manager_sonnet.hourly_usage' og fyrer
 *     manager_sonnet.daily_alert hvis sum > 500k tokens / 24t
 */
import { sql, and, eq, gte, lt, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { managerSonnetUsage, companies, activityLog } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

/**
 * wakeReason-verdier som signaliserer at agenten kjorte som manager.
 * Pakke C utvider listen ved behov.
 */
export const MANAGER_WAKE_REASONS: ReadonlySet<string> = new Set([
  "manager_review_pending",
  "manager_review",
  "direct_approval",
]);

/**
 * Default daglig alert-grense (tokens) per company. Override via
 * PAPERCLIP_MANAGER_SONNET_DAILY_ALERT_TOKENS.
 */
export const DEFAULT_DAILY_ALERT_TOKENS = 500_000;

export interface RecordUsageInput {
  companyId: string;
  agentId: string;
  runId?: string | null;
  reason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  createdAt?: Date;
}

export interface AgentAggregate {
  agentId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  avgDurationMs: number | null;
}

function parseWindow(window: string | undefined): number {
  // returnerer milliseconds. Default 24h. Stoetter "24h", "1h", "60m".
  if (!window) return 24 * 60 * 60 * 1000;
  const m = /^(\d+)\s*(h|m)$/i.exec(window.trim());
  if (!m) return 24 * 60 * 60 * 1000;
  const n = parseInt(m[1]!, 10);
  if (m[2]!.toLowerCase() === "m") return n * 60 * 1000;
  return n * 60 * 60 * 1000;
}

export function isManagerWakeReason(reason: unknown): boolean {
  if (typeof reason !== "string") return false;
  return MANAGER_WAKE_REASONS.has(reason.trim());
}

/**
 * Estimer token-bruk fra prompt-stoerrelse hvis usage-stats fra
 * claude-cli mangler. Heuristikk: ~4 tegn per token.
 */
export function estimateTokensFromCharCount(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.round(chars / 4));
}

export interface ManagerSonnetUsageService {
  record(input: RecordUsageInput): Promise<{ id: string }>;
  aggregateByAgent(companyId: string, window?: string): Promise<AgentAggregate[]>;
  hourlyAggregateAndLog(now?: Date): Promise<{ companies: number; alerts: number }>;
}

export function managerSonnetUsageService(db: Db): ManagerSonnetUsageService {
  const dailyAlertTokens = (() => {
    const raw = process.env.PAPERCLIP_MANAGER_SONNET_DAILY_ALERT_TOKENS;
    if (!raw) return DEFAULT_DAILY_ALERT_TOKENS;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_ALERT_TOKENS;
  })();

  async function record(input: RecordUsageInput) {
    const [row] = await db
      .insert(managerSonnetUsage)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId ?? null,
        reason: input.reason ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        durationMs: input.durationMs ?? null,
        createdAt: input.createdAt ?? new Date(),
      })
      .returning({ id: managerSonnetUsage.id });
    return { id: row!.id };
  }

  async function aggregateByAgent(
    companyId: string,
    window?: string,
  ): Promise<AgentAggregate[]> {
    const fromTs = new Date(Date.now() - parseWindow(window));
    const rows = await db
      .select({
        agentId: managerSonnetUsage.agentId,
        totalInputTokens: sql<number>`COALESCE(SUM(${managerSonnetUsage.inputTokens}), 0)`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${managerSonnetUsage.outputTokens}), 0)`,
        requestCount: sql<number>`COUNT(*)`,
        avgDurationMs: sql<number | null>`AVG(${managerSonnetUsage.durationMs})`,
      })
      .from(managerSonnetUsage)
      .where(
        and(
          eq(managerSonnetUsage.companyId, companyId),
          gte(managerSonnetUsage.createdAt, fromTs),
        ),
      )
      .groupBy(managerSonnetUsage.agentId)
      .orderBy(desc(sql`SUM(${managerSonnetUsage.inputTokens} + ${managerSonnetUsage.outputTokens})`));
    return rows.map((r) => ({
      agentId: r.agentId,
      totalInputTokens: Number(r.totalInputTokens ?? 0),
      totalOutputTokens: Number(r.totalOutputTokens ?? 0),
      requestCount: Number(r.requestCount ?? 0),
      avgDurationMs: r.avgDurationMs == null ? null : Number(r.avgDurationMs),
    }));
  }

  async function hourlyAggregateAndLog(now: Date = new Date()) {
    // Aggregat for forrige hele time. Eks. now=14:23 -> [13:00, 14:00).
    const end = new Date(now);
    end.setMinutes(0, 0, 0);
    const start = new Date(end);
    start.setHours(start.getHours() - 1);

    const perCompany = await db
      .select({
        companyId: managerSonnetUsage.companyId,
        totalInputTokens: sql<number>`COALESCE(SUM(${managerSonnetUsage.inputTokens}), 0)`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${managerSonnetUsage.outputTokens}), 0)`,
        requestCount: sql<number>`COUNT(*)`,
      })
      .from(managerSonnetUsage)
      .where(
        and(
          gte(managerSonnetUsage.createdAt, start),
          lt(managerSonnetUsage.createdAt, end),
        ),
      )
      .groupBy(managerSonnetUsage.companyId);

    let alerts = 0;
    for (const row of perCompany) {
      const totalInput = Number(row.totalInputTokens ?? 0);
      const totalOutput = Number(row.totalOutputTokens ?? 0);
      const total = totalInput + totalOutput;
      // Hourly metric
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: "manager_sonnet_usage_cron",
        action: "manager_sonnet.hourly_usage",
        entityType: "company",
        entityId: row.companyId,
        details: {
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          totalTokens: total,
          requestCount: Number(row.requestCount ?? 0),
        },
      });

      // Daily alert-check: sum siste 24t > grense -> log alert event
      const dayStart = new Date(end);
      dayStart.setHours(dayStart.getHours() - 24);
      const dayRows = await db
        .select({
          totalInput: sql<number>`COALESCE(SUM(${managerSonnetUsage.inputTokens}), 0)`,
          totalOutput: sql<number>`COALESCE(SUM(${managerSonnetUsage.outputTokens}), 0)`,
        })
        .from(managerSonnetUsage)
        .where(
          and(
            eq(managerSonnetUsage.companyId, row.companyId),
            gte(managerSonnetUsage.createdAt, dayStart),
            lt(managerSonnetUsage.createdAt, end),
          ),
        );
      const dayTotal = Number(dayRows[0]?.totalInput ?? 0) + Number(dayRows[0]?.totalOutput ?? 0);
      if (dayTotal > dailyAlertTokens) {
        alerts++;
        // Sjekk om vi allerede har sendt alert i denne timen for aa unngaa spam
        const recentAlert = await db
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, row.companyId),
              eq(activityLog.action, "manager_sonnet.daily_alert"),
              gte(activityLog.createdAt, start),
            ),
          )
          .limit(1);
        if (recentAlert.length === 0) {
          await logActivity(db, {
            companyId: row.companyId,
            actorType: "system",
            actorId: "manager_sonnet_usage_cron",
            action: "manager_sonnet.daily_alert",
            entityType: "company",
            entityId: row.companyId,
            details: {
              windowStart: dayStart.toISOString(),
              windowEnd: end.toISOString(),
              totalTokens: dayTotal,
              threshold: dailyAlertTokens,
            },
          });
        }
      }
    }

    return { companies: perCompany.length, alerts };
  }

  return { record, aggregateByAgent, hourlyAggregateAndLog };
}

export type { ManagerSonnetUsage } from "@paperclipai/db";

/** Hjelper: bygg insert-input fra adapter-result og context. */
export function buildUsageRecordFromAdapterResult(args: {
  companyId: string;
  agentId: string;
  runId: string | null;
  wakeReason: string | null;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  cachedInputTokens?: number | null;
  durationMs: number | null;
}): RecordUsageInput {
  // Vi behandler cached_input_tokens som en del av input_tokens
  // for total-cost-formaal (Sonnet billing-modell).
  const input = (args.inputTokens ?? 0) + (args.cachedInputTokens ?? 0);
  return {
    companyId: args.companyId,
    agentId: args.agentId,
    runId: args.runId,
    reason: args.wakeReason,
    inputTokens: input,
    outputTokens: args.outputTokens ?? 0,
    durationMs: args.durationMs,
  };
}

export { companies as _companies };
