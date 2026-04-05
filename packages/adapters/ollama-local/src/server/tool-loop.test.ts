import { describe, expect, it } from "vitest";
import { parseToolResponse } from "./parse.js";
import {
  convertToolsToSchema,
  normalizeParamSchema,
  renderToolCatalog,
  type ToolDefinition,
} from "./schema.js";
import { runToolLoop } from "./tool-loop.js";
import type { ChatCompletionRequest, LlamaCppClient } from "./client.js";

/**
 * Minimal stub of LlamaCppClient that returns scripted responses. This
 * lets us exercise the tool-loop without hitting the live endpoint.
 */
function makeStubClient(
  scripted: string[],
): LlamaCppClient {
  let i = 0;
  const stub = {
    modelName: "stub-model",
    defaults: { maxTokens: 512, temperature: 0 },
    async chat(_req: ChatCompletionRequest) {
      const content = scripted[i++] ?? scripted[scripted.length - 1];
      return {
        content,
        finish_reason: "stop",
        tokens: { prompt: 10, completion: 5, total: 15 },
      };
    },
    async health() {
      return true;
    },
  };
  return stub as unknown as LlamaCppClient;
}

describe("parseToolResponse", () => {
  it("parses a valid tool call with norsk arguments", () => {
    const raw = JSON.stringify({
      reasoning: "Må lagre kundens navn i Kåre's register",
      tool_call: {
        tool: "customer.create",
        arguments: { name: "Kåre Åse Ørn", org: "Rør & VVS" },
      },
    });
    const parsed = parseToolResponse(raw);
    expect(parsed.kind).toBe("tool_call");
    if (parsed.kind === "tool_call") {
      expect(parsed.tool).toBe("customer.create");
      expect(parsed.arguments.name).toBe("Kåre Åse Ørn");
      expect(parsed.arguments.org).toBe("Rør & VVS");
    }
  });

  it("parses a final_answer response", () => {
    const raw = JSON.stringify({
      reasoning: "Ferdig",
      tool_call: { tool: "final_answer", content: "Oppgaven er løst." },
    });
    const parsed = parseToolResponse(raw);
    expect(parsed.kind).toBe("final_answer");
    if (parsed.kind === "final_answer") {
      expect(parsed.content).toBe("Oppgaven er løst.");
    }
  });

  it("returns an error for broken JSON", () => {
    const parsed = parseToolResponse("{not json");
    expect(parsed.kind).toBe("error");
  });

  it("returns an error when tool_call is missing", () => {
    const parsed = parseToolResponse(
      JSON.stringify({ reasoning: "noe" }),
    );
    expect(parsed.kind).toBe("error");
  });
});

describe("convertToolsToSchema", () => {
  it("builds a discriminated union with final_answer appended", () => {
    const tools: ToolDefinition[] = [
      {
        name: "email.send_draft",
        description: "Send a draft e-mail",
        parametersSchema: {
          type: "object",
          properties: { to: { type: "string" } },
          required: ["to"],
        },
      },
    ];
    const schema = convertToolsToSchema(tools) as {
      properties: {
        tool_call: { oneOf: Array<{ properties: { tool: { const: string } } }> };
      };
    };
    const variants = schema.properties.tool_call.oneOf;
    expect(variants).toHaveLength(2);
    expect(variants[0].properties.tool.const).toBe("email.send_draft");
    expect(variants[1].properties.tool.const).toBe("final_answer");
  });

  it("handles tools with empty parameter schema", () => {
    const tools: ToolDefinition[] = [
      { name: "noop", description: "no-op", parametersSchema: {} },
    ];
    expect(() => convertToolsToSchema(tools)).not.toThrow();
  });
});

describe("normalizeParamSchema", () => {
  it("strips $schema, $id, $ref", () => {
    const cleaned = normalizeParamSchema({
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "foo",
      $ref: "#/defs/bar",
      properties: { x: { type: "string" } },
    });
    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.$id).toBeUndefined();
    expect(cleaned.$ref).toBeUndefined();
    expect(cleaned.type).toBe("object");
  });

  it("falls back for non-object schemas", () => {
    const cleaned = normalizeParamSchema({ type: "string" });
    expect(cleaned.type).toBe("object");
    expect(cleaned.additionalProperties).toBe(true);
  });
});

describe("renderToolCatalog", () => {
  it("renders a markdown list including final_answer", () => {
    const out = renderToolCatalog([
      { name: "a", description: "first", parametersSchema: {} },
    ]);
    expect(out).toContain("- **a**");
    expect(out).toContain("final_answer");
  });
});

describe("runToolLoop", () => {
  it("dispatches one tool and terminates on final_answer", async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    const client = makeStubClient([
      JSON.stringify({
        reasoning: "Hent kundedata først",
        tool_call: {
          tool: "customer.get",
          arguments: { id: "k-001" },
        },
      }),
      JSON.stringify({
        reasoning: "Ferdig",
        tool_call: {
          tool: "final_answer",
          content: "Kunden heter Kåre Åse Ørn og saldoen er 1 234 kr.",
        },
      }),
    ]);

    const result = await runToolLoop(client, {
      userMessage: "Hvem er kunde k-001 og hva er saldoen?",
      tools: [
        {
          name: "customer.get",
          description: "Fetch customer",
          parametersSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ],
      executeTool: async (name, args) => {
        calls.push({ tool: name, args });
        return { id: "k-001", name: "Kåre Åse Ørn", balance: 1234 };
      },
      maxIterations: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("customer.get");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].result).toMatchObject({ name: "Kåre Åse Ørn" });
    expect(result.finalAnswer).toContain("Kåre Åse Ørn");
    expect(result.escalated).toBeUndefined();
    expect(result.usage.iterations).toBe(2);
  });

  it("retries on parse error and escalates after max iterations", async () => {
    const client = makeStubClient([
      "{ broken",
      "{ still broken",
      "{ still broken",
    ]);

    const result = await runToolLoop(client, {
      userMessage: "test",
      tools: [],
      executeTool: async () => null,
      maxIterations: 3,
    });

    expect(result.escalated?.reason).toBe("max_iterations_reached");
  });
});
