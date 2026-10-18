import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";
import { handleIngredientRequest } from "../../shared/ingredient-requests.ts";

export default async function(req) {
  try {
    const client = createClientFromRequest(req);
    const auth = await client.auth.me();
    if (!auth) return Response.json({ error: "Tizimga kiring.", request_not_started: true }, { status: 401 });
    const user = await resolveAppUser(client.asServiceRole, auth);
    return Response.json(await handleIngredientRequest(client.asServiceRole, user, await req.json()));
  } catch (e) {
    return Response.json({ error: e.message || "Talabnoma amali bajarilmadi.",
      request_not_started: e.request_not_started === true,
      operation_pending: e.operation_pending === true }, { status: e.status || 500 });
  }
}
