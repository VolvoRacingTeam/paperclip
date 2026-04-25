/**
 * OpenAI-compatible HTTP client for llama.cpp server.
 *
 * Targets the llama.cpp server-cuda `/v1/chat/completions` endpoint with
 * support for grammar-constrained JSON output via `response_format`.
 */

export interface LlamaCppClientOptions {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  apiKey?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
  response_format?: { type: "json_object" | "text" };
  reasoning_effort?: "none" | "low" | "medium" | "high";
}

export interface ChatCompletionResult {
  content: string;
  reasoning_content?: string;
  finish_reason: string;
  tokens: { prompt: number; completion: number; total: number };
  timings?: { prompt_per_second: number; predicted_per_second: number };
}

interface OpenAIChoice {
  index?: number;
  finish_reason?: string;
  message?: {
    role?: string;
    content?: string;
    reasoning_content?: string;
  };
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  timings?: {
    prompt_per_second?: number;
    predicted_per_second?: number;
  };
}

export class LlamaCppClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;

  constructor(opts: LlamaCppClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.defaultMaxTokens = opts.maxTokens ?? 2048;
    this.defaultTemperature = opts.temperature ?? 0.3;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.apiKey = opts.apiKey;
  }

  get modelName(): string {
    return this.model;
  }

  get defaults(): { maxTokens: number; temperature: number } {
    return {
      maxTokens: this.defaultMaxTokens,
      temperature: this.defaultTemperature,
    };
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.apiKey) {
        headers["authorization"] = `Bearer ${this.apiKey}`;
      }
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `llama.cpp HTTP ${res.status}: ${text || res.statusText}`,
        );
      }
      const body = (await res.json()) as OpenAIResponse;
      const choice = body.choices?.[0];
      if (!choice || !choice.message) {
        throw new Error("llama.cpp response missing choices[0].message");
      }
      return {
        content: choice.message.content ?? "",
        reasoning_content: choice.message.reasoning_content,
        finish_reason: choice.finish_reason ?? "stop",
        tokens: {
          prompt: body.usage?.prompt_tokens ?? 0,
          completion: body.usage?.completion_tokens ?? 0,
          total: body.usage?.total_tokens ?? 0,
        },
        timings: body.timings
          ? {
              prompt_per_second: body.timings.prompt_per_second ?? 0,
              predicted_per_second: body.timings.predicted_per_second ?? 0,
            }
          : undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(): Promise<boolean> {
    try {
      const healthUrl = this.baseUrl.replace(/\/v1$/, "") + "/health";
      const res = await fetch(healthUrl, { method: "GET" });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as
        | { status?: string }
        | null;
      return body?.status === "ok";
    } catch {
      return false;
    }
  }
}
