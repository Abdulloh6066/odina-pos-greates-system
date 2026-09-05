import { createClientFromRequest } from "npm:@base44/sdk";

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Tizimga kirish talab qilinadi." }, { status: 401 });
    return Response.json({
      error: "Bu eski smena yopish yo‘li xavfsizlik uchun yopilgan. Smenani Kassa sahifasidan yoping.",
    }, { status: 410 });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Smena yopish yo‘lini tekshirib bo‘lmadi.",
    }, { status: 500 });
  }
});
