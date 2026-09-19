// Display-only adapters for the existing kitchen/service ticket. Never calculate
// prices or mutate the order or its saved item snapshots here.
export function staffTicketFromSale(sale) {
  if (!sale) return null;
  return {
    id: sale.id || sale.idempotency_key,
    number: sale.service_ticket_number ?? sale.sale_number ?? String(sale.id || '').slice(-6).toUpperCase(),
    started_at: sale.sold_at || sale.created_date || sale.created_at,
    shop_name: sale.shop_name,
    table_number: Number.isInteger(sale.table_number_snapshot) ? sale.table_number_snapshot : null,
    opened_by_name: sale.user_name,
    offline_pending: sale.offline_pending === true,
    items: (sale.items || []).map((item) => ({
      product_name: item.product_name,
      quantity: item.quantity,
      variant_name: item.variant_name,
      notes: item.notes,
      unit_label: 'ta',
    })),
  };
}

export function staffTicketFromCustomerOrder(order, savedItems) {
  if (!order) return null;
  return {
    id: order.id,
    number: order.order_number,
    started_at: order.created_at || order.created_date,
    shop_name: order.shop_name_snapshot,
    customer_name: order.customer_name,
    customer_phone: order.customer_phone,
    opened_by_name: order.creator_name,
    fulfilment_type: order.fulfilment_type,
    delivery_address: order.fulfilment_type === 'delivery' ? order.delivery_address : '',
    required_date: order.required_date,
    required_time: order.required_time,
    notes: order.notes,
    items: (savedItems || []).map((item) => ({
      product_name: item.product_name_snapshot,
      quantity: item.quantity,
      unit_label: item.unit_snapshot === 'sheet' ? 'varaq' : 'ta',
      notes: item.customization_note,
    })),
  };
}
