// Internal server allocator. The counter belongs to the existing app settings.
// Compare-and-set reserves a unique number across both shops and all dates.
// Never decrement after an uncertain write or a failed order.
export async function allocateCustomerOrderSequence(service) {
    for (let attempt = 0; attempt < 32; attempt++) {
        const rows = await service.entities.Settings.list('-created_date', 2);
        const settings = rows?.length === 1 ? rows[0] : null;
        const last = settings?.customer_order_last_number;
        if (!settings?.id || !Number.isSafeInteger(last) || last < 0 || last >= Number.MAX_SAFE_INTEGER) {
            throw Object.assign(new Error('Buyurtma raqamlash sozlamasi tekshirilsin.'), { status: 503 });
        }
        const next = last + 1;
        const result = await service.entities.Settings.updateMany(
            { id: settings.id, customer_order_last_number: last },
            { $set: { customer_order_last_number: next } },
        );
        if (result?.success === true && result.updated === 1 && !result.has_more) return next;
        if (result?.success !== true || result.updated !== 0 || result.has_more) {
            throw Object.assign(new Error('Buyurtma raqamini band qilib bo‘lmadi.'), { status: 503 });
        }
    }
    throw Object.assign(new Error('Buyurtma raqami band. Qayta urinib ko‘ring.'), { status: 409 });
}
