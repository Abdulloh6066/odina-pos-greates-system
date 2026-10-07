import { orderNotes } from './parser.js';
import { resolveOrderBotStaff } from '../order-bot-authorization.ts';
import { createCustomerOrder } from '../customer-order-create.ts';
// This adapter receives a trusted internal service, never a token or user supplied role.
// No HTTP listener or hosted service-role construction exists in the prototype.
export class InternalOrderBridge {
    constructor(service, { bindingForSender = async () => null } = {}) { this.service = service; this.bindingForSender = bindingForSender; }
    async staff(id, binding = null, selectedShop = '') { try {
        return await resolveOrderBotStaff(this.service, id, binding, selectedShop);
    }
    catch {
        return null;
    } }
    async shopActive(id) { return Boolean(await this.service.entities.Shop.get(id).then(s => s && s.active !== false && s.allows_pos !== false && s.location_type !== 'production')); }
    async createConfirmed({ draft: d, image, staffId }) {
        const u = await this.staff(staffId, await this.bindingForSender(d.sender), d.shop);
        if (!u || u.active !== true || u.data?.active === false || u.id !== d.staff || u.shop_id !== d.shop || !['admin', 'manager', 'cashier'].includes(u.role) || !await this.shopActive(d.shop))
            throw Error('scope');
        // Match explicit active cake tier, not arbitrary product price or text-chosen IDs.
        const products = await this.service.entities.Product.filter({ active: true, name: `TORT ${d.tier}` });
        const candidates = products.filter(p => p.archived !== true && p.production_unit !== 'sheet' && p.name.trim().toUpperCase() === `TORT ${d.tier}` && Number(p.shop_prices?.[d.shop] ?? p.price) === d.tier);
        if (candidates.length > 1)
            throw Error('catalog ambiguity');
        const unlisted = candidates.length === 0;
        if (d.reference_image !== image)
            throw Error('photo binding');
        const url = new URL(image);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.hostname === 'api.telegram.org' || !this.service.approvedPhotoHosts?.includes(url.hostname))
            throw Error('photo');
        const body = { action: 'create_order', idempotency_key: d.key, shop_id: u.shop_id, order_type: d.type, customer_name: d.name, customer_phone: d.phone, required_date: d.date, required_time: d.time, fulfilment_type: 'pickup', reference_image: image, notes: orderNotes(d), items: [{ product_id: unlisted ? '' : candidates[0].id, quantity: 1, customization_note: orderNotes(d) }], advance_payment: null, delivery_fee: 0, adjustment_amount: 0 };
        // Existing keys are reconciled, not passed through the legacy early replay return.
        if ((await this.service.entities.CustomerOrder.filter({ idempotency_key: d.key })).length)
            throw Error('reconcile');
        const response = await createCustomerOrder(this.service, u, body, { staffId: d.staff, shopId: d.shop, expectedTotal: d.tier, allowUnlistedCake: unlisted, authorize: async () => this.staff(d.staff, await this.bindingForSender(d.sender), d.shop) });
        if (!response.ok)
            throw Error('create');
        // Never trust only an HTTP success or parent order. Read all required records.
        return this.reconcile(d);
    }
    async reconcile(d) {
        const u = await this.staff(d.staff, await this.bindingForSender(d.sender), d.shop);
        if (!u || u.active !== true || u.data?.active === false || u.shop_id !== d.shop || !['admin', 'manager', 'cashier'].includes(u.role) || !await this.shopActive(d.shop))
            return null;
        const rows = await this.service.entities.CustomerOrder.filter({ idempotency_key: d.key });
        if (rows.length !== 1)
            return null;
        const o = rows[0];
        if (o.creator_id !== d.staff || o.shop_id !== d.shop || o.customer_name !== d.name || o.customer_phone !== d.phone || o.required_date !== d.date || o.required_time !== d.time || o.order_type !== d.type || o.fulfilment_type !== 'pickup' || o.notes !== orderNotes(d) || o.reference_image !== d.reference_image || o.total !== d.tier || o.paid_amount !== 0 || o.remaining_balance !== d.tier || o.payment_status !== 'unpaid')
            return null;
        if (!o.customer_id || !await this.service.entities.Customer.get(o.customer_id))
            return null;
        const items = await this.service.entities.CustomerOrderItem.filter({ order_id: o.id });
        const payments = await this.service.entities.OrderPayment.filter({ order_id: o.id });
        const audit = await this.service.entities.ActionHistory.filter({ user_id: d.staff, action: 'order_created' });
        const unlisted = items.length === 1 && items[0].item_type === 'custom' && items[0].product_id === '' && items[0].product_name_snapshot === 'Oddiy buyurtma (tort)';
        const catalogued = items.length === 1 && items[0].item_type !== 'custom' && Boolean(items[0].product_id) && items[0].product_name_snapshot === `TORT ${d.tier}`;
        if ((!unlisted && !catalogued) || items[0].shop_id !== d.shop || items[0].quantity !== 1 || items[0].unit_price_snapshot !== d.tier || items[0].line_total !== d.tier || items[0].unit_snapshot !== 'piece' || items[0].customization_note !== orderNotes(d) || payments.length || !audit.some(a => a.details.startsWith(o.order_number + ' · ')))
            return null;
        return { complete: true, key: d.key, staff: d.staff, shop: d.shop, total: o.total, paid_amount: o.paid_amount, remaining_balance: o.remaining_balance, payment_status: o.payment_status, order_number: o.order_number, catalog_missing: unlisted };
    }
}
