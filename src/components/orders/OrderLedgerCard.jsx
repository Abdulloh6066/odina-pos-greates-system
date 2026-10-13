import React from 'react';
import { Image } from '@/components/ui/image';
import { ArrowUpRight, Repeat2, User, Phone, Calendar, Store, ImageIcon } from 'lucide-react';
import { formatUZS } from '@/lib/pos';
import { displayOrderNumber, statusLabel, statusTone, typeLabel, payStatusLabel, payStatusTone, fulfilmentLabel } from '@/lib/orders';

function displayDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value || '—';
}

export default function OrderLedgerCard({ order, isAdmin, onOpen, onRepeat }) {
  const remaining = Number(order.remaining_balance || 0);
  return <article className="opl-order">
    <button type="button" className="opl-order-open" onClick={() => onOpen(order)}
      aria-label={`${displayOrderNumber(order)}, ${order.customer_name}, batafsil ko‘rish`}>
      <div className="opl-order-header">
        <div className="opl-order-header-left">
          <span className="opl-order-number">{displayOrderNumber(order)}</span>
          <div className="opl-order-badges">
            <span className={`opl-badge ${statusTone(order.order_status)}`}>{statusLabel(order.order_status)}</span>
            <span className={`opl-badge ${payStatusTone(order.payment_status)}`}>{payStatusLabel(order.payment_status)}</span>
          </div>
        </div>
        <ArrowUpRight className="opl-open-arrow" size={20} aria-hidden="true" />
      </div>
      <p className="opl-order-type-line">{typeLabel(order.order_type)} · {fulfilmentLabel(order.fulfilment_type)}</p>
      <div className="opl-order-customer">
        <div><span className="opl-order-customer-label">Mijoz</span><h3>{order.customer_name || '—'}</h3></div>
        <div className="opl-order-due"><Calendar size={16} aria-hidden="true" /><span>{displayDate(order.required_date)}<strong>{order.required_time || '—'}</strong></span></div>
      </div>
      <div className="opl-order-meta">
        <MetaRow icon={Phone} label="Telefon" value={order.customer_phone || '—'} />
        {isAdmin && order.shop_name_snapshot && <MetaRow icon={Store} label="Do‘kon" value={order.shop_name_snapshot} />}
        {order.creator_name && <MetaRow icon={User} label="Yaratdi" value={`${order.creator_name}${order.creator_role ? ` (${order.creator_role})` : ''}`} />}
      </div>

      {order.reference_image && (
        <div className="opl-order-image-wrap">
          <div className="opl-order-image-thumb">
            <Image src={order.reference_image} alt={`${displayOrderNumber(order)} tort namuna rasmi`}
              fittingType="fit" className="h-full w-full object-contain" />
          </div>
          <span className="opl-order-image-hint"><ImageIcon size={12} aria-hidden="true" /> Batafsil ko‘rish uchun bosing</span>
        </div>
      )}

      <div className="opl-order-footer">
        <div className="opl-order-price-line"><span>Mahsulotlar</span><strong>{formatUZS(order.subtotal)}</strong></div>
        <div className="opl-order-price-line"><span>Yetkazib berish</span><strong>{formatUZS(order.delivery_fee)}</strong></div>
        <div className="opl-order-price-line opl-order-total"><span>Jami</span><strong>{formatUZS(order.total)}</strong></div>
        {remaining > 0 && <div className="opl-order-price-line opl-order-balance"><span>Qoldi</span><strong>{formatUZS(remaining)}</strong></div>}
      </div>
    </button>
    {onRepeat && <div className="opl-order-actions">
      <button type="button" onClick={() => onRepeat(order)}><Repeat2 size={16} aria-hidden="true" /> Qayta buyurtma</button>
    </div>}
  </article>;
}

function MetaRow({ icon: Icon, label, value }) {
  return <div className="opl-meta-row">
    <Icon className="opl-meta-icon" size={14} aria-hidden="true" />
    <span className="opl-meta-label">{label}:</span>
    <span className="opl-meta-value">{value}</span>
  </div>;
}
