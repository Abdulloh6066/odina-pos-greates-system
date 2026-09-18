// Read-only business-data export for the owner. No credentials, PIN hashes, user
// accounts, invitations, Telegram tokens or security settings are exported.
// JSON is an archive, NOT an automated database restore file.
export const BACKUP_ENTITIES = Object.freeze([
  'Shop', 'Settings', 'Category', 'Product', 'Ingredient', 'ProductStock',
  'IngredientStock', 'Recipe', 'RecipeItem', 'ProductionBatch',
  'ProductionBatchItem', 'StockTransfer', 'ShopRequest', 'ShopRequestItem',
  'SupplierReceipt', 'SupplierReceiptItem', 'SupplierPayment', 'WasteRecord',
  'StockCount', 'StockCountItem', 'StockMovement', 'Shift',
  'ShiftProductSnapshot', 'Sale', 'SaleItem', 'Payment', 'Refund',
  'CashMovement', 'CashRecipient', 'BudgetBalance', 'BudgetTransaction',
  'Customer', 'CustomerOrder', 'CustomerOrderItem', 'OrderPayment',
  'DailyShopReport', 'ActionHistory',
]);

const PAGE_SIZE = 500;
const MAX_ROWS_PER_ENTITY = 10000;

export async function collectBusinessBackup(entities, { onProgress = () => {}, generatedAt = new Date().toISOString() } = {}) {
  const records = {};
  const counts = {};
  for (const name of BACKUP_ENTITIES) {
    const handler = entities[name];
    if (!handler || typeof handler.list !== 'function') {
      throw new Error(`${name}: ma’lumot manbasi mavjud emas. Zaxira yaratilmadi.`);
    }
    const all = [];
    const seen = new Set();
    for (let skip = 0; skip <= MAX_ROWS_PER_ENTITY; skip += PAGE_SIZE) {
      const page = await handler.list('created_date', PAGE_SIZE, skip);
      if (!Array.isArray(page)) {
        throw new Error(`${name}: eksport javobi noto‘g‘ri. Zaxira yaratilmadi.`);
      }
      for (const row of page) {
        if (!row?.id || seen.has(row.id)) {
          throw new Error(`${name}: yozuvlar takrorlandi yoki ID yo‘q. Zaxira yaratilmadi.`);
        }
        seen.add(row.id);
        all.push(row);
      }
      if (page.length < PAGE_SIZE) break;
      if (skip + PAGE_SIZE >= MAX_ROWS_PER_ENTITY) {
        throw new Error(`${name}: ${MAX_ROWS_PER_ENTITY} yozuv chegarasi yetdi. To‘liqsiz zaxira yaratilmaydi.`);
      }
    }
    records[name] = all;
    counts[name] = all.length;
    onProgress(name, all.length);
  }
  return {
    format: 'odina-business-archive', version: 1, generated_at: generatedAt,
    notice: 'Faqat biznes ma’lumotlari. Xodim akkauntlari, PIN, token va xavfsizlik sozlamalari kiritilmagan. Avtomatik tiklash funksiyasi yo‘q. Eksport paytida savdolar davom etsa, bu tranzaksion snapshot emas.',
    counts, records,
  };
}

export function downloadBusinessBackup(backup) {
  const stamp = backup.generated_at.replace(/[:.]/g, '-');
  const name = `odina-biznes-zaxira-${stamp}.json`;
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return name;
}
