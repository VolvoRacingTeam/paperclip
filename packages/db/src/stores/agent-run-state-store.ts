/**
 * PostgresAgentRunStateStore — DB-backed implementering av interfacet
 * AgentRunStateStore (definert i @paperclipai/adapter-ollama-local).
 * Persisterer idempotency-state i tabellen agent_run_steps og leser/skriver
 * fiken_company_slug i agent_runtime_state.state_json via jsonb_set.
 *
 * Bygd som forberedelse for M2.4 (destructive writes) — uten DB-backing
 * mister vi correlation-context ved container-restart mellom
 * pending_approval og approve()-callback.
 *
 * Strukturelt typesikker mot adapter-ollama-local sin AgentRunStateStore —
 * vi unngaar runtime-dep paa adapteren ved aa duplikere ulid() + hashPayload()
 * algoritmene her. ULID-formatet (Crockford Base32, 26 chars) er en stabil
 * spec som ikke endrer seg.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentRuntimeState } from "../schema/agent_runtime_state.js";
import { agentRunSteps } from "../schema/agent_run_steps.js";
import * as schema from "../schema/index.js";

type Db = PostgresJsDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Public types — strukturelt kompatible med
// @paperclipai/adapter-ollama-local/server (idempotency.ts).
// ---------------------------------------------------------------------------

export interface AgentRunStep {
  idempotencyKey: string;
  payloadHash: string;
  createdAt: string;
}

export interface ResolveStepResult {
  step: AgentRunStep;
  isReplay: boolean;
  isConflict: boolean;
}

export interface AgentRunStateStore {
  resolveStep(params: {
    agentId: string;
    runId: string;
    stepIndex: number;
    payload: unknown;
    now?: () => number;
  }): Promise<ResolveStepResult>;
  getFikenCompanySlug(agentId: string): Promise<string | null>;
  setFikenCompanySlug?(agentId: string, slug: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Konfigurasjon
// ---------------------------------------------------------------------------

/** TTL for idempotency-rader i agent_run_steps. Godkjent 72t. */
export const AGENT_RUN_STEPS_TTL_MS = 72 * 60 * 60 * 1000;

export interface PostgresAgentRunStateStoreOptions {
  ttlMs?: number;
}

// ---------------------------------------------------------------------------
// PostgresAgentRunStateStore
// ---------------------------------------------------------------------------

export class PostgresAgentRunStateStore implements AgentRunStateStore {
  private readonly ttlMs: number;

  constructor(
    private readonly db: Db,
    options: PostgresAgentRunStateStoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? AGENT_RUN_STEPS_TTL_MS;
  }

  /**
   * Idempotent step-resolution. Atomisk: insert ny rad hvis ingen finnes for
   * (agent_id, run_id, step_index), ellers les eksisterende. Replay = samme
   * payload-hash; conflict = ulik payload-hash.
   *
   * Bruker INSERT ... ON CONFLICT DO NOTHING + RETURNING for race-safety.
   * Hvis INSERT returnerer 0 rader (annen tx vant), leses vinner-raden.
   */
  async resolveStep(params: {
    agentId: string;
    runId: string;
    stepIndex: number;
    payload: unknown;
    now?: () => number;
  }): Promise<ResolveStepResult> {
    const nowFn = params.now ?? Date.now;
    const nowMs = nowFn();
    const newKey = ulid(nowMs);
    const newHash = hashPayload(params.payload);
    const expiresAt = new Date(nowMs + this.ttlMs);
    const createdAt = new Date(nowMs);

    const inserted = await this.db
      .insert(agentRunSteps)
      .values({
        agentId: params.agentId,
        runId: params.runId,
        stepIndex: params.stepIndex,
        idempotencyKey: newKey,
        payloadHash: newHash,
        createdAt,
        expiresAt,
      })
      .onConflictDoNothing({
        target: [
          agentRunSteps.agentId,
          agentRunSteps.runId,
          agentRunSteps.stepIndex,
        ],
      })
      .returning();

    if (inserted.length === 1) {
      const row = inserted[0]!;
      return {
        step: {
          idempotencyKey: row.idempotencyKey,
          payloadHash: row.payloadHash,
          createdAt: row.createdAt.toISOString(),
        },
        isReplay: false,
        isConflict: false,
      };
    }

    const existing = await this.db
      .select()
      .from(agentRunSteps)
      .where(
        and(
          eq(agentRunSteps.agentId, params.agentId),
          eq(agentRunSteps.runId, params.runId),
          eq(agentRunSteps.stepIndex, params.stepIndex),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      // Race-vindu: insert returnerte 0 rader, men SELECT finner ingenting.
      // Krever at en annen tx slettet raden mellom INSERT og SELECT (uvanlig).
      return this.resolveStep(params);
    }

    const row = existing[0]!;
    const isReplay = row.payloadHash === newHash;
    return {
      step: {
        idempotencyKey: row.idempotencyKey,
        payloadHash: row.payloadHash,
        createdAt: row.createdAt.toISOString(),
      },
      isReplay,
      isConflict: !isReplay,
    };
  }

  /**
   * Les fiken_company_slug fra agent_runtime_state.state_json.
   * Returnerer null hvis raden ikke finnes eller feltet mangler.
   */
  async getFikenCompanySlug(agentId: string): Promise<string | null> {
    const rows = await this.db
      .select({
        slug: sql<string | null>`(${agentRuntimeState.stateJson} ->> 'fiken_company_slug')`,
      })
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .limit(1);

    if (rows.length === 0) return null;
    const slug = rows[0]!.slug;
    return typeof slug === "string" && slug.length > 0 ? slug : null;
  }

  /**
   * Skriv fiken_company_slug til agent_runtime_state.state_json via jsonb_set
   * — bevarer alle andre keys i state_json. UPDATE WHERE agent_id sikrer at
   * vi ikke rorer andre agents.
   */
  async setFikenCompanySlug(agentId: string, slug: string): Promise<void> {
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error("setFikenCompanySlug: slug must be a non-empty string");
    }
    await this.db
      .update(agentRuntimeState)
      .set({
        stateJson: sql`jsonb_set(${agentRuntimeState.stateJson}, '{fiken_company_slug}', to_jsonb(${slug}::text), true)`,
        updatedAt: sql`now()`,
      })
      .where(eq(agentRuntimeState.agentId, agentId));
  }

  /**
   * Vacuum: slett utlopte rader. Returnerer antall rader fjernet.
   * Forventes kjort daglig 03:00 UTC av cron-tick.
   */
  async vacuumExpired(now: Date = new Date()): Promise<number> {
    const result = await this.db
      .delete(agentRunSteps)
      .where(lt(agentRunSteps.expiresAt, now))
      .returning({ agentId: agentRunSteps.agentId });
    return result.length;
  }
}

// ---------------------------------------------------------------------------
// ULID + hashPayload — duplikat av algoritmer fra
// adapter-ollama-local/server/fiken-mcp/idempotency.ts. Stabil ULID-spec
// (Crockford Base32, 26 chars). Endring av algoritme ville bryte
// idempotency-key-format paa tvers av in-memory og postgres-impl.
// ---------------------------------------------------------------------------

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIMESTAMP_LENGTH = 10;
const ULID_RANDOMNESS_LENGTH = 16;

let lastUlidTimestamp = -1;
let lastUlidRandomness: number[] | null = null;

function ulid(now: number = Date.now()): string {
  if (!Number.isFinite(now) || now < 0) {
    throw new Error(`ulid: invalid timestamp ${now}`);
  }
  const timestampPart = encodeTimestamp(now);

  let randomnessChars: number[];
  if (now === lastUlidTimestamp && lastUlidRandomness !== null) {
    randomnessChars = incrementRandomness([...lastUlidRandomness]);
  } else {
    randomnessChars = freshRandomness();
  }
  lastUlidTimestamp = now;
  lastUlidRandomness = randomnessChars;

  return timestampPart + randomnessChars.map((i) => ULID_ALPHABET[i]).join("");
}

function encodeTimestamp(now: number): string {
  let value = Math.floor(now);
  const out: string[] = [];
  for (let i = ULID_TIMESTAMP_LENGTH - 1; i >= 0; i--) {
    const idx = value % 32;
    out[i] = ULID_ALPHABET[idx]!;
    value = Math.floor(value / 32);
  }
  return out.join("");
}

function freshRandomness(): number[] {
  const bytes = randomBytes(10);
  const chars: number[] = [];
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  for (let i = ULID_RANDOMNESS_LENGTH - 1; i >= 0; i--) {
    chars[i] = Number(acc & 31n);
    acc >>= 5n;
  }
  return chars;
}

function incrementRandomness(chars: number[]): number[] {
  for (let i = ULID_RANDOMNESS_LENGTH - 1; i >= 0; i--) {
    if (chars[i]! < 31) {
      chars[i]! += 1;
      return chars;
    }
    chars[i] = 0;
  }
  return freshRandomness();
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value !== "object") return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
