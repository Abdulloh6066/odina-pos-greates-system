import { displayOrderNumber } from '@/lib/orders';
import React, { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatUZS } from '@/lib/pos';

function Chip({ label, value }) {
  return <span className="opl-chip">{label}<strong>{value}</strong></span>;
}

function AlertRow({ alert, onOpen }) {
  const { order, deadline, unpaid } = alert;
  return <button type="button" onClick={() => onOpen(order)} className="opl-alert-row">
    <div className="opl-alert-info"><strong>{displayOrderNumber(order)} · {order.customer_name}</strong><span>{order.required_date} · {order.required_time}</span></div>
    <div className="opl-alert-tags">
      {deadline.kind === 'overdue' && <span className="opl-tag">Kechikdi</span>}
      {deadline.kind === 'due_soon' && <span className="opl-tag">1 soatdan kam qoldi</span>}
      {unpaid && <span className="opl-tag">Qolgan to‘lov: {formatUZS(order.remaining_balance)}</span>}
      <span>›</span>
    </div>
  </button>;
}

export default function OrderAlertSummary({ alerts, counts, onOpen, loading }) {
  const urgentCount = Number(counts.overdue || 0) + Number(counts.due_soon || 0);
  const [expanded, setExpanded] = useState(urgentCount > 0);
  useEffect(() => { if (urgentCount > 0) setExpanded(true); }, [urgentCount]);
  if ((loading && !counts.total) || !counts.total) return null;
  return <details className="opl-alert-box opl-alert-collapsible" open={expanded}
    onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="opl-alert-top">
      <span className="opl-alert-heading">Buyurtma ogohlantirishlari <span className="opl-tab-count">{counts.total}</span></span>
      <span className="opl-chips">
        {counts.overdue > 0 && <Chip label="Kechikdi" value={counts.overdue} />}
        {counts.due_soon > 0 && <Chip label="1 soatdan kam" value={counts.due_soon} />}
        {counts.unpaid > 0 && <Chip label="Qolgan to‘lov" value={counts.unpaid} />}
        <ChevronDown size={17} className="opl-alert-chevron" aria-hidden="true" />
      </span>
    </summary>
    {alerts.map((alert) => <AlertRow key={alert.order.id} alert={alert} onOpen={onOpen} />)}
  </details>;
}