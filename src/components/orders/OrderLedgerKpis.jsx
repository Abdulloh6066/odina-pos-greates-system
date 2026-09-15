import React from 'react';
import { formatUZS } from '@/lib/pos';

export default function OrderLedgerKpis({ orders }) {
  const today = new Date().toLocaleDateString('en-CA');
  const todays = orders.filter((order) => order.required_date === today);
  const pending = orders.filter((order) => !['yakunlandi', 'bekor_qilindi'].includes(order.order_status));
  const balance = orders.reduce((sum, order) => sum + Number(order.remaining_balance || 0), 0);
  const completed = todays.filter((order) => order.order_status === 'yakunlandi');
  const cards = [
    ['Bugungi buyurtmalar', todays.length, 'Bugungi navbat'],
    ['Kutilmoqda', pending.length, 'Ish jarayonida'],
    ['Qoldiq to‘lov', formatUZS(balance), 'Nazorat talab qiladi'],
    ['Yakunlangan', completed.length, 'Bugun'],
  ];
  return <section className="opl-kpis">{cards.map(([label, value, note]) => (
    <div className="opl-kpi" key={label}><div className="opl-kpi-label">{label}</div><div className="opl-kpi-value">{value}</div><div className="opl-kpi-note">{note}</div></div>
  ))}</section>;
}