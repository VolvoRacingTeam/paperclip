import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { managerSonnetUsageService } from "../services/manager-sonnet-usage.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Pakke D (SON-97): GET /api/companies/:companyId/manager-sonnet-usage?window=24h
 *
 * Returnerer aggregert sonnet-token-bruk per manager-agent for valgt
 * tidsvindu. Default vindu er 24h. Stoetter "Nh" og "Nm".
 */
export function managerSonnetUsageRoutes(db: Db) {
  const router = Router();
  const svc = managerSonnetUsageService(db);

  router.get(
    "/companies/:companyId/manager-sonnet-usage",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const window = typeof req.query.window === "string" ? req.query.window : undefined;
      const aggregates = await svc.aggregateByAgent(companyId, window);
      res.json({
        window: window ?? "24h",
        agents: aggregates,
      });
    },
  );

  return router;
}
