export {
  LlamaCppClient,
  type LlamaCppClientOptions,
  type ChatMessage,
  type ChatCompletionRequest,
  type ChatCompletionResult,
} from "./client.js";
export {
  convertToolsToSchema,
  normalizeParamSchema,
  renderToolCatalog,
  type ToolDefinition,
} from "./schema.js";
export {
  parseToolResponse,
  type ParsedResponse,
  type ParsedToolCall,
  type ParsedFinalAnswer,
  type ParseError,
} from "./parse.js";
export {
  runToolLoop,
  type ToolLoopContext,
  type ToolLoopResult,
  type ToolLoopStep,
  type ToolLoopUsage,
  type ToolLoopLogEvent,
  type ToolExecutor,
} from "./tool-loop.js";
export {
  executeOllamaLocal,
  buildLlamaCppClient,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  type ExecuteOllamaLocalOptions,
  type OllamaLocalRuntimeConfig,
} from "./execute.js";

// ---------------------------------------------------------------------------
// Paperclip-facing factory (see ADR-001)
// ---------------------------------------------------------------------------

export {
  createOllamaLocalServerAdapter,
  executeAdapter,
  testEnvironment,
  type CreateOllamaLocalServerAdapterOptions,
} from "./adapter.js";

export type {
  PluginToolDispatcherLike,
  ToolDescriptorLike,
  ToolListFilterLike,
  ToolRunContextLike,
  ToolResultLike,
  ToolExecutionResultLike,
} from "./tool-dispatcher-contract.js";

// ---------------------------------------------------------------------------
// Kundeoversikt built-in tools (email pipeline)
// ---------------------------------------------------------------------------

export {
  KUNDEOVERSIKT_TOOL_DEFINITIONS,
  executeKundeoversiktTool,
  isKundeoversiktTool,
} from "./kundeoversikt-tools.js";
export {
  parseRateLimitHeaders,
  computeBackoffMs,
  backoffFor429,
  type RateLimitState,
} from "./rate-limit-client.js";
export {
  generateIdempotencyKey,
  getOrCreateIdempotencyKey,
  pruneExpiredKeys,
} from "./idempotency.js";

// ---------------------------------------------------------------------------
// Fiken built-in tools (bookkeeping automation)
// ---------------------------------------------------------------------------

export {
  FIKEN_TOOL_DEFINITIONS,
  executeFikenTool,
  isFikenTool,
} from "./fiken-tools.js";

// ---------------------------------------------------------------------------
// Fikenverktoy MCP wrapper-laget (M2.1+) bootstrap + types
// ---------------------------------------------------------------------------

export {
  getOrInitFikenMcpClient,
  registerProductionAgentRunStateStore,
  _resetFikenMcpClientForTest,
} from "./fiken-mcp-bootstrap.js";
export type { AgentRunStateStore } from "./fiken-mcp/index.js";
