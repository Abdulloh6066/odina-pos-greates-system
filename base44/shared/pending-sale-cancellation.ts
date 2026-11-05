// Reuse the checkout's atomic Shift claim. A cancellation can win only before
// checkout owns that exact key; ambiguous/committed financial work is never erased.
const KEY_PATTERN = /^[a-zA-Z0-9:_-]{16,128}$/;

export function cancelledPendingSaleResponse(shift: any, key: string, userId: string) {
  if (!shift?.id || !userId || shift.user_id !== userId
    || !(shift.sale_request_keys || []).includes(key)) return null;
  const cancellation = (Array.isArray(shift.cancelled_sale_requests) ? shift.cancelled_sale_requests : [])
    .find((entry: any) => entry.idempotency_key === key && entry.user_id === userId && entry.shop_id === shift.shop_id);
  if (!cancellation) return null;
  return { cancelled: true, idempotency_key: key, shift_id: shift.id,
    user_id: shift.user_id, shop_id: shift.shop_id, cancelled_at: cancellation.cancelled_at };
}

export async function cancelPendingSaleRequest({ service, authenticatedUser, user, body, verifyOwnerPin }: any) {
  // Do not accept an ordinary admin, a browser flag, or an email-fallback identity.
  if (user.role !== 'admin' || user.is_owner !== true || String(authenticatedUser?.id) !== String(user.id)) {
    return Response.json({ error: 'Navbatdagi savdoni faqat hisob egasi bekor qila oladi.' }, { status: 403 });
  }
  const key = String(body?.idempotency_key || '');
  const shiftId = String(body?.shift_id || '');
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!KEY_PATTERN.test(key) || !shiftId || !reason || reason.length > 500
    || [...reason].some((character: string) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return Response.json({ error: 'Savdo, smena va bekor qilish sababi (1–500 belgi) kerak.' }, { status: 400 });
  }
  if (!(await verifyOwnerPin(service, body?.owner_pin, user))) {
    return Response.json({ error: 'Egasi PIN kodi noto‘g‘ri yoki urinishlar vaqtincha cheklangan.' }, { status: 403 });
  }
  const [shift, sales] = await Promise.all([
    service.entities.Shift.get(shiftId),
    service.entities.Sale.filter({ idempotency_key: key }, '-created_date', 2),
  ]);
  if (!shift?.user_id || !shift.shop_id) {
    return Response.json({ error: 'Savdo smenasi topilmadi.' }, { status: 404 });
  }
  if (sales?.length) {
    return Response.json({ error: 'Savdo serverda mavjud. Navbatdan bekor qilib bo‘lmaydi; savdo tarixidan qaytarishni tekshiring.' }, { status: 409 });
  }
  const previous = cancelledPendingSaleResponse(shift, key, shift.user_id);
  if (previous) return Response.json(previous);
  if (!['open', 'closed'].includes(shift.status) || (shift.sale_request_keys || []).includes(key)) {
    return Response.json({ error: 'Savdo yoki smena serverda bajarilmoqda, yoxud natijasi noaniq. Bekor qilinmadi; egasi tekshirishi kerak.' }, { status: 409 });
  }
  const cancellation = { idempotency_key: key, user_id: shift.user_id, shop_id: shift.shop_id,
    cancelled_by: user.id, cancelled_at: new Date().toISOString(), reason };
  try {
    await service.entities.Shift.updateMany(
      { id: shift.id, user_id: shift.user_id, shop_id: shift.shop_id, status: shift.status,
        sale_request_keys: { $ne: key } },
      { $push: { sale_request_keys: key, cancelled_sale_requests: cancellation } },
    );
  } catch {
    // A transport error may occur after the atomic write. Reread instead of
    // undoing the tombstone or authorizing local deletion from a guessed result.
  }
  const latest = await service.entities.Shift.get(shift.id);
  const confirmed = cancelledPendingSaleResponse(latest, key, shift.user_id);
  if (!confirmed) {
    return Response.json({ error: 'Bekor qilish tasdiqlanmadi. Savdo navbatda saqlandi; qayta tekshiring.' }, { status: 409 });
  }
  // The atomic journal above is the durable audit even if this feed is unavailable.
  await service.entities.ActionHistory.create({ user_id: user.id,
    user_name: user.full_name || user.email || 'Egasi', action: 'pending_sale_cancelled',
    details: `${key} · smena ${shift.id} · do‘kon ${shift.shop_id} · kassir ${shift.user_id} · ${reason}`,
  }).catch(() => {});
  return Response.json(confirmed);
}
