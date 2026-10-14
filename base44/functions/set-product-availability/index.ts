import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) return Response.json({ error: "Authentication required." }, { status: 401 });
    const user = await resolveAppUser(base44.asServiceRole, authenticatedUser);
    if (!["admin", "accountant", "production"].includes(user.role)) {
      return Response.json({ error: "Your role cannot change availability." }, { status: 403 });
    }
    const body = await req.json();
    const productId = String(body?.product_id || "");
    if (!productId || typeof body?.active !== "boolean") {
      return Response.json({ error: "Product and availability are required." }, { status: 400 });
    }
    const product = await base44.asServiceRole.entities.Product.get(productId);
    if (!product) return Response.json({ error: "Product not found." }, { status: 404 });
    const updated = await base44.asServiceRole.entities.Product.update(product.id, { active: body.active });
    await base44.asServiceRole.entities.ActionHistory.create({
      user_id: user.id, user_name: user.full_name || user.email,
      action: "product_availability_changed",
      details: `${product.name}: ${body.active ? "available" : "unavailable"}`,
    });
    return Response.json({ product: updated });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not update availability." }, { status: Number((error as any)?.status || 500) });
  }
});
