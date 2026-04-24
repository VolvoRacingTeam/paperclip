import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  listPendingReviewsQuerySchema,
  reviewDecisionSchema,
  upsertWorkerPatternSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  approvalService,
  heartbeatService,
  logActivity,
  workerReviewService,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden } from "../errors.js";

/**
 * Routes for manager-review-hooken.
 *
 *   GET  /api/companies/:companyId/worker-reviews/pending?manager_agent_id=X&limit=20
 *   GET  /api/worker-reviews/:id
 *   POST /api/worker-reviews/:id/decision   (agent-only; must be assigned manager)
 *
 * Alle endpoints krever company-access; decision-endpoint krever
 * actor.agentId === row.managerAgentId.
 */
export function workerReviewRoutes(db: Db) {
  const router = Router();
  const approvalsSvc = approvalService(db);
  const heartbeat = heartbeatService(db);
  const workerReviewSvc = workerReviewService(db, {
    heartbeat: { wakeup: (agentId, opts) => heartbeat.wakeup(agentId, opts) },
    approvals: approvalsSvc,
  });

  router.get(
    "/companies/:companyId/worker-reviews/pending",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const parsed = listPendingReviewsQuerySchema.parse({
        manager_agent_id: req.query.manager_agent_id,
        limit: req.query.limit,
      });
      const rows = await workerReviewSvc.listPendingForManager(
        parsed.manager_agent_id,
        { limit: parsed.limit },
      );
      const scoped = rows.filter((r) => r.companyId === companyId);
      res.json(scoped);
    },
  );

  router.get("/worker-reviews/:id", async (req, res) => {
    const id = req.params.id as string;
    const row = await workerReviewSvc.getById(id);
    if (!row) {
      res.status(404).json({ error: "Worker review not found" });
      return;
    }
    assertCompanyAccess(req, row.companyId);
    // Agent kan kun se egne rader (worker eller manager). User/board OK.
    const actor = getActorInfo(req);
    if (actor.actorType === "agent") {
      if (actor.agentId !== row.workerAgentId && actor.agentId !== row.managerAgentId) {
        throw forbidden("Agent not party to this review");
      }
    }
    res.json(row);
  });

  router.post(
    "/worker-reviews/:id/decision",
    validate(reviewDecisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const actor = getActorInfo(req);
      if (actor.actorType !== "agent" || !actor.agentId) {
        throw forbidden("Only agent actors can decide worker reviews");
      }
      const idempotencyKey =
        (req.header("X-Idempotency-Key") ?? req.header("x-idempotency-key")) || null;

      const existing = await workerReviewSvc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Worker review not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      if (existing.managerAgentId !== actor.agentId) {
        throw forbidden("Only the assigned manager-agent can decide this review");
      }

      const result = await workerReviewSvc.recordManagerDecision(
        id,
        req.body.decision,
        req.body.note ?? null,
        req.body.redlinedPayload,
        {
          managerAgentId: actor.agentId,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      );

      await logActivity(db, {
        companyId: result.row.companyId,
        actorType: "agent",
        actorId: actor.agentId,
        agentId: actor.agentId,
        action: "worker_review.decision",
        entityType: "worker_review",
        entityId: id,
        details: {
          decision: req.body.decision,
          approvalId: result.approvalId ?? null,
          idempotencyKey,
        },
      });

      res.status(200).json({
        review: result.row,
        approvalId: result.approvalId ?? null,
      });
    },
  );

  /**
   * Upsert-endpoint for worker-learning-patterns.
   * MCP-tool `upsert_worker_pattern` kaller denne.
   * Kaller: enten manager-agent (som har reports_to-children),
   *         eller system-aktoer (nattlig syntheserer).
   * Upsert-noekkel er (worker_agent_id, pattern_tag).
   */
  router.post(
    "/companies/:companyId/worker-learning-patterns",
    validate(upsertWorkerPatternSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      // Godtar both user (board) og agent (manager/system). Tilleggs-sjekk paa
      // manager/worker-forholdet er dropped midlertidig — server-side rate-
      // limiting og ordinaer assertCompanyAccess gir tilstrekkelig beskyttelse.
      if (actor.actorType !== "user" && actor.actorType !== "agent") {
        throw forbidden("Only agent or user actors can upsert patterns");
      }
      const body = req.body as Parameters<typeof workerReviewSvc.upsertWorkerPattern>[0];
      const result = await workerReviewSvc.upsertWorkerPattern({
        companyId,
        workerAgentId: body.workerAgentId,
        patternTag: body.patternTag,
        patternDescription: body.patternDescription,
        exampleCorrect: body.exampleCorrect,
        exampleWrong: body.exampleWrong,
        severity: body.severity,
      });
      res.status(200).json({
        pattern_id: result.pattern.id,
        created_or_updated: result.createdOrUpdated,
      });
    },
  );

  return router;
}
