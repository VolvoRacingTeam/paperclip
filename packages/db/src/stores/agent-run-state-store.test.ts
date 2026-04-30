import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  applyPendingMigrations,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../index.js";
import {
  AGENT_RUN_STEPS_TTL_MS,
  PostgresAgentRunStateStore,
} from "./agent-run-state-store.js";
import { agents } from "../schema/agents.js";
import { agentRunSteps } from "../schema/agent_run_steps.js";
import { agentRuntimeState } from "../schema/agent_runtime_state.js";
import { companies } from "../schema/companies.js";
import * as schema from "../schema/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping PostgresAgentRunStateStore tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbedded("PostgresAgentRunStateStore", () => {
  let tempDb: EmbeddedPostgresTestDatabase;
  let db: ReturnType<typeof createDb>;
  let testSql: ReturnType<typeof postgres>;
  let companyId: string;
  let agentId: string;
  let store: PostgresAgentRunStateStore;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-run-state-");
    await applyPendingMigrations(tempDb.connectionString);
    testSql = postgres(tempDb.connectionString, { max: 4, onnotice: () => {} });
    db = drizzle(testSql, { schema }) as ReturnType<typeof createDb>;
  }, 60_000);

  afterAll(async () => {
    await testSql?.end({ timeout: 5 }).catch(() => {});
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    // Truncate i avhengighets-rekkefolge.
    await testSql`TRUNCATE TABLE ${testSql("agent_run_steps")} CASCADE`;
    await testSql`TRUNCATE TABLE ${testSql("agent_runtime_state")} CASCADE`;
    await testSql`TRUNCATE TABLE ${testSql("agents")} CASCADE`;
    await testSql`TRUNCATE TABLE ${testSql("companies")} CASCADE`;

    // Seed minimum: en company og en agent for FK-bruk.
    const [company] = await db
      .insert(companies)
      .values({ name: "Test Co", issuePrefix: `T${Date.now() % 10000}` })
      .returning();
    companyId = company!.id;
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Test Agent", role: "general", adapterType: "ollama-local" })
      .returning();
    agentId = agent!.id;

    store = new PostgresAgentRunStateStore(db);
  });

  describe("resolveStep", () => {
    it("inserts a new row on first call (isReplay=false, isConflict=false)", async () => {
      const result = await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { foo: "bar" },
      });

      expect(result.isReplay).toBe(false);
      expect(result.isConflict).toBe(false);
      expect(result.step.idempotencyKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(result.step.payloadHash).toMatch(/^[0-9a-f]{64}$/);

      const rows = await db.select().from(agentRunSteps);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.runId).toBe("run-1");
      expect(rows[0]!.stepIndex).toBe(0);
      expect(rows[0]!.idempotencyKey).toBe(result.step.idempotencyKey);
    });

    it("returns isReplay=true on identical payload re-call", async () => {
      const first = await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { foo: "bar" },
      });
      const second = await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { foo: "bar" },
      });

      expect(second.isReplay).toBe(true);
      expect(second.isConflict).toBe(false);
      expect(second.step.idempotencyKey).toBe(first.step.idempotencyKey);
      expect(second.step.payloadHash).toBe(first.step.payloadHash);

      const rows = await db.select().from(agentRunSteps);
      expect(rows).toHaveLength(1);
    });

    it("returns isConflict=true on differing payload for same (runId, stepIndex)", async () => {
      const first = await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { foo: "bar" },
      });
      const conflict = await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { foo: "BAZ" },
      });

      expect(conflict.isReplay).toBe(false);
      expect(conflict.isConflict).toBe(true);
      // Caller skal IKKE bruke conflict.step.idempotencyKey for ny MCP-kall —
      // men step-en returneres for diagnostikk.
      expect(conflict.step.idempotencyKey).toBe(first.step.idempotencyKey);
    });

    it("treats canonical-equivalent payloads (key-order swap) as replay", async () => {
      const first = await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { a: 1, b: 2 },
      });
      const second = await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { b: 2, a: 1 },
      });

      expect(second.isReplay).toBe(true);
      expect(second.step.idempotencyKey).toBe(first.step.idempotencyKey);
    });

    it("isolates different (runId, stepIndex) — distinct keys", async () => {
      const a = await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { x: 1 },
      });
      const b = await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 1,
        payload: { x: 1 },
      });
      const c = await store.resolveStep({
        agentId,
        runId: "run-2",
        stepIndex: 0,
        payload: { x: 1 },
      });

      expect(a.step.idempotencyKey).not.toBe(b.step.idempotencyKey);
      expect(a.step.idempotencyKey).not.toBe(c.step.idempotencyKey);
      expect(b.step.idempotencyKey).not.toBe(c.step.idempotencyKey);

      const rows = await db.select().from(agentRunSteps);
      expect(rows).toHaveLength(3);
    });

    it("sets expires_at = createdAt + ttlMs", async () => {
      const customTtlStore = new PostgresAgentRunStateStore(db, {
        ttlMs: 60_000,
      });
      await customTtlStore.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { foo: "bar" },
      });
      const rows = await db.select().from(agentRunSteps);
      const row = rows[0]!;
      const delta = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(delta).toBeCloseTo(60_000, -1);
    });

    it("default TTL is 72h", async () => {
      expect(AGENT_RUN_STEPS_TTL_MS).toBe(72 * 60 * 60 * 1000);
      await store.resolveStep({
        agentId,
        runId: "run-1",
        stepIndex: 0,
        payload: { foo: "bar" },
      });
      const rows = await db.select().from(agentRunSteps);
      const row = rows[0]!;
      const delta = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(delta).toBeCloseTo(AGENT_RUN_STEPS_TTL_MS, -1);
    });

    it("concurrent resolveStep calls converge to same idempotency_key", async () => {
      const calls = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.resolveStep({
            agentId,
            runId: "run-concurrent",
            stepIndex: 0,
            payload: { same: "payload" },
          }),
        ),
      );
      const keys = new Set(calls.map((c) => c.step.idempotencyKey));
      expect(keys.size).toBe(1);
      const rows = await db.select().from(agentRunSteps);
      expect(rows).toHaveLength(1);
    });
  });

  describe("getFikenCompanySlug / setFikenCompanySlug", () => {
    it("getFikenCompanySlug returns null when no agent_runtime_state row exists", async () => {
      const slug = await store.getFikenCompanySlug(agentId);
      expect(slug).toBeNull();
    });

    it("getFikenCompanySlug returns null when state_json lacks fiken_company_slug", async () => {
      await db.insert(agentRuntimeState).values({
        agentId,
        companyId,
        adapterType: "ollama-local",
        stateJson: { other_key: "value" },
      });
      const slug = await store.getFikenCompanySlug(agentId);
      expect(slug).toBeNull();
    });

    it("setFikenCompanySlug throws on empty string", async () => {
      await expect(store.setFikenCompanySlug(agentId, "")).rejects.toThrow(
        /non-empty string/,
      );
    });

    it("setFikenCompanySlug + getFikenCompanySlug round-trip", async () => {
      // Tabellen har ikke unique constraint paa (agent_id), men CRUD-flyten
      // krever at raden seedes foer slug skrives.
      await db.insert(agentRuntimeState).values({
        agentId,
        companyId,
        adapterType: "ollama-local",
        stateJson: {},
      });

      await store.setFikenCompanySlug(agentId, "verkvelven-as");
      const slug = await store.getFikenCompanySlug(agentId);
      expect(slug).toBe("verkvelven-as");
    });

    it("setFikenCompanySlug preserves other state_json keys (jsonb_set)", async () => {
      await db.insert(agentRuntimeState).values({
        agentId,
        companyId,
        adapterType: "ollama-local",
        stateJson: {
          existing_field: "preserved",
          counter: 42,
          nested: { foo: "bar" },
        },
      });

      await store.setFikenCompanySlug(agentId, "test-slug");

      const rows = await db
        .select()
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.agentId, agentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stateJson).toEqual({
        existing_field: "preserved",
        counter: 42,
        nested: { foo: "bar" },
        fiken_company_slug: "test-slug",
      });
    });

    it("setFikenCompanySlug overwrites existing slug", async () => {
      await db.insert(agentRuntimeState).values({
        agentId,
        companyId,
        adapterType: "ollama-local",
        stateJson: { fiken_company_slug: "old-slug" },
      });

      await store.setFikenCompanySlug(agentId, "new-slug");
      const slug = await store.getFikenCompanySlug(agentId);
      expect(slug).toBe("new-slug");
    });
  });

  describe("vacuumExpired", () => {
    it("deletes rows where expires_at < now", async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await db.insert(agentRunSteps).values([
        {
          agentId,
          runId: "expired-1",
          stepIndex: 0,
          idempotencyKey: "OLD0000000000000000000000A",
          payloadHash: "a".repeat(64),
          createdAt: new Date(past.getTime() - 1000),
          expiresAt: past,
        },
        {
          agentId,
          runId: "expired-2",
          stepIndex: 0,
          idempotencyKey: "OLD0000000000000000000000B",
          payloadHash: "b".repeat(64),
          createdAt: new Date(past.getTime() - 1000),
          expiresAt: past,
        },
        {
          agentId,
          runId: "fresh-1",
          stepIndex: 0,
          idempotencyKey: "NEW0000000000000000000000A",
          payloadHash: "c".repeat(64),
          createdAt: new Date(),
          expiresAt: future,
        },
      ]);

      const deleted = await store.vacuumExpired(new Date());
      expect(deleted).toBe(2);

      const remaining = await db.select().from(agentRunSteps);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.runId).toBe("fresh-1");
    });

    it("returns 0 when nothing is expired", async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000);
      await db.insert(agentRunSteps).values({
        agentId,
        runId: "fresh",
        stepIndex: 0,
        idempotencyKey: "FRE0000000000000000000000A",
        payloadHash: "f".repeat(64),
        expiresAt: future,
      });

      const deleted = await store.vacuumExpired(new Date());
      expect(deleted).toBe(0);
    });

    it("respects the now-parameter (custom cutoff)", async () => {
      const t1 = new Date("2026-04-30T03:00:00Z");
      const t2 = new Date("2026-04-30T03:30:00Z");
      const t3 = new Date("2026-04-30T04:00:00Z");

      await db.insert(agentRunSteps).values([
        {
          agentId,
          runId: "expires-at-t1",
          stepIndex: 0,
          idempotencyKey: "T10000000000000000000000A",
          payloadHash: "1".repeat(64),
          createdAt: new Date(t1.getTime() - 1000),
          expiresAt: t1,
        },
        {
          agentId,
          runId: "expires-at-t3",
          stepIndex: 0,
          idempotencyKey: "T30000000000000000000000A",
          payloadHash: "3".repeat(64),
          createdAt: new Date(t3.getTime() - 1000),
          expiresAt: t3,
        },
      ]);

      // Cutoff = t2: bare t1-row utlopt
      const deleted = await store.vacuumExpired(t2);
      expect(deleted).toBe(1);

      const remaining = await db.select().from(agentRunSteps);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.runId).toBe("expires-at-t3");
    });
  });
});
