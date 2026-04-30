/**
 * Lazy singleton wiring for the FikenMcpClient consumed by
 * fiken-mcp-tools.ts. Returns null when the environment isn't configured —
 * the adapter then keeps the wrapper-tools hidden, leaving legacy
 * fiken_* tools untouched.
 *
 * Required env (presence of all three flips wrapper-tools online):
 *   - PAPERCLIP_FIKEN_MCP_ENDPOINT          (e.g. https://fikenverktoy.vercel.app)
 *   - AGENT_API_KEY                         (existing Kundeoversikt service-auth)
 *   - PAPERCLIP_JWT_PRIVATE_KEY_PEM         (ES256 PEM, inline) OR
 *     PAPERCLIP_JWT_PRIVATE_KEY_PATH        (ES256 PEM, on-disk path)
 *
 * Store-driver:
 *   Default: InMemoryAgentRunStateStore — process-lokal, taler restart kun
 *   for read-only paths (M2.2). Server-laget kan registrere en DB-backed
 *   store via registerProductionAgentRunStateStore() ved oppstart, basert paa
 *   PAPERCLIP_RUNTIME_STATE_DRIVER env-var. Kreves for M2.4 destructive writes
 *   sa correlation-context overlever container-restart.
 *
 * Open questions (spec §6) deliberately NOT resolved here:
 *   Q3 — token-exchange model (raw PAT vs JWT-bound). FikenAccessTokenFetcher
 *        is forward-compatible: caller only sees an opaque string.
 */

import {
  FikenAccessTokenFetcher,
  FikenMcpClient,
  InMemoryAgentRunStateStore,
} from "./fiken-mcp/index.js";
import type { AgentRunStateStore } from "./fiken-mcp/index.js";

let cached: FikenMcpClient | null | undefined;
let registeredStore: AgentRunStateStore | null = null;

interface BootstrapOverrides {
  endpoint?: string;
  agentApiKey?: string;
  /** Either inline PEM or on-disk path. */
  privateKeyPem?: string;
  privateKeyPath?: string;
  store?: ConstructorParameters<typeof FikenMcpClient>[0]["store"];
  tokenFetcher?: ConstructorParameters<typeof FikenMcpClient>[0]["tokenFetcher"];
}

/**
 * Pre-register a production AgentRunStateStore (typically PostgresAgentRunStateStore
 * from @paperclipai/db). Called by server/src/services/fiken-runtime-state.ts at
 * startup when PAPERCLIP_RUNTIME_STATE_DRIVER === "postgres".
 *
 * Pass null to clear the registration (test helper).
 *
 * Precedence inside getOrInitFikenMcpClient():
 *   overrides.store > registeredStore > new InMemoryAgentRunStateStore()
 */
export function registerProductionAgentRunStateStore(
  store: AgentRunStateStore | null,
): void {
  registeredStore = store;
  // Drop client cache so next call rebuilds with the new store.
  cached = undefined;
}

/**
 * Return the process-wide FikenMcpClient if env is configured; otherwise null.
 * Memoised — first call decides for the rest of the process lifetime.
 *
 * Tests can pass overrides to bypass env. Pass `null` to clear the cache.
 */
export function getOrInitFikenMcpClient(
  overrides: BootstrapOverrides | null = null,
): FikenMcpClient | null {
  if (overrides === null && cached !== undefined) return cached;

  const endpoint =
    overrides?.endpoint ?? process.env.PAPERCLIP_FIKEN_MCP_ENDPOINT;
  const agentApiKey = overrides?.agentApiKey ?? process.env.AGENT_API_KEY;
  const privateKeyConfigured =
    Boolean(overrides?.privateKeyPem ?? process.env.PAPERCLIP_JWT_PRIVATE_KEY_PEM) ||
    Boolean(overrides?.privateKeyPath ?? process.env.PAPERCLIP_JWT_PRIVATE_KEY_PATH);

  if (!endpoint || !agentApiKey || !privateKeyConfigured) {
    cached = null;
    return null;
  }

  const tokenFetcher =
    overrides?.tokenFetcher ?? new FikenAccessTokenFetcher({ apiKey: agentApiKey });
  const store =
    overrides?.store ?? registeredStore ?? new InMemoryAgentRunStateStore();

  cached = new FikenMcpClient({
    endpoint,
    store,
    tokenFetcher,
  });
  return cached;
}

/** Test helper — drop the singleton so the next call re-evaluates env. */
export function _resetFikenMcpClientForTest(): void {
  cached = undefined;
  registeredStore = null;
}
