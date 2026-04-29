/**
 * X-Fiken-Access-Token fetch from Kundeoversikt service-endpoint.
 *
 * Per spec § 1.4 (paperclip-tier-b-mcp-wireup-spec.md):
 *   GET https://kundeoversikt.no/api/agent/fiken-credentials/:tenantId
 *     → { accessToken: string, companySlug: string, expiresAt?: string }
 *
 *   Auth header: 'X-Agent-Api-Key: <AGENT_API_KEY>' (existing service-auth
 *   already used by agentBookkeepingFetch — Kundeoversikt verifies it on the
 *   server side).
 *
 *   Cache: max 60 s per (tenantId, companySlug). 401 from MCP triggers
 *   forceRefresh on the next call so we don't sit on a stale PAT.
 *
 * Open question (spec §6, item 1): whether to swap raw PAT for a JWT-bound
 * short-lived token-exchange. Tracked in coordination thread; this module is
 * forward-compatible because the caller only sees an opaque string.
 */

const DEFAULT_BASE_URL = "https://kundeoversikt.no";
const DEFAULT_PATH_PREFIX = "/api/agent/fiken-credentials";
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const AGENT_API_KEY_HEADER = "X-Agent-Api-Key";

export interface FikenAccessCredentials {
  accessToken: string;
  companySlug: string;
  /** Server-supplied absolute expiry (ISO 8601). Optional. */
  expiresAt?: string;
}

interface CacheEntry {
  credentials: FikenAccessCredentials;
  cachedAtMs: number;
}

interface TokenFetchConfig {
  baseUrl: string;
  pathPrefix: string;
  apiKey: string;
  cacheTtlMs: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  nowMs: () => number;
}

export interface TokenFetchOptions {
  baseUrl?: string;
  pathPrefix?: string;
  apiKey?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export class FikenAccessTokenFetcher {
  private cache = new Map<string, CacheEntry>();
  private readonly cfg: TokenFetchConfig;

  constructor(opts: TokenFetchOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.AGENT_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "FikenAccessTokenFetcher: AGENT_API_KEY is required (env or constructor opt)",
      );
    }
    this.cfg = {
      baseUrl: stripTrailingSlash(opts.baseUrl ?? process.env.KUNDEOVERSIKT_BASE_URL ?? DEFAULT_BASE_URL),
      pathPrefix: opts.pathPrefix ?? process.env.KUNDEOVERSIKT_FIKEN_CREDS_PATH_PREFIX ?? DEFAULT_PATH_PREFIX,
      apiKey,
      cacheTtlMs: opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl ?? fetch,
      nowMs: opts.nowMs ?? Date.now,
    };
  }

  /**
   * Get the Fiken PAT for a given tenant. Returns from cache when fresh.
   * Pass forceRefresh=true after a 401 from the MCP to bust the cache.
   */
  async getCredentials(params: {
    tenantId: string;
    companySlug?: string;
    forceRefresh?: boolean;
  }): Promise<FikenAccessCredentials> {
    if (!params.tenantId) {
      throw new Error("getCredentials: tenantId is required");
    }
    const cacheKey = `${params.tenantId}::${params.companySlug ?? "*"}`;

    if (!params.forceRefresh) {
      const hit = this.cache.get(cacheKey);
      if (hit && this.cfg.nowMs() - hit.cachedAtMs < this.cfg.cacheTtlMs) {
        return hit.credentials;
      }
    }

    const fresh = await this.fetchFromKundeoversikt(params.tenantId);
    if (
      params.companySlug &&
      fresh.companySlug !== params.companySlug
    ) {
      throw new Error(
        `Kundeoversikt returned companySlug='${fresh.companySlug}' but caller asked for '${params.companySlug}' (tenantId=${params.tenantId})`,
      );
    }
    this.cache.set(cacheKey, { credentials: fresh, cachedAtMs: this.cfg.nowMs() });
    return fresh;
  }

  /** Invalidate a single (tenantId, companySlug) cache entry — caller does this on MCP 401. */
  invalidate(params: { tenantId: string; companySlug?: string }): void {
    this.cache.delete(`${params.tenantId}::${params.companySlug ?? "*"}`);
  }

  /** Test/maintenance helper. */
  clearCache(): void {
    this.cache.clear();
  }

  private async fetchFromKundeoversikt(tenantId: string): Promise<FikenAccessCredentials> {
    const url = `${this.cfg.baseUrl}${this.cfg.pathPrefix}/${encodeURIComponent(tenantId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.cfg.fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          [AGENT_API_KEY_HEADER]: this.cfg.apiKey,
          Accept: "application/json",
        },
      });
    } catch (err) {
      throw new Error(
        `FikenAccessTokenFetcher: network error fetching ${url}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `FikenAccessTokenFetcher: unauthorized (${res.status}) — check AGENT_API_KEY for ${url}`,
      );
    }
    if (res.status === 404) {
      throw new Error(
        `FikenAccessTokenFetcher: tenant '${tenantId}' has no Fiken credentials in Kundeoversikt`,
      );
    }
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(
        `FikenAccessTokenFetcher: HTTP ${res.status} from ${url}: ${body.slice(0, 300)}`,
      );
    }

    const json = (await res.json()) as Partial<FikenAccessCredentials>;
    if (typeof json.accessToken !== "string" || json.accessToken.length === 0) {
      throw new Error(
        `FikenAccessTokenFetcher: response missing 'accessToken' (tenantId=${tenantId})`,
      );
    }
    if (typeof json.companySlug !== "string" || json.companySlug.length === 0) {
      throw new Error(
        `FikenAccessTokenFetcher: response missing 'companySlug' (tenantId=${tenantId})`,
      );
    }
    return {
      accessToken: json.accessToken,
      companySlug: json.companySlug,
      expiresAt: typeof json.expiresAt === "string" ? json.expiresAt : undefined,
    };
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
