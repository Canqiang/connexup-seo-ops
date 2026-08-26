import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../index.js";
import { requirePermission } from "../auth/httpAuth.js";
import { workbench, type HumanActionGroup } from "../services/workbenchService.js";

const workbenchQuerySchema = z.object({
  group: z.enum(["GATEKEEPING", "EXCEPTION", "MERCHANT_CONTACT"]).optional(),
  merchant_id: z.string().min(1).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Human-action projection only: the route neither creates Tasks from
 * proposals nor derives Task completion from external Agent/Run state. */
export function registerWorkbenchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/seo-ops/workbench", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const query = workbenchQuerySchema.parse(request.query);
    return workbench(ctx.db, actor.userId, {
      group: query.group as HumanActionGroup | undefined,
      merchantId: query.merchant_id,
      q: query.q,
      offset: query.offset,
      limit: query.limit,
    }, actor.scopeAll === true);
  });
}
