// Pure shop ticket-cycle helpers shared by normal and recovered shift closure.
export const serviceTicketVersion = (shop: any) => Number.isSafeInteger(shop?.service_ticket_version)
  && shop.service_ticket_version >= 0 ? shop.service_ticket_version : 0;
export const serviceTicketVersionQuery = (version: number) => version === 0
  ? { $or: [{ service_ticket_version: 0 }, { service_ticket_version: { $exists: false } }] }
  : { service_ticket_version: version };

// Called ONLY after a shift is durably closed. A second still-open or closing
// shift keeps the sequence alive. Leave the old counter as an audit clue;
// the first request of the next cycle starts again at 1.
export async function finishServiceTicketCycleIfLastShift(service: any, shopId: string): Promise<boolean> {
  if (!shopId || !service?.entities?.Shop?.get || !service?.entities?.Shift?.filter) return false;
  const shop = await service.entities.Shop.get(shopId).catch(() => null);
  if (!shop || shop.service_ticket_cycle_active !== true) return false;
  const version = serviceTicketVersion(shop);
  const [opened, closing] = await Promise.all([
    service.entities.Shift.filter({ shop_id: shopId, status: "open" }, "-opened_at", 1),
    service.entities.Shift.filter({ shop_id: shopId, status: "closing" }, "-opened_at", 1),
  ]);
  if (opened?.length || closing?.length) return false;
  const result = await service.entities.Shop.updateMany(
    { id: shopId, service_ticket_cycle_active: true, ...serviceTicketVersionQuery(version) },
    { $set: { service_ticket_cycle_active: false }, $inc: { service_ticket_version: 1 } },
  );
  return Boolean(result?.success && Number(result.updated || 0) === 1);
}
