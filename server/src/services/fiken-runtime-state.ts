/**
 * Wiring for Fikenverktoy MCP runtime-state-store.
 *
 * Leser PAPERCLIP_RUNTIME_STATE_DRIVER (default "memory") og registrerer
 * eventuelt en PostgresAgentRunStateStore i adapter-laget. Default forblir
 * in-memory inntil M2.4 destructive writes lanseres — fail-safe.
 *
 * Kjores en gang ved server-oppstart, etter at `db` er klar.
 */

import {
  PostgresAgentRunStateStore,
  type AgentRunStateStore,
  type Db,
} from "@paperclipai/db";
import { registerProductionAgentRunStateStore } from "@paperclipai/adapter-ollama-local/server";
import { logger } from "../middleware/logger.js";

export type AgentRunStateDriver = "memory" | "postgres";

export interface FikenRuntimeStateInit {
  driver: AgentRunStateDriver;
  store: AgentRunStateStore | null;
}

function readDriverFromEnv(): AgentRunStateDriver {
  const raw = process.env.PAPERCLIP_RUNTIME_STATE_DRIVER?.trim().toLowerCase();
  if (raw === "postgres") return "postgres";
  return "memory";
}

/**
 * Initialiser runtime-state-store basert paa env-var. Returnerer
 * `{ driver, store }` for oppgradert observability — store er null naar
 * driver === "memory" (adapter faller tilbake til InMemoryAgentRunStateStore
 * paa egen haand).
 */
export function initFikenRuntimeStateStore(deps: {
  db: Db;
}): FikenRuntimeStateInit {
  const driver = readDriverFromEnv();

  if (driver === "memory") {
    // Sikre at evt. tidligere registrering blir nullstilt.
    registerProductionAgentRunStateStore(null);
    logger.info(
      { driver },
      "fiken-mcp runtime-state driver: memory (in-memory store, no DB persistence)",
    );
    return { driver, store: null };
  }

  // driver === "postgres"
  const store = new PostgresAgentRunStateStore(deps.db);
  registerProductionAgentRunStateStore(store);
  logger.info(
    { driver },
    "fiken-mcp runtime-state driver: postgres (DB-backed, agent_run_steps + agent_runtime_state.state_json)",
  );
  return { driver, store };
}

/**
 * Vacuum-tick. Fjerner utlopte rader fra agent_run_steps. Returnerer antall
 * rader fjernet. Trygg aa kalle naar driver === "memory" — returnerer 0.
 */
export async function tickAgentRunStepsVacuum(
  init: FikenRuntimeStateInit,
  now: Date = new Date(),
): Promise<number> {
  if (init.driver !== "postgres" || init.store === null) return 0;
  const store = init.store as PostgresAgentRunStateStore;
  if (typeof store.vacuumExpired !== "function") return 0;
  return store.vacuumExpired(now);
}
