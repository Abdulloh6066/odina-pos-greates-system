import { wholesaleError } from './wholesale-logic.js';

const getStock = async (entities, sale) => {
  const stocks = await entities.ProductStock.filter({ location_id: sale.source_id, product_id: sale.product_id }, 'id', 2);
  if (stocks.length !== 1 || stocks[0].unit !== (sale.stock_unit || 'sheet')) throw wholesaleError('List qoldig‘i topilmadi yoki takrorlangan.', 409);
  return stocks[0];
};
const changed = result => result?.success && Number(result.updated) === 1;

export async function confirmWholesale(entities, sale) {
  if (sale.status === 'completed') return sale;
  if (!['draft', 'processing'].includes(sale.status)) throw wholesaleError('Bu hujjat tasdiqlanmaydi.', 409);
  if (sale.lock_token && Date.parse(sale.lock_until) > Date.now()) throw wholesaleError('Savdo tekshirilmoqda. Qayta pul olmang; bir necha daqiqadan keyin shu hujjatni qayta tekshiring.', 409);
  const stockQuantity = sale.stock_quantity ?? sale.quantity;
  if (!Number.isFinite(stockQuantity) || stockQuantity <= 0) throw wholesaleError('Ombor miqdori noto‘g‘ri.', 409);
  let stock = await getStock(entities, sale);
  if (!stock.wholesale_applied?.includes(sale.id) && Number(stock.quantity) < stockQuantity) throw wholesaleError('Omborda yetarli list qolmagan.', 409);
  const token = crypto.randomUUID();
  const lockFilter = { id: sale.id, status: sale.status, ...(sale.lock_token ? { lock_token: sale.lock_token, lock_until: sale.lock_until } : { lock_token: { $in: ['', null] } }) };
  const acquired = await entities.WholesaleSale.updateMany(lockFilter, { $set: { status: 'processing', lock_token: token, lock_until: new Date(Date.now() + 360000).toISOString() } });
  if (!changed(acquired)) throw wholesaleError('Hujjat boshqa oynada tasdiqlanmoqda. Tarixni yangilang.', 409);
  const patch = async data => {
    const result = await entities.WholesaleSale.updateMany({ id: sale.id, status: 'processing', lock_token: token }, { $set: data });
    if (!changed(result)) throw wholesaleError('Hujjat holati o‘zgardi. Tarixdan qayta tekshiring.', 409);
    sale = { ...sale, ...data };
  };
  // The lease exceeds the platform request lifetime. On uncertain writes it is NOT released early.
  // A later attempt resumes the same document and its atomic stock marker, never a new sale.
  for (let pass = 0; pass < 4; pass++) {
    stock = await getStock(entities, sale);
    if (stock.wholesale_applied?.includes(sale.id)) break;
    const before = Number(stock.quantity), after = before - stockQuantity;
    if (after < 0) throw wholesaleError('Qoldiq boshqa savdoda o‘zgargan. Shu hujjatni keyin qayta tekshiring.', 409);
    await patch({ stock_id: stock.id, balance_before: before, balance_after: after });
    const result = await entities.ProductStock.updateMany({ id: stock.id, quantity: before, wholesale_applied: { $ne: sale.id } }, {
      $inc: { quantity: -stockQuantity }, $push: { wholesale_applied: sale.id },
      $set: { updated_at: new Date().toISOString(), updated_by: sale.seller_id, updated_by_name: sale.seller_name },
    });
    if (changed(result)) break;
  }
  stock = await getStock(entities, sale);
  if (!stock.wholesale_applied?.includes(sale.id)) throw wholesaleError('Qoldiqni tasdiqlab bo‘lmadi. Shu hujjatni qayta tekshiring.', 409);
  const now = sale.sold_at || new Date().toISOString();
  await patch({ sold_at: now });
  const movementNumber = `WS-${sale.id}`;
  const movements = await entities.StockMovement.filter({ movement_number: movementNumber }, 'id', 2);
  if (movements.length > 1) throw wholesaleError('Takroriy harakat: administrator tekshirsin.', 409);
  if (!movements.length) await entities.StockMovement.create({
    movement_number: movementNumber, location_id: sale.source_id, location_name: sale.source_name,
    item_kind: 'product', item_id: sale.product_id, item_name: sale.product_name, unit: sale.stock_unit || 'sheet', movement_type: 'sale',
    quantity_change: -stockQuantity, balance_before: sale.balance_before, balance_after: sale.balance_after,
    reason: `${sale.buyer_name}: ${sale.unit === 'piece' ? 'dona' : 'list'} savdosi`, reference_id: sale.id, reference_type: 'wholesale_sale',
    user_id: sale.seller_id, user_name: sale.seller_name, created_at: now,
  });
  if (sale.buyer_type === 'branch') {
    const transfers = await entities.StockTransfer.filter({ transfer_number: movementNumber }, 'id', 2);
    if (transfers.length > 1) throw wholesaleError('Takroriy transfer: administrator tekshirsin.', 409);
    const transfer = transfers[0] || await entities.StockTransfer.create({
      transfer_number: movementNumber, batch_id: `wholesale-${sale.id}`, batch_number: movementNumber, line_number: 1, batch_item_count: 1,
      source_location_id: sale.source_id, source_location_name: sale.source_name,
      destination_location_id: sale.buyer_id, destination_location_name: sale.buyer_name,
      product_id: sale.product_id, product_name_snapshot: sale.product_name, quantity: sale.quantity, unit: sale.unit || 'sheet',
      conversion_factor: sale.conversion_factor, received_quantity: sale.quantity * sale.conversion_factor,
      status: 'pending', notes: `Mahsulot savdosi ${movementNumber}. 1 ${sale.unit === 'piece' ? 'dona' : 'list'}: ${sale.unit_price} UZS; jami: ${sale.total} UZS.`,
      created_by: sale.seller_id, created_by_name: sale.seller_name, sent_at: now,
    });
    await patch({ transfer_id: transfer.id });
  }
  await patch({ status: 'completed', lock_token: '', lock_until: '' });
  return { ...sale, status: 'completed' };
}