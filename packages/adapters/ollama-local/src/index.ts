/**
 * @paperclipai/adapter-ollama-local
 *
 * Paperclip runtime adapter that drives a local llama.cpp server via the
 * OpenAI-compatible `/v1/chat/completions` endpoint, using
 * grammar-constrained JSON output (`response_format: json_object`) to
 * implement structured tool-calling. Bypasses Ollama's broken Gemma
 * tool-parser (issue #15315) by owning the JSON parse loop directly.
 *
 * Endpoint (default): http://192.168.68.82:11435/v1
 * Model (default):    gemma4-26b  (Gemma 4 26B-A4B Q3_K_M)
 */

export const type = "ollama_local";
export const label = "Ollama / llama.cpp (local)";

export const capabilities = [
  "tool-calling",
  "structured-output",
  "norsk",
] as const;

export const models: Array<{ id: string; label: string }> = [
  { id: "gemma4-26b", label: "Gemma 4 26B-A4B (llama.cpp Q3_K_M)" },
];

/**
 * JSON-Schema skeleton describing what goes in the agent's
 * `runtime_config` JSONB column. Consumers of this adapter should
 * validate their config against this shape.
 */
export const runtimeConfigSchema = {
  type: "object",
  properties: {
    ai_backend: {
      type: "string",
      const: "ollama_local",
      description: "Adapter discriminator.",
    },
    model_name: {
      type: "string",
      description:
        "Model alias exposed by the llama.cpp server (e.g. gemma4-26b).",
    },
    base_url: {
      type: "string",
      description:
        "Full URL to the OpenAI-compatible root, e.g. http://192.168.68.82:11435/v1",
    },
    max_tokens: { type: "integer", minimum: 1, maximum: 32768 },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    timeout_ms: { type: "integer", minimum: 1000 },
    max_iterations: { type: "integer", minimum: 1, maximum: 50 },
    api_key: {
      type: "string",
      description: "Optional bearer token (unused on current endpoint).",
    },
  },
  required: ["ai_backend"],
  additionalProperties: false,
} as const;

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to drive a local llama.cpp server directly (no CLI spawn)
- You need grammar-constrained JSON tool-calling on norsk input
- You want to run Gemma / Qwen / Llama models locally without the Ollama
  tool-parser bug (#15315) biting on norske tegn, apostrofer eller paths

Don't use when:
- You need a model with native function-calling (use openai_local or a CLI adapter)
- Grammar-constrained output is too slow for your latency budget
- The llama.cpp endpoint is unreachable (no fallback inside the adapter)

Core fields (runtime_config JSONB):
- ai_backend (string, required): must be "ollama_local"
- model_name (string, required): model alias exposed by llama.cpp, e.g. "gemma4-26b"
- base_url (string, required): e.g. "http://192.168.68.82:11435/v1"
- max_tokens (integer, optional): default 2048
- temperature (number, optional): default 0.3
- timeout_ms (integer, optional): default 120000
- max_iterations (integer, optional): default 10 (hard stop on tool loop)
- api_key (string, optional): bearer token, unused on current endpoint

Notes:
- The adapter owns the tool loop. It calls PluginToolDispatcher.executeTool
  directly instead of relying on a CLI agent to self-dispatch.
- Every model response is JSON.parse'd and NFC-normalized; malformed
  responses trigger an automatic retry with an explicit nudge.
- The synthetic final_answer tool is injected into the schema and is
  how the model terminates the loop.
`;
