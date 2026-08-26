import type { FastifyInstance } from "fastify";
import type { AppContext } from "../index.js";
import { requireMerchantAccess, requirePermission } from "../auth/httpAuth.js";
import { cycleLedger, postProgram } from "../services/merchantControlRoomService.js";

/** Read-only merchant workspace projections.  Authentication and merchant
 * scoping happen before any projection query so a hidden merchant is
 * indistinguishable from a missing one. */
export function registerMerchantControlRoomRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/seo-ops/merchants/:merchantId/cycle-ledger", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    return cycleLedger(ctx.db, merchantId);
  });

  app.get("/api/seo-ops/merchants/:merchantId/post-program", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    return postProgram(ctx.db, merchantId);
  });
}
