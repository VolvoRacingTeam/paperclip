/**
 * Parse and normalize model responses returned by the llama.cpp chat
 * completions endpoint. Even though the response is grammar-constrained,
 * we never trust the output blindly — every parse step is defensive.
 */

export interface ParsedToolCall {
  kind: "tool_call";
  reasoning: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ParsedFinalAnswer {
  kind: "final_answer";
  reasoning: string;
  content: string;
}

export interface ParseError {
  kind: "error";
  error: string;
  raw: string;
}

export type ParsedResponse = ParsedToolCall | ParsedFinalAnswer | ParseError;

function normalizeNorwegian(value: string): string {
  return value.normalize("NFC");
}

function deepNormalizeStrings(v: unknown): unknown {
  if (typeof v === "string") return normalizeNorwegian(v);
  if (Array.isArray(v)) return v.map(deepNormalizeStrings);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = deepNormalizeStrings(val);
    }
    return out;
  }
  return v;
}

/**
 * Parse a raw JSON-string response from the model into a tool call or
 * final answer. Returns an error-shaped result on any failure so the
 * caller can retry or escalate.
 */
export function parseToolResponse(raw: string): ParsedResponse {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { kind: "error", error: "empty response", raw: raw ?? "" };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "error",
      error: `JSON parse failed: ${(err as Error).message}`,
      raw,
    };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { kind: "error", error: "response is not a JSON object", raw };
  }

  const obj = data as Record<string, unknown>;
  const reasoning =
    typeof obj.reasoning === "string" ? normalizeNorwegian(obj.reasoning) : "";
  const toolCall = obj.tool_call as Record<string, unknown> | undefined;

  if (!toolCall || typeof toolCall !== "object") {
    return {
      kind: "error",
      error: "missing tool_call object",
      raw,
    };
  }

  const toolName = toolCall.tool;
  if (typeof toolName !== "string" || toolName.length === 0) {
    return {
      kind: "error",
      error: "missing or invalid tool_call.tool",
      raw,
    };
  }

  if (toolName === "final_answer") {
    const content =
      typeof toolCall.content === "string" ? toolCall.content : "";
    return {
      kind: "final_answer",
      reasoning,
      content: normalizeNorwegian(content),
    };
  }

  const args = toolCall.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      kind: "error",
      error: `tool_call.arguments missing or invalid for tool '${toolName}'`,
      raw,
    };
  }

  return {
    kind: "tool_call",
    reasoning,
    tool: toolName,
    arguments: deepNormalizeStrings(args) as Record<string, unknown>,
  };
}
