import React from 'react';
import { ArrowUpRight, Repeat2 } from 'lucide-react';
import { formatUZS } from '@/lib/pos';
import { statusLabel, typeLabel, payStatusLabel, fulfilmentLabel } from '@/lib/orders';

function displayDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value || 'Sana belgilanmagan';
}

export default function OrderLedgerCard({ order, isAdmin, onOpen, onRepeat }) {
  const remaining = Number(order.remaining_balance || 0);
  return <article className="opl-order">
    <button type="button" className="opl-order-open" onClick={() => onOpen(order)}
      aria-label={`${order.order_number}, ${order.customer_name}, batafsil ko‘rish`}>
      <div className="opl-order-top">
        <span className="opl-order-time">{displayDate(order.required_date)} <strong>{order.required_time || '—'}</strong></span>
        <span className="opl-status" data-status={order.order_status}>{statusLabel(order.order_status)}</span>
      </div>
      <div className="opl-order-content">
        <div className="opl-order-person">
          <span className="opl-order-id">{order.order_number}</span>
          <strong className="opl-customer">{order.customer_name}</strong>
          <span className="opl-phone">{order.customer_phone || 'Telefon ko‘rsatilmagan'}</span>
        </div>
        <div className="opl-order-details">
          <span>{typeLabel(order.order_type)}</span>
          <span>{fulfilmentLabel(order.fulfilment_type)}</span>
          {isAdmin && order.shop_name_snapshot && <span>{order.shop_name_snapshot}</span>}
          {order.fulfilment_type === 'delivery' && order.delivery_address && <span className="opl-address">{order.delivery_address}</span>}
        </div>
      </div>
      <div className="opl-order-bottom">
        <span>Jami <strong>{formatUZS(order.total)}</strong></span>
        <span className={remaining > 0 ? 'opl-balance-due' : 'opl-balance-paid'}>
          {remaining > 0 ? 'Qolgan to‘lov' : 'To‘lov'} <strong>{remaining > 0 ? formatUZS(remaining) : payStatusLabel(order.payment_status)}</strong>
        </span>
        <ArrowUpRight className="opl-open-arrow" size={20} aria-hidden="true" />
      </div>
    </button>
    {onRepeat && <div className="opl-order-actions">
      <button type="button" onClick={() => onRepeat(order)}><Repeat2 size={16} aria-hidden="true" /> Qayta buyurtma</button>
    </div>}
  </article>;
}
