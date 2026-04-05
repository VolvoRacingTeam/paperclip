/**
 * Convert Paperclip tool descriptors into a JSON Schema discriminated union
 * that grammar-constrained sampling in llama.cpp can enforce.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
}

/**
 * Normalize a plugin tool's JSON schema so it is safe for llama.cpp's
 * GBNF grammar converter. Removes $schema/$id, flattens to a plain
 * object type, and drops keywords that are not supported by the
 * underlying grammar engine.
 */
export function normalizeParamSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", additionalProperties: true };
  }
  if (schema.type !== "object") {
    return { type: "object", additionalProperties: true };
  }
  const cleaned: Record<string, unknown> = { ...schema };
  delete cleaned.$schema;
  delete cleaned.$id;
  delete cleaned.$ref;
  if (cleaned.additionalProperties === undefined) {
    cleaned.additionalProperties = false;
  }
  return cleaned;
}

/**
 * Build a discriminated-union JSON schema that forces the model to pick
 * exactly one tool per response. A synthetic `final_answer` tool is
 * always appended so the model can terminate the loop.
 */
export function convertToolsToSchema(
  tools: ToolDefinition[],
): Record<string, unknown> {
  const variants: Array<Record<string, unknown>> = tools.map((t) => ({
    type: "object",
    properties: {
      tool: { const: t.name, type: "string" },
      arguments: normalizeParamSchema(t.parametersSchema),
    },
    required: ["tool", "arguments"],
    additionalProperties: false,
  }));

  variants.push({
    type: "object",
    properties: {
      tool: { const: "final_answer", type: "string" },
      content: { type: "string", minLength: 1 },
    },
    required: ["tool", "content"],
    additionalProperties: false,
  });

  return {
    type: "object",
    properties: {
      reasoning: {
        type: "string",
        description:
          "Kort begrunnelse på norsk for hvorfor dette verktøyet velges.",
      },
      tool_call: { oneOf: variants },
    },
    required: ["reasoning", "tool_call"],
    additionalProperties: false,
  };
}

/**
 * Render a short plain-text tool catalog suitable for inclusion in the
 * system prompt. This helps the model pick semantically even though
 * grammar-constrained sampling already enforces structure.
 */
export function renderToolCatalog(tools: ToolDefinition[]): string {
  if (tools.length === 0) {
    return "(ingen verktøy tilgjengelig — kall `final_answer` direkte)";
  }
  const lines = tools.map(
    (t) => `- **${t.name}**: ${t.description || "(ingen beskrivelse)"}`,
  );
  lines.push(
    "- **final_answer**: Avslutt oppgaven og gi et sammendrag på norsk når du er ferdig.",
  );
  return lines.join("\n");
}
