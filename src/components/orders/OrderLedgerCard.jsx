import React from 'react';
import { Image } from '@/components/ui/image';
import { ArrowUpRight, Repeat2, MoreHorizontal, CakeSlice, CheckCircle2, Clock3 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { formatUZS } from '@/lib/pos';
import { displayOrderNumber, statusLabel, typeLabel, payStatusLabel, fulfilmentLabel } from '@/lib/orders';

function displayDate(value, today) {
  if (value && value === today) return 'Bugun';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value || '—';
}

export default function OrderLedgerCard({ order, isAdmin, onOpen, onRepeat, today }) {
  const remaining = Number(order.remaining_balance || 0);
  const number = displayOrderNumber(order);
  const initials = (order.customer_name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '—';
  const paid = order.payment_status === 'paid';
  const PaymentIcon = paid ? CheckCircle2 : Clock3;

  return <tr className="opl-order-row" onClick={() => onOpen(order)}>
    <td className="opl-order-cell" data-label="Buyurtma">
      <button type="button" className="opl-row-open" onClick={(event) => { event.stopPropagation(); onOpen(order); }}
        aria-label={`${number}, ${order.customer_name || 'Mijoz'}, batafsil ko‘rish`}>
        <span className="opl-row-image">
          {order.reference_image ? <Image src={order.reference_image} alt={`${number} tort namuna rasmi`} fittingType="fit" className="h-full w-full object-contain" />
            : <CakeSlice size={26} aria-hidden="true" />}
        </span>
        <span className="opl-row-copy">
          <strong>{number}</strong>
          <span>{typeLabel(order.order_type) || 'Buyurtma'}</span>
          {isAdmin && order.shop_name_snapshot && <small>{order.shop_name_snapshot}</small>}
        </span>
      </button>
    </td>
    <td className="opl-customer-cell" data-label="Mijoz">
      <div className="opl-row-customer"><span className="opl-customer-avatar" aria-hidden="true">{initials}</span>
        <span className="opl-row-copy"><strong>{order.customer_name || '—'}</strong><span>{order.customer_phone || '—'}</span></span>
      </div>
    </td>
    <td className="opl-due-cell" data-label="Topshirish">
      <div className="opl-row-copy"><strong>{order.required_time || '—'}</strong><span>{displayDate(order.required_date, today)}</span>
        <small>{fulfilmentLabel(order.fulfilment_type)}</small></div>
    </td>
    <td className="opl-payment-cell" data-label="To‘lov">
      <div className="opl-row-copy">
        <strong>{formatUZS(order.total)}</strong>
        <span className={`opl-payment-state ${paid ? 'is-paid' : 'is-outstanding'}`}>
          <PaymentIcon size={15} aria-hidden="true" />
          <span>{payStatusLabel(order.payment_status)}{remaining > 0 && <span className="opl-remaining">{formatUZS(remaining)} qoldi</span>}</span>
        </span>
        <span className="sr-only">Mahsulotlar: {formatUZS(order.subtotal)}. Yetkazib berish: {formatUZS(order.delivery_fee)}.</span>
      </div>
    </td>
    <td className="opl-status-cell" data-label="Holat">
      <span className="opl-status-badge" data-status={order.order_status}><span aria-hidden="true" />{statusLabel(order.order_status)}</span>
    </td>
    <td className="opl-row-actions" onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="opl-more-action" aria-label={`${number} buyurtma amallari`}><MoreHorizontal size={21} aria-hidden="true" /></button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="opl-row-menu rounded-xl border-border bg-card">
          <DropdownMenuItem className="min-h-11" onSelect={() => onOpen(order)}><ArrowUpRight size={16} aria-hidden="true" /> Batafsil ko‘rish</DropdownMenuItem>
          {onRepeat && <DropdownMenuItem className="min-h-11" onSelect={() => onRepeat(order)}><Repeat2 size={16} aria-hidden="true" /> Qayta buyurtma</DropdownMenuItem>}
          {order.creator_name && <><DropdownMenuSeparator /><DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal text-muted-foreground">
            Yaratdi: {order.creator_name}{order.creator_role ? ` (${order.creator_role})` : ''}
          </DropdownMenuLabel></>}
        </DropdownMenuContent>
      </DropdownMenu>
    </td>
  </tr>;
}

