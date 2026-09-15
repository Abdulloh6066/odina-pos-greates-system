import React from 'react';
import { AlertTriangle, Clock, Wallet, ChevronRight } from 'lucide-react';
import { formatUZS } from '@/lib/pos';

function Chip({ label, value }) {
  return <span className="opl-chip">{label}<strong>{value}</strong></span>;
}

function AlertRow({ alert, onOpen }) {
  const { order, deadline, unpaid } = alert;
  return <button type="button" onClick={() => onOpen(order)} className="opl-alert-row">
    <div className="opl-alert-info"><strong>{order.order_number} · {order.customer_name}</strong><span>{order.required_date} · {order.required_time}</span></div>
    <div className="opl-alert-tags">
      {deadline.kind === 'overdue' && <span className="opl-tag">Kechikdi</span>}
      {deadline.kind === 'due_soon' && <span className="opl-tag">1 soatdan kam qoldi</span>}
      {unpaid && <span className="opl-tag">Qolgan to‘lov: {formatUZS(order.remaining_balance)}</span>}
      <span>›</span>
    </div>
  </button>;
}

export default function OrderAlertSummary({ alerts, counts, onOpen, loading }) {
  if ((loading && !counts.total) || !counts.total) return null;
  return <div className="opl-alert-box">
    <div className="opl-alert-top"><div className="opl-alert-heading">Buyurtma ogohlantirishlari</div><div className="opl-chips">
      <Chip label="Kechikdi" value={counts.overdue} />
      <Chip label="1 soatdan kam" value={counts.due_soon} />
      <Chip label="Qolgan to‘lov" value={counts.unpaid} />
    </div></div>
    {alerts.map((alert) => <AlertRow key={alert.order.id} alert={alert} onOpen={onOpen} />)}
  </div>;
}