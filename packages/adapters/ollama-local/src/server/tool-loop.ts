/**
 * Tool-loop driver: runs the model in a JSON-constrained tool-calling
 * loop until it emits a `final_answer` or the iteration cap is hit.
 *
 * Unlike CLI-based adapters (pi-local, claude-local, etc.) this adapter
 * owns the conversation and dispatches tools directly — the model never
 * sees an opaque CLI agent in the middle.
 */

import type { ChatMessage, LlamaCppClient } from "./client.js";
import { parseToolResponse } from "./parse.js";
import {
  convertToolsToSchema,
  renderToolCatalog,
  type ToolDefinition,
} from "./schema.js";

export interface ToolLoopStep {
  tool: string;
  reasoning: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
}

export interface ToolLoopUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  iterations: number;
}

export interface ToolLoopResult {
  finalAnswer: string;
  steps: ToolLoopStep[];
  usage: ToolLoopUsage;
  escalated?: { reason: string; detail?: string };
}

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ToolLoopContext {
  systemPrompt?: string;
  userMessage: string;
  tools: ToolDefinition[];
  executeTool: ToolExecutor;
  maxIterations?: number;
  maxTokens?: number;
  temperature?: number;
  onLog?: (event: ToolLoopLogEvent) => void;
}

export type ToolLoopLogEvent =
  | { type: "model_call"; iteration: number; promptPreview: string }
  | { type: "model_response"; iteration: number; raw: string }
  | { type: "tool_call"; iteration: number; tool: string; args: unknown }
  | { type: "tool_result"; iteration: number; tool: string; result: unknown }
  | { type: "parse_error"; iteration: number; error: string }
  | { type: "escalation"; reason: string; detail?: string };

const DEFAULT_SYSTEM_PROMPT = [
  "Du er en AI-agent i Paperclip-systemet hos Verkvelven AS.",
  "Språk: norsk (bokmål). Du MÅ svare på norsk.",
  "",
  "REGLER:",
  "1. Svar ALLTID som et gyldig JSON-objekt som matcher skjemaet du er gitt.",
  "2. Velg nøyaktig ETT verktøy pr. svar.",
  "3. Gi en kort begrunnelse på norsk i `reasoning`-feltet før verktøyet velges.",
  "4. Norske tegn (æ, ø, å) skrives som vanlige Unicode-tegn i JSON-strenger.",
  "5. Backslashes i filstier escapes som \\ (standard JSON).",
  "6. Når oppgaven er løst, kall `final_answer` med et sammendrag i `content`.",
].join("\n");

/**
 * Run the tool-calling loop against a llama.cpp client.
 */
export async function runToolLoop(
  client: LlamaCppClient,
  ctx: ToolLoopContext,
): Promise<ToolLoopResult> {
  const maxIterations = ctx.maxIterations ?? 10;
  const maxTokens = ctx.maxTokens ?? client.defaults.maxTokens;
  const temperature = ctx.temperature ?? client.defaults.temperature;
  const toolCatalog = renderToolCatalog(ctx.tools);
  // Schema is built once so we know the shape is fixed for the loop;
  // the live endpoint only supports `response_format: json_object` at
  // the moment, but we keep the schema for future grammar injection
  // and for the retry nudges.
  void convertToolsToSchema(ctx.tools);

  const systemPrompt = [
    ctx.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    "",
    "Tilgjengelige verktøy:",
    toolCatalog,
    "",
    "Svaret ditt skal være ett JSON-objekt på formen:",
    '{"reasoning": "...", "tool_call": {"tool": "<navn>", "arguments": { ... }}}',
    "For å avslutte: {\"reasoning\": \"...\", \"tool_call\": {\"tool\": \"final_answer\", \"content\": \"sammendrag\"}}",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: ctx.userMessage },
  ];

  const steps: ToolLoopStep[] = [];
  const usage: ToolLoopUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    iterations: 0,
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    usage.iterations = iter + 1;
    ctx.onLog?.({
      type: "model_call",
      iteration: iter,
      promptPreview: messages[messages.length - 1].content.slice(0, 200),
    });

    const resp = await client.chat({
      model: client.modelName,
      messages,
      max_tokens: maxTokens,
      temperature,
      response_format: { type: "json_object" },
    });

    usage.promptTokens += resp.tokens.prompt;
    usage.completionTokens += resp.tokens.completion;
    usage.totalTokens += resp.tokens.total;

    ctx.onLog?.({
      type: "model_response",
      iteration: iter,
      raw: resp.content,
    });

    const parsed = parseToolResponse(resp.content);

    if (parsed.kind === "error") {
      ctx.onLog?.({
        type: "parse_error",
        iteration: iter,
        error: parsed.error,
      });
      messages.push({
        role: "assistant",
        content: resp.content,
      });
      messages.push({
        role: "user",
        content: `FORRIGE SVAR VAR UGYLDIG: ${parsed.error}. Svar KUN med ett gyldig JSON-objekt som matcher skjemaet.`,
      });
      continue;
    }

    if (parsed.kind === "final_answer") {
      return {
        finalAnswer: parsed.content,
        steps,
        usage,
      };
    }

    // tool_call
    ctx.onLog?.({
      type: "tool_call",
      iteration: iter,
      tool: parsed.tool,
      args: parsed.arguments,
    });

    let result: unknown;
    let isError = false;
    try {
      result = await ctx.executeTool(parsed.tool, parsed.arguments);
    } catch (err) {
      isError = true;
      result = { error: (err as Error).message };
    }

    ctx.onLog?.({
      type: "tool_result",
      iteration: iter,
      tool: parsed.tool,
      result,
    });

    steps.push({
      tool: parsed.tool,
      reasoning: parsed.reasoning,
      args: parsed.arguments,
      result,
      isError,
    });

    messages.push({ role: "assistant", content: resp.content });
    messages.push({
      role: "user",
      content: `[verktøy-resultat ${parsed.tool}]\n${JSON.stringify(result)}`,
    });
  }

  ctx.onLog?.({
    type: "escalation",
    reason: "max_iterations_reached",
    detail: `${maxIterations} iterasjoner fullført uten final_answer`,
  });

  return {
    finalAnswer: "",
    steps,
    usage,
    escalated: {
      reason: "max_iterations_reached",
      detail: `${maxIterations} iterations completed without final_answer`,
    },
  };
}
