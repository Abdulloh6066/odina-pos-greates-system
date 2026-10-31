import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { resolveAppUser, userLabel } from '../../shared/user-helpers.ts';
import { sheetQuote, wholesaleError } from '../../shared/wholesale-logic.js';
import { confirmWholesale } from '../../shared/wholesale-confirm.js';

const publicSale = sale => Object.fromEntries(Object.entries(sale).filter(([key]) => !['lock_token', 'lock_until'].includes(key)));
export default async function(req) {
  try {
    const client = createClientFromRequest(req);
    const identity = await client.auth.me().catch(e => { if (e.status === 401) return null; throw e; });
    if (!identity) return Response.json({ error: 'Tizimga kiring.' }, { status: 401 });
    const service = client.asServiceRole;
    const user = await resolveAppUser(service, identity);
    if (!['admin', 'production'].includes(user.role)) return Response.json({ error: 'List savdosi uchun ruxsat yo‘q.' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const entities = service.entities;
    const get = async (entity, id) => {
      if (typeof id !== 'string' || !id || id.length > 100) throw wholesaleError('Hujjat tanlanmagan.');
      const row = await entity.get(id).catch(e => { if (e.status === 404) return null; throw e; });
      if (!row) throw wholesaleError('Ma’lumot topilmadi.', 404);
      return row;
    };
    const sourceAccess = async id => {
      if (user.role !== 'admin' && (!user.shop_id || id !== user.shop_id)) throw wholesaleError('Faqat biriktirilgan ishlab chiqarish joyidan sotish mumkin.', 403);
      const source = await get(entities.Shop, id);
      if (source.active === false || source.location_type !== 'production') throw wholesaleError('Ishlab chiqarish joyini tanlang.');
      return source;
    };
    if (body.action === 'setup') {
      const [sources, branches] = await Promise.all([
        entities.Shop.filter({ location_type: 'production', active: true, ...(user.role === 'admin' ? {} : { id: user.shop_id || '__none__' }) }, 'name', 500),
        entities.Shop.filter({ location_type: 'shop', active: true }, 'name', 500),
      ]);
      const pick = rows => rows.map(({ id, name }) => ({ id, name }));
      return Response.json({ sources: pick(sources), branches: pick(branches) });
    }
    if (['confirm', 'cancel'].includes(body.action)) {
      const sale = await get(entities.WholesaleSale, body.sale_id);
      await sourceAccess(sale.source_id);
      if (user.role !== 'admin' && sale.seller_id !== user.id) throw wholesaleError('Bu savdo boshqa xodimga tegishli.', 403);
      if (body.action === 'cancel') {
        const result = await entities.WholesaleSale.updateMany({ id: sale.id, status: 'draft' }, { $set: { status: 'cancelled' } });
        if (!result?.success || Number(result.updated) !== 1) throw wholesaleError('Boshlangan savdoni bekor qilib bo‘lmaydi.', 409);
        return Response.json({ ok: true });
      }
      if (sale.status === 'draft' && sale.buyer_type === 'branch') {
        const buyer = await get(entities.Shop, sale.buyer_id);
        if (buyer.active === false || buyer.location_type !== 'shop') throw wholesaleError('Filial faol emas.');
      }
      return Response.json({ sale: publicSale(await confirmWholesale(entities, sale)) });
    }
    const source = await sourceAccess(body.source_id);
    if (body.action === 'catalog') {
      const search = String(body.search || '').trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const categories = await entities.Category.filter({}, 'name', 500);
      const cakeCategories = new Set(['tortlar', 'aralash', '15 somlik', '18 somlik', 'mini/tart', 'pishiriqlar']);
      const categoryIds = categories.filter(c => cakeCategories.has(String(c.name || '').trim().toLocaleLowerCase()
        .replace(/:/g, '/').replace(/\s+/g, ' '))).map(c => c.id);
      const page = await entities.Product.filter({ active: true, archived: { $ne: true }, track_stock: { $ne: false },
        category_id: { $in: categoryIds },
        $or: [{ source_type: 'central_produced' }, { source_type: { $exists: false } }, { source_type: null }, { source_type: '' }],
        sale_unit: { $ne: 'gram' },
        ...(search ? { name: { $regex: search, $options: 'i' } } : {}),
      }, { sort: 'name', limit: 30, ...(body.cursor ? { cursor: String(body.cursor) } : {}) });
      const stocks = page.items.length ? await entities.ProductStock.filter({ location_id: source.id, product_id: { $in: page.items.map(p => p.id) } }, 'id', 100) : [];
      return Response.json({ ...page, items: page.items.map(p => ({ id: p.id, name: p.name, image_url: p.image_url, sheet_price: p.sheet_price, production_unit: p.production_unit, pieces_per_sheet: p.pieces_per_sheet,
        list_ready: Number.isSafeInteger(p.pieces_per_sheet) && p.pieces_per_sheet > 0 && p.source_type === 'central_produced',
        stock_quantity: stocks.filter(s => s.product_id === p.id).length === 1 ? (() => {
          const stock = stocks.find(s => s.product_id === p.id);
          return stock.unit === 'sheet' ? Number(stock.quantity || 0) : stock.unit === 'piece' && p.pieces_per_sheet > 0 ? Number(stock.quantity || 0) / p.pieces_per_sheet : 0;
        })() : 0 })) });
    }
    if (body.action === 'history') {
      const page = await entities.WholesaleSale.filter({ source_id: source.id, ...(user.role === 'admin' ? {} : { seller_id: user.id }) },
        { sort: '-created_date', limit: 20, ...(body.cursor ? { cursor: String(body.cursor) } : {}) });
      return Response.json({ ...page, items: page.items.map(publicSale) });
    }
    if (body.action === 'prepare') {
      if (!['branch', 'external'].includes(body.buyer_type) || !['cash', 'bank_transfer'].includes(body.payment_method)) throw wholesaleError('Xaridor va to‘lov turini tanlang.');
      const product = await get(entities.Product, body.product_id);
      const quote = sheetQuote(product, body.quantity, body.buyer_type);
      let buyerId = '', buyerName = String(body.buyer_name || '').trim();
      if (body.buyer_type === 'branch') {
        const buyer = await get(entities.Shop, body.buyer_id);
        if (buyer.active === false || buyer.location_type !== 'shop' || buyer.id === source.id) throw wholesaleError('Faol Odina filialini tanlang.');
        buyerId = buyer.id; buyerName = buyer.name;
      }
      if (!buyerName || buyerName.length > 120) throw wholesaleError('Do‘kon nomini kiriting (120 belgigacha).');
      const stocks = await entities.ProductStock.filter({ location_id: source.id, product_id: product.id }, 'id', 2);
      if (stocks.length !== 1 || !['piece', 'sheet'].includes(stocks[0].unit)) throw wholesaleError('Ombor qoldig‘i topilmadi.', 409);
      const stockUnit = stocks[0].unit;
      const stockQuantity = quote.quantity * (stockUnit === 'piece' ? quote.conversion_factor : 1);
      if (Number(stocks[0].quantity) < stockQuantity) throw wholesaleError('Omborda yetarli list yo‘q.', 409);
      const sale = await entities.WholesaleSale.create({ source_id: source.id, source_name: source.name,
        buyer_type: body.buyer_type, buyer_id: buyerId, buyer_name: buyerName, product_id: product.id, product_name: product.name,
        ...quote, stock_unit: stockUnit, stock_quantity: stockQuantity, payment_method: body.payment_method, seller_id: user.id, seller_name: userLabel(user), status: 'draft', lock_token: '', lock_until: '' });
      return Response.json({ sale: publicSale(sale) });
    }
    return Response.json({ error: 'Noma’lum amal.' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message || 'Savdoni saqlab bo‘lmadi. Hujjatni tarixdan qayta oching.' }, { status: error.status || 500 });
  }
}