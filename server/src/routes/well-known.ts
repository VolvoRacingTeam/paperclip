/**
 * Public .well-known endpoints for Paperclip.
 *
 * Task #26 (2026-04-24): expose /.well-known/jwks.json so Kundeoversikt
 * (and any future consumer of Paperclip-signed agent JWTs) can verify
 * tokens without shared secrets.
 *
 * The route MUST be accessible without authentication. It is mounted
 * on the express app directly (not under /api) and must be allowed
 * through Cloudflare Access (see docs/jwks-es256-2026-04-24.md).
 */

import { Router } from "express";
import { buildJwksDocument } from "../agent-jwt-es256.js";

export function wellKnownRoutes() {
  const router = Router();

  router.get("/jwks.json", (_req, res) => {
    const jwks = buildJwksDocument();
    res.set("Content-Type", "application/json");
    // Cache for 1h; rotation procedures publish the new key alongside the
    // old one before the old one is used for signing, so 1h staleness is safe.
    res.set("Cache-Control", "public, max-age=3600");
    res.status(200).json(jwks);
  });

  return router;
}
