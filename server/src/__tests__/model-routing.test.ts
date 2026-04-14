import { describe, expect, it } from "vitest";
import {
  buildRoutedPolicy,
  classifyAdapterFailure,
  selectExecutionRoute,
} from "../services/model-routing.js";

describe("model-routing", () => {
  it("falls back to gemma before the run when the daily budget is exhausted", () => {
    const policy = buildRoutedPolicy({
      workflowName: "*",
      policyRow: {
        primaryProvider: "claude_local",
        primaryModel: "claude-haiku-4-5",
        fallbackProvider: "ollama_local",
        fallbackModel: "gemma-4-26b-a4b-q3_k_m-llamacpp",
        maxTokensPerRun: 50000,
        dailyBudgetTokens: 300000,
        timezone: "Europe/Oslo",
      },
      adapterConfig: {},
      agentAdapterType: "claude_local",
    });

    const route = selectExecutionRoute({
      policy,
      adapterConfig: {},
      primaryTokensUsedToday: 285000,
      fallbackRequest: null,
    });

    expect(route.adapterType).toBe("ollama_local");
    expect(route.policyModel).toBe("gemma-4-26b-a4b-q3_k_m-llamacpp");
    expect(route.fallbackReason).toBe("budget_cap");
  });

  it("classifies Claude 429 failures as fallback triggers", () => {
    const signal = classifyAdapterFailure({
      result: {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Claude run failed: HTTP 429 from Claude on /messages",
        errorCode: "claude_http_429",
      },
      transportTimeoutRetryCount: 0,
    });

    expect(signal.shouldQueueFallbackRetry).toBe(true);
    expect(signal.fallbackReason).toBe("http_429");
    expect(signal.httpStatus).toBe(429);
  });

  it("retries once on transport timeout before scheduling fallback", () => {
    const first = classifyAdapterFailure({
      result: {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: "Timed out after 30s",
        errorCode: "timeout",
      },
      transportTimeoutRetryCount: 0,
    });
    const second = classifyAdapterFailure({
      result: {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: "Timed out after 30s",
        errorCode: "timeout",
      },
      transportTimeoutRetryCount: 1,
    });

    expect(first.shouldQueuePrimaryRetry).toBe(true);
    expect(first.shouldQueueFallbackRetry).toBe(false);
    expect(second.shouldQueueFallbackRetry).toBe(true);
    expect(second.fallbackReason).toBe("two_consecutive_transport_timeouts");
  });
});
