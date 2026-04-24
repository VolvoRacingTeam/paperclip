/**
 * Canonical MCP tool definitions for manager-review-hook.
 *
 * Disse definisjonene konsumeres av:
 *   - packages/adapters/ollama-local (som tool-lista for manager-agenter
 *     som kjoeres paa lokal LLM)
 *   - dokumentasjon/AGENTS.md for Claude-manager-agenter (som kaller
 *     de underliggende HTTP-endepunktene direkte via curl/bash)
 *   - server/src/__tests__ for aa verifisere at serveren eksponerer
 *     de rette rutene
 *
 * De 3 tool-ene er:
 *   1. list_pending_reviews  -> GET /api/companies/:companyId/worker-reviews/pending
 *   2. decide_review         -> POST /api/worker-reviews/:id/decision
 *   3. upsert_worker_pattern -> POST /api/companies/:companyId/worker-learning-patterns
 *
 * Disse eksponeres KUN for manager-agenter (de som har >= 1 underordnet
 * worker via `reports_to`). Server-side validering skjer i tillegg:
 * hver rute sjekker `actor.agentId === row.managerAgentId` eller tilsvarende.
 */

export interface ManagerReviewToolDefinition {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
}

export const LIST_PENDING_REVIEWS_TOOL: ManagerReviewToolDefinition = {
  name: "list_pending_reviews",
  description:
    "Lists pending worker reviews assigned to the current manager agent. " +
    'Use this first when wakeSource=automation and wakeReason=manager_review_pending ' +
    'to confirm queue state and choose the review item to process. ' +
    'Queue-discovery tool, not detail-fetch. Full detail for the current review ' +
    'is already in contextSnapshot.currentReview.',
  parametersSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      include_history: { type: "boolean", default: false },
    },
  },
};

export const DECIDE_REVIEW_TOOL: ManagerReviewToolDefinition = {
  name: "decide_review",
  description:
    "Finalizes a manager decision for one review item. " +
    "approve promotes onward, reject wakes worker for another attempt, " +
    "escalate routes to higher-trust approval path. " +
    "redlined_payload is a bounded JSON Merge Patch (RFC 7396) suggestion; " +
    "use only when manager can correct a local evidence-grounded defect " +
    "without redoing the job. Do NOT send redlined_payload on approve.",
  parametersSchema: {
    type: "object",
    additionalProperties: false,
    required: ["review_id", "decision"],
    properties: {
      review_id: { type: "string", format: "uuid" },
      decision: { type: "string", enum: ["approve", "reject", "escalate"] },
      note: { type: "string", maxLength: 4000 },
      redlined_payload: { type: "object" },
      pattern_tag: {
        type: "string",
        pattern: "^[a-z0-9]+(?:_[a-z0-9]+){1,7}$",
        maxLength: 80,
      },
    },
  },
};

export const UPSERT_WORKER_PATTERN_TOOL: ManagerReviewToolDefinition = {
  name: "upsert_worker_pattern",
  description:
    "Creates or updates one durable learning pattern for a worker agent. " +
    "Call after each reject when failure is attributable to reusable worker mistake, " +
    "not one-off business ambiguity. " +
    "Upsert key (worker_agent_id, pattern_tag); repeated rejects strengthen the same pattern.",
  parametersSchema: {
    type: "object",
    additionalProperties: false,
    required: ["worker_agent_id", "pattern_tag", "pattern_description", "severity"],
    properties: {
      worker_agent_id: { type: "string", format: "uuid" },
      pattern_tag: {
        type: "string",
        pattern: "^[a-z0-9]+(?:_[a-z0-9]+){1,7}$",
        maxLength: 80,
      },
      pattern_description: { type: "string", maxLength: 1000 },
      example_correct: { type: "string", maxLength: 500 },
      example_wrong: { type: "string", maxLength: 500 },
      severity: { type: "string", enum: ["info", "warning", "critical"] },
    },
  },
};

export const MANAGER_REVIEW_TOOL_DEFINITIONS: ManagerReviewToolDefinition[] = [
  LIST_PENDING_REVIEWS_TOOL,
  DECIDE_REVIEW_TOOL,
  UPSERT_WORKER_PATTERN_TOOL,
];

export const MANAGER_REVIEW_TOOL_NAMES = new Set<string>(
  MANAGER_REVIEW_TOOL_DEFINITIONS.map((t) => t.name),
);

export function isManagerReviewTool(name: string): boolean {
  return MANAGER_REVIEW_TOOL_NAMES.has(name);
}

/**
 * TypeScript-typer for tool-kall-argumenter.
 */
export interface ListPendingReviewsInput {
  limit?: number;
  include_history?: boolean;
}

export interface PendingReviewRow {
  review_id: string;
  worker_name: string | null;
  worker_agent_id: string;
  proposed_action: string;
  rationale: string | null;
  submitted_at: string;
  attempt_count: number;
}

export type ListPendingReviewsOutput = PendingReviewRow[];

export interface DecideReviewInput {
  review_id: string;
  decision: "approve" | "reject" | "escalate";
  note?: string;
  redlined_payload?: Record<string, unknown>;
  pattern_tag?: string;
}

export interface DecideReviewOutput {
  status: "approved" | "rejected" | "escalated";
  promoted_approval_id?: string;
  retry_wakeup_id?: string;
  escalated_approval_id?: string;
}

export interface UpsertWorkerPatternToolInput {
  worker_agent_id: string;
  pattern_tag: string;
  pattern_description: string;
  example_correct?: string;
  example_wrong?: string;
  severity: "info" | "warning" | "critical";
}

export interface UpsertWorkerPatternToolOutput {
  pattern_id: string;
  created_or_updated: "created" | "updated";
}
