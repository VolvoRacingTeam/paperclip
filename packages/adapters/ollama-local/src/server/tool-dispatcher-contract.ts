/**
 * Minimal structural interface that the ollama-local adapter needs from
 * Paperclip's PluginToolDispatcher. Defined here (inside the adapter
 * package) to avoid a circular dependency on server/src.
 *
 * The real dispatcher in server/src/services/plugin-tool-dispatcher.ts
 * structurally satisfies this interface — TypeScript will catch any
 * drift at the registration site in server/src/adapters/registry.ts.
 *
 * See ADR-001 (_bmad-output/adr-001-llm-adapter-di-2026-04-06.md).
 */

export interface ToolDescriptorLike {
  /** Fully namespaced tool name, e.g. `"acme.linear:search-issues"`. */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description explaining when and how to use the tool. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: Record<string, unknown>;
  /** The plugin that provides this tool. */
  pluginId: string;
}

export interface ToolListFilterLike {
  pluginId?: string;
}

export interface ToolRunContextLike {
  agentId: string;
  runId: string;
  companyId: string;
  projectId: string;
}

export interface ToolResultLike {
  content?: string;
  data?: unknown;
  error?: string;
}

export interface ToolExecutionResultLike {
  pluginId: string;
  toolName: string;
  result: ToolResultLike;
}

/**
 * Structural subset of `PluginToolDispatcher` that the adapter needs.
 *
 * The server's real dispatcher has more methods (initialize, teardown,
 * registerPluginTools, etc.) — we only list what the adapter calls.
 */
export interface PluginToolDispatcherLike {
  listToolsForAgent(filter?: ToolListFilterLike): ToolDescriptorLike[];
  executeTool(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContextLike,
  ): Promise<ToolExecutionResultLike>;
}
