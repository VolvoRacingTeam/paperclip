/**
 * Public surface for the Fikenverktøy MCP wrapper-laget (M2.1 — wrapper-
 * infrastructure). Wrapper-tools that expose individual capabilities to the
 * agent layer (M2.2+) compose the building blocks below.
 */

export {
  ACTOR_CLAIM_HEADER_NAME,
  buildActorClaimPayload,
  signActorClaim,
  resetActorClaimKeyCache,
  _internals as _actorClaimInternals,
} from "./actor-claim.js";
export type {
  ActorClaimContext,
  ActorClaimPayload,
  ActorType,
  BuildActorClaimOptions,
} from "./actor-claim.js";

export {
  ulid,
  ULID_LENGTH,
  hashPayload,
  InMemoryAgentRunStateStore,
  IdempotencyKeyConflictError,
  MissingFikenCompanySlugError,
  _resetUlidState,
} from "./idempotency.js";
export type {
  AgentRunStep,
  AgentRunStateStore,
  ResolveStepResult,
} from "./idempotency.js";

export { FikenAccessTokenFetcher } from "./token-fetch.js";
export type {
  FikenAccessCredentials,
  TokenFetchOptions,
} from "./token-fetch.js";

export { FikenMcpClient } from "./client.js";
export type {
  FikenMcpClientOptions,
  McpAuditEcho,
  McpCallContext,
  McpResultKind,
  McpToolResult,
} from "./client.js";
