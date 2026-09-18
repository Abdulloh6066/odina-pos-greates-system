// One uplifting message per receipt. A sale's stable identifier keeps reprints consistent.
export const RECEIPT_WISHES = Object.freeze([
  'Bugungi kuningiz shirin lahzalarga boy bo‘lsin! ❤️',
  'Tabassumingiz hech qachon yuzingizdan arimasin!',
  'Baxt ba’zan bir bo‘lak tortdan boshlanadi. 🍰',
  'Hayotning eng shirin lahzalari hali oldinda!',
  'Bugun tabassum qilish uchun yana bir sababingiz bor. ❤️',
  'Shirinlikni bizdan, yaxshi kayfiyatni hayotdan oling!',
  'Orzularingiz siz o‘ylagandan ham yaqinroq bo‘lsin.',
]);

export function receiptWishForSale(sale) {
  const identifier = String(
    sale?.sale_number || sale?.id || sale?.idempotency_key
      || `${sale?.shop_id || ''}:${sale?.sold_at || sale?.created_date || sale?.created_at || ''}`,
  );
  // Deterministic selection: a repeated print of the same sale never changes its wish.
  let hash = 2166136261;
  for (let index = 0; index < identifier.length; index += 1) {
    hash = Math.imul(hash ^ identifier.charCodeAt(index), 16777619);
  }
  return RECEIPT_WISHES[(hash >>> 0) % RECEIPT_WISHES.length];
}
