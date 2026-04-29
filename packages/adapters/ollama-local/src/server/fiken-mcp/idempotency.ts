/**
 * Idempotency-key generation + agent_run_state-persistering for Fikenverktøy
 * MCP wrapper-laget.
 *
 * Per spec § 2 (paperclip-tier-b-mcp-wireup-spec.md):
 *   - idempotency_key = ulid() — 26-char Crockford Base32, sortable
 *   - persisted at agent_run_state.steps[runId][stepIndex].idempotency_key
 *   - replay-safe: same (runId, stepIndex) returns the same key
 *   - 409 idempotency_key_conflict from MCP → escalate to Quality Control
 *
 * The store interface is abstract so unit tests can use the in-memory backing
 * while the production runtime wires a Drizzle-backed implementation against
 * agent_runtime_state.state_json.
 */

import { randomBytes } from "node:crypto";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32
const ULID_TIMESTAMP_LENGTH = 10;
const ULID_RANDOMNESS_LENGTH = 16;
export const ULID_LENGTH = ULID_TIMESTAMP_LENGTH + ULID_RANDOMNESS_LENGTH;

let lastUlidTimestamp = -1;
let lastUlidRandomness: number[] | null = null;

/**
 * Generate a 26-char ULID. Monotonic within the same millisecond by
 * incrementing the prior randomness (per ULID spec). Cryptographically random
 * for the randomness component (80 bits).
 */
export function ulid(now: number = Date.now()): string {
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
  // 16 chars × 5 bits = 80 bits of randomness (ULID spec).
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
  // Overflow within same ms → fall back to fresh randomness (rare).
  return freshRandomness();
}

/** Reset internal monotonic state — tests only. */
export function _resetUlidState(): void {
  lastUlidTimestamp = -1;
  lastUlidRandomness = null;
}

/**
 * Stable canonical hash of a payload — used as the lookup key inside a
 * (runId, stepIndex) entry to detect "same step, same payload" replays vs.
 * "same step, different payload" conflicts.
 */
export function hashPayload(payload: unknown): string {
  // Lazy import so consumers that don't need hashing don't pay startup cost.
  const { createHash } = require("node:crypto");
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

// ---------------------------------------------------------------------------
// AgentRunStateStore — abstract persistence boundary
// ---------------------------------------------------------------------------

export interface AgentRunStep {
  idempotencyKey: string;
  payloadHash: string;
  createdAt: string;
}

export interface ResolveStepResult {
  step: AgentRunStep;
  /** True if the step already existed with the same payload hash → replay path. */
  isReplay: boolean;
  /** True if the step existed with a *different* payload hash → conflict. Caller MUST escalate. */
  isConflict: boolean;
}

export interface AgentRunStateStore {
  /**
   * Look up (runId, stepIndex). If absent, generate a new ULID, persist it,
   * and return { isReplay: false }. If present with matching payloadHash,
   * return existing step + { isReplay: true }. If present with different
   * payloadHash, return existing step + { isConflict: true } — caller must
   * NOT call MCP and must escalate to Quality Control.
   */
  resolveStep(params: {
    agentId: string;
    runId: string;
    stepIndex: number;
    payload: unknown;
    now?: () => number;
  }): Promise<ResolveStepResult>;

  /** Read fiken_company_slug from agent_runtime_state.state_json. */
  getFikenCompanySlug(agentId: string): Promise<string | null>;

  /** Optional: overwrite fiken_company_slug (used when task dispatcher binds it). */
  setFikenCompanySlug?(agentId: string, slug: string): Promise<void>;
}

/**
 * In-memory store — used by unit tests and as a reference implementation.
 * Production wires a Drizzle-backed store against agent_runtime_state.
 */
export class InMemoryAgentRunStateStore implements AgentRunStateStore {
  private steps = new Map<string, AgentRunStep>();
  private slugs = new Map<string, string>();

  async resolveStep(params: {
    agentId: string;
    runId: string;
    stepIndex: number;
    payload: unknown;
    now?: () => number;
  }): Promise<ResolveStepResult> {
    const key = `${params.runId}::${params.stepIndex}`;
    const payloadHash = hashPayload(params.payload);
    const existing = this.steps.get(key);
    if (existing) {
      if (existing.payloadHash === payloadHash) {
        return { step: existing, isReplay: true, isConflict: false };
      }
      return { step: existing, isReplay: false, isConflict: true };
    }
    const nowFn = params.now ?? Date.now;
    const step: AgentRunStep = {
      idempotencyKey: ulid(nowFn()),
      payloadHash,
      createdAt: new Date(nowFn()).toISOString(),
    };
    this.steps.set(key, step);
    return { step, isReplay: false, isConflict: false };
  }

  async getFikenCompanySlug(agentId: string): Promise<string | null> {
    return this.slugs.get(agentId) ?? null;
  }

  async setFikenCompanySlug(agentId: string, slug: string): Promise<void> {
    this.slugs.set(agentId, slug);
  }

  /** Test helper. */
  _seedStep(runId: string, stepIndex: number, step: AgentRunStep): void {
    this.steps.set(`${runId}::${stepIndex}`, step);
  }

  /** Test helper. */
  _clear(): void {
    this.steps.clear();
    this.slugs.clear();
  }
}

/** Thrown when MCP returns a 409 idempotency_key_conflict — escalate to Quality Control. */
export class IdempotencyKeyConflictError extends Error {
  constructor(
    message: string,
    public readonly idempotencyKey: string,
    public readonly runId: string,
    public readonly stepIndex: number,
  ) {
    super(message);
    this.name = "IdempotencyKeyConflictError";
  }
}

/** Thrown when fiken_company_slug is missing from agent_runtime_state.state_json. */
export class MissingFikenCompanySlugError extends Error {
  constructor(public readonly agentId: string) {
    super(`agent_runtime_state.state_json is missing fiken_company_slug for agent ${agentId}`);
    this.name = "MissingFikenCompanySlugError";
  }
}
