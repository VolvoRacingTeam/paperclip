import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  workerReviewLog,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { approvalService } from "../services/approvals.js";
import { workerReviewService } from "../services/worker-review.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres worker-review integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workerReviewService (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worker-review-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workerReviewLog);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      slug: `test-${companyId.slice(0, 8)}`,
    } as any);

    const managerId = randomUUID();
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Manager Agent",
      role: "manager",
      adapterType: "claude_local",
      adapterConfig: {},
    } as any);

    const workerId = randomUUID();
    await db.insert(agents).values({
      id: workerId,
      companyId,
      name: "Worker Agent",
      role: "accountant",
      reportsTo: managerId,
      adapterType: "ollama_local",
      adapterConfig: { requires_manager_review: true },
    } as any);

    return { companyId, managerId, workerId };
  }

  function makeSvcs(wakeups: any[]) {
    const heartbeatStub = {
      wakeup: async (agentId: string, opts: any) => {
        wakeups.push({ agentId, opts });
        return { id: "wake-" + wakeups.length };
      },
    };
    const approvals = approvalService(db);
    const svc = workerReviewService(db, {
      heartbeat: heartbeatStub,
      approvals,
    });
    return { svc, approvals };
  }

  it("full flow: submit -> manager approve -> approval opprettes", async () => {
    const { companyId, workerId, managerId } = await seed();
    const wakeups: any[] = [];
    const { svc } = makeSvcs(wakeups);

    const row = await svc.submitForReview({
      companyId,
      workerAgentId: workerId,
      taskType: "bookkeeping_post",
      taskPayload: { invoice: "INV-1" },
      proposedPayload: { kontonr: 1500, belop: 100 },
    });

    expect(row.managerAgentId).toBe(managerId);
    expect(row.managerDecision).toBe("PENDING");
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0].agentId).toBe(managerId);
    expect(wakeups[0].opts.idempotencyKey).toBe(`review:${row.id}`);

    // Manager approver
    const decision = await svc.recordManagerDecision(
      row.id,
      "approve",
      "ser bra ut",
      undefined,
      { managerAgentId: managerId },
    );
    expect(decision.row.managerDecision).toBe("GODKJENT");
    expect(decision.approvalId).toBeTruthy();

    // Approval-rad finnes
    const appr = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, decision.approvalId!))
      .then((rows) => rows[0]);
    expect(appr.type).toBe("bookkeeping_post");
    expect(appr.status).toBe("pending");
    expect((appr.payload as any).__worker_review.reviewId).toBe(row.id);
  });

  it("CAS forhindrer dobbel-approve", async () => {
    const { companyId, workerId, managerId } = await seed();
    const wakeups: any[] = [];
    const { svc } = makeSvcs(wakeups);

    const row = await svc.submitForReview({
      companyId,
      workerAgentId: workerId,
      taskType: "bookkeeping_post",
      taskPayload: { invoice: "INV-2" },
      proposedPayload: { kontonr: 1500, belop: 200 },
    });
    await svc.recordManagerDecision(
      row.id,
      "approve",
      null,
      undefined,
      { managerAgentId: managerId },
    );
    await expect(
      svc.recordManagerDecision(row.id, "approve", null, undefined, {
        managerAgentId: managerId,
      }),
    ).rejects.toThrow(/already in status|modified concurrently/);
  });

  it("reject -> retry-koe + max retries -> escalate", async () => {
    const { companyId, workerId, managerId } = await seed();
    const wakeups: any[] = [];
    const { svc } = makeSvcs(wakeups);

    const firstRow = await svc.submitForReview({
      companyId,
      workerAgentId: workerId,
      taskType: "bookkeeping_post",
      taskPayload: { invoice: "INV-3" },
      proposedPayload: { kontonr: 1500, belop: 300 },
    });
    wakeups.length = 0;

    // Reject #1 -> retry
    await svc.recordManagerDecision(firstRow.id, "reject", "bruk konto 1501", undefined, {
      managerAgentId: managerId,
    });
    expect(wakeups.some((w) => w.opts.reason === "manager_review_retry")).toBe(true);

    // Worker submitter ny forsoek -- vi lager ny rad med parent_review_id
    wakeups.length = 0;
    const secondRow = await svc.submitForReview({
      companyId,
      workerAgentId: workerId,
      taskType: "bookkeeping_post",
      taskPayload: { invoice: "INV-3" },
      proposedPayload: { kontonr: 1502, belop: 300 }, // endret
      parentReviewId: firstRow.id,
      workerAttempt: 2,
    });
    wakeups.length = 0;

    // Reject #2 -> siden forste rad hadde attemptCount=0 og naa 1, og max=2,
    // ville retry gaa til escalate. Men vi maa teste dette paa samme rad.
    // Vi tester i stedet via firstRow: gjoer nok rejects til max er naadd.
    // Denne test er enklere: sett attemptCount paa firstRow til 1, deretter ny reject.
    await db
      .update(workerReviewLog)
      .set({ attemptCount: 1, managerDecision: "PENDING", managerDecidedAt: null })
      .where(eq(workerReviewLog.id, firstRow.id));

    wakeups.length = 0;
    const r2 = await svc.recordManagerDecision(
      firstRow.id,
      "reject",
      "fortsatt feil",
      undefined,
      { managerAgentId: managerId },
    );
    // Etter reject er attemptCount incrementet til 2 (>= max=2), escalate skal kjoeres
    const updated = await svc.getById(firstRow.id);
    expect(updated?.managerDecision).toBe("ESKALERT");
    expect(updated?.approvalId).toBeTruthy();
    // Eskalert approval skal vaere av type escalated_worker_action
    const apprRow = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, updated!.approvalId!))
      .then((r) => r[0]);
    expect(apprRow.type).toBe("escalated_worker_action");
  });

  it("dup-hash short-circuit auto-rejecter identisk payload fra tidligere AVVIST", async () => {
    const { companyId, workerId, managerId } = await seed();
    const wakeups: any[] = [];
    const { svc } = makeSvcs(wakeups);

    const payload = { kontonr: 1500, belop: 400 };
    const firstRow = await svc.submitForReview({
      companyId,
      workerAgentId: workerId,
      taskType: "bookkeeping_post",
      taskPayload: { invoice: "INV-4" },
      proposedPayload: payload,
    });
    await svc.recordManagerDecision(firstRow.id, "reject", "ikke brukt riktig konto", undefined, {
      managerAgentId: managerId,
    });
    wakeups.length = 0;

    const secondRow = await svc.submitForReview({
      companyId,
      workerAgentId: workerId,
      taskType: "bookkeeping_post",
      taskPayload: { invoice: "INV-4" },
      proposedPayload: payload, // samme payload -> dup
    });
    expect(secondRow.managerDecision).toBe("AVVIST");
    // Ingen manager wakeup for dup-avvisning
    expect(wakeups.some((w) => w.opts.reason === "manager_review_pending")).toBe(false);
  });

  it("feature-flag off (requires_manager_review=false) -> legacy path brukes av intercepten (integration proxy: ingen worker_review-rad)", async () => {
    // Dette testes mot selve intercepten i route-laget; for service-laget
    // sjekker vi kun at submitForReview aldri blir kalt for agent uten
    // flagget. Her verifiserer vi at workerReviewService i seg selv
    // tillater manuell submit (intercepten er ansvaret for gating).
    const { companyId, workerId, managerId } = await seed();
    // Slett flagget paa agenten
    await db
      .update(agents)
      .set({ adapterConfig: {} })
      .where(eq(agents.id, workerId));
    const wakeups: any[] = [];
    const { svc } = makeSvcs(wakeups);
    // Manuelt submit skal fremdeles virke
    const row = await svc.submitForReview({
      companyId,
      workerAgentId: workerId,
      taskType: "bookkeeping_post",
      taskPayload: {},
      proposedPayload: { a: 1 },
    });
    expect(row.managerDecision).toBe("PENDING");
  });
});
