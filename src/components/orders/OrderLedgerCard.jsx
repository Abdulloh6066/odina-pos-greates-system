import React from 'react';
import { formatUZS } from '@/lib/pos';
import { statusLabel, typeLabel, payStatusLabel, fulfilmentLabel } from '@/lib/orders';

export default function OrderLedgerCard({ order, isAdmin, onOpen, onRepeat }) {
  const open = () => onOpen(order);
  return <article className="opl-order" role="button" tabIndex={0} onClick={open} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }}>
    <div className="opl-order-main">
      <div><div className="opl-order-id">{order.order_number}</div><div className="opl-customer">{order.customer_name}</div><div className="opl-phone">{order.customer_phone}</div></div>
      <div><div className="opl-cell-label">Tur</div><div className="opl-cell-value">{typeLabel(order.order_type)}</div></div>
      <div><div className="opl-cell-label">Olib borish</div><div className="opl-cell-value">{fulfilmentLabel(order.fulfilment_type)}</div></div>
      <div><div className="opl-cell-label">Sana va vaqt</div><div className="opl-cell-value">{order.required_date} · {order.required_time}</div></div>
      <div className="opl-status">{statusLabel(order.order_status)}</div>
    </div>
    <div className="opl-order-meta">
      <span>Umumiy</span><strong>{formatUZS(order.total)}</strong><span>Qoldi</span><strong>{formatUZS(order.remaining_balance)}</strong>
      <span className="opl-tag">{payStatusLabel(order.payment_status)}</span>
      {isAdmin && <span className="opl-muted">{order.shop_name_snapshot}</span>}
      {order.fulfilment_type === 'delivery' && <span className="opl-muted opl-address">{order.delivery_address || '—'}</span>}
      <button type="button" className="opl-repeat" onClick={(event) => { event.stopPropagation(); onRepeat(order); }}>↻ Qayta buyurtma</button>
    </div>
  </article>;
}