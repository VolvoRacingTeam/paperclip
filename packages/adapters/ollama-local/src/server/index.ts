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
