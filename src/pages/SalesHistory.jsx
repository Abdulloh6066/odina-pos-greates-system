import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert } from '@/lib/odina-dialog';
import { ReceiptText, Search, Eye, RotateCcw } from 'lucide-react';
import { formatUZS, formatNum, saleBusinessDate, saleOccurredAt } from '@/lib/pos';
import { formatUzbekistan, formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import PageHeader from '@/components/PageHeader';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RefundDialog } from '@/components/pos/KassaActionDialogs';
import StaffOrderTicketModal from '@/components/tables/StaffOrderTicketModal';

export default function SalesHistory({ embedded = false }) {
  const { user } = useOutletContext();
  const role = user?.role || 'cashier';
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [selected, setSelected] = useState(null);
  const [staffTicketSale, setStaffTicketSale] = useState(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundLoading, setRefundLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const all = await base44.entities.Sale.list('-created_date', 500);
      setSales(all || []);
    } catch (error) {
      setLoadError(error?.response?.data?.error || error?.message || 'Tarixni yuklab bo‘lmadi.');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    let list = sales;
    if (role === 'cashier') list = list.filter((s) => s.user_id === user?.id);
    if (filterDate) list = list.filter((s) => saleBusinessDate(s) === filterDate);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((s) => (s.user_name || '').toLowerCase().includes(q) || (s.payment_methods_summary || '').toLowerCase().includes(q));
    }
    return [...list].sort(
      (left, right) => new Date(saleOccurredAt(right)).getTime() - new Date(saleOccurredAt(left)).getTime(),
    );
  }, [sales, role, user, search, filterDate]);

  const totalRev = visible.reduce((s, x) => s + (x.status === 'refunded' ? 0 : x.total), 0);

  const refundSale = (sale) => {
    if (role !== 'admin') return;
    setSelected(sale);
    setRefundOpen(true);
  };

  const confirmRefund = async ({ reason, owner_pin }) => {
    if (!selected || role !== 'admin') return;
    setRefundLoading(true);
    try {
      const result = await base44.functions.invoke('complete-sale', {
        action: 'refund_sale',
        sale_id: selected.id,
        reason,
        owner_pin,
      });
      const payload = result?.data || result;
      if (!payload?.sale) throw new Error(payload?.error || 'Savdoni qaytarib bo‘lmadi.');
      setSelected(payload.sale);
      setRefundOpen(false);
      await load();
    } catch (e) {
      const message = e?.response?.data?.error || e?.data?.error || e?.message || String(e);
      void odinaAlert('Qaytarishda xato: ' + message);
    } finally {
      setRefundLoading(false);
    }
  };

  return (
    <div className={embedded ? 'min-w-0 space-y-4' : 'odina-page p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in'}>
      {embedded
        ? <p className="text-sm text-muted-foreground">{formatNum(visible.length)} ta savdo · {formatUZS(totalRev)}</p>
        : <PageHeader title="Savdolar tarixi" subtitle={`${formatNum(visible.length)} ta savdo · ${formatUZS(totalRev)}`} icon={ReceiptText} />}
      {loadError && <div role="alert" className="rounded-xl border border-destructive/30 p-3 text-sm text-destructive">
        {loadError} <Button variant="outline" onClick={load} disabled={loading}>Qayta urinish</Button>
      </div>

      <div className="odina-panel flex flex-col sm:flex-row gap-3 mb-5 rounded-2xl bg-card border border-border premium-shadow p-3 sm:p-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Kassir yoki to‘lov usuli bo‘yicha qidirish…" className="pl-9 h-11 rounded-xl" />
        </div>
        <Input type="date" value={filterDate} onChange={(e) => setFilterDate(e.target.value)} className="sm:w-48 h-11 rounded-xl" />
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-20 rounded-2xl bg-secondary animate-pulse" />)}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-5xl mb-3">🧾</div>
          <p className="text-sm text-muted-foreground">Savdo topilmadi.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((s) => (
            <button key={s.id} onClick={() => setSelected(s)} className="odina-panel w-full text-left rounded-2xl bg-card border border-border premium-shadow hover:premium-shadow-lg transition-all p-4 flex items-center gap-4">
              <div className="w-11 h-11 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center shrink-0">
                <Eye className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`font-semibold ${s.status === 'refunded' ? 'line-through text-muted-foreground' : ''}`}>{formatUZS(s.total)}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">{s.payment_methods_summary}</span>
                  {s.status === 'refunded' && <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-destructive">Qaytarilgan</span>}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {formatUzbekistan(saleOccurredAt(s), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}
                  {role !== 'cashier' && ` · ${s.user_name || ''}`}
                  {s.shop_name && ` · ${s.shop_name}`}
                  {Number.isInteger(s.table_number_snapshot) && s.table_number_snapshot > 0 && ` · ${s.table_number_snapshot}-stol`}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs text-muted-foreground">{s.items?.length || 0} ta mahsulot</div>
                {s.discount_amount > 0 && <div className="text-xs text-brand-ink">−{formatUZS(s.discount_amount)}</div>}
              </div>
            </button>
          ))}
        </div>
      )}

      <SaleDetailDialog sale={selected} canRefund={role === 'admin'} onRefund={refundSale}
        onStaffTicket={(sale) => { setSelected(null); setStaffTicketSale(sale); }} onClose={() => setSelected(null)} />
      <StaffOrderTicketModal open={!!staffTicketSale} mode="sale" order={staffTicketSale} forceReprint
        onClose={() => { setSelected(staffTicketSale); setStaffTicketSale(null); }} />
      <RefundDialog
        open={refundOpen}
        sale={selected}
        onClose={() => setRefundOpen(false)}
        onConfirm={confirmRefund}
        loading={refundLoading}
      />
    </div>
  );
}

function SaleDetailDialog({ sale, canRefund, onRefund, onStaffTicket, onClose }) {
  if (!sale) return null;
  return (
    <Dialog open={!!sale} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Savdo tafsilotlari</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground mb-3">
          {formatUzbekistanDateTime(saleOccurredAt(sale), { second: '2-digit' })}
          {sale.shop_name && ` · ${sale.shop_name}`}{Number.isInteger(sale.table_number_snapshot) && sale.table_number_snapshot > 0 && ` · ${sale.table_number_snapshot}-stol`} · Kassir: {sale.user_name}
        </div>
        <div className="space-y-2 mb-3">
          {sale.items?.map((it, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span>{it.quantity}× {it.product_name}</span>
              <span className="font-medium">{formatUZS(it.subtotal)}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-dashed border-border pt-3 space-y-1 text-sm">
          <Row label="Oraliq summa" value={formatUZS(sale.subtotal)} />
          {sale.discount_amount > 0 && <Row label={`Chegirma (${sale.discount_code})`} value={`−${formatUZS(sale.discount_amount)}`} accent />}
          <Row label="Jami" value={formatUZS(sale.total)} bold />
          <div className="pt-2 mt-2 border-t border-border">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">To‘lovlar</div>
            {sale.payments?.map((p, i) => <Row key={i} label={p.method} value={formatUZS(p.amount)} />)}
          </div>
        </div>
        {sale.status === 'refunded' && (
          <div className="rounded-xl bg-red-50 text-destructive p-3 text-sm">
            Qaytarilgan{sale.refund_reason ? `: ${sale.refund_reason}` : ''}
          </div>
        )}
        <div className="flex flex-wrap gap-2 mt-4">
          {sale.status !== 'refunded' && sale.items?.length > 0 && (
            <Button variant="outline" onClick={() => onStaffTicket(sale)} className="min-h-11 flex-1">
              <ReceiptText className="w-4 h-4 mr-1.5" /> Xizmat cheki
            </Button>
          )}
          {canRefund && sale.status === 'completed' && (
            <Button variant="destructive" onClick={() => onRefund(sale)} className="flex-1">
              <RotateCcw className="w-4 h-4 mr-1.5" /> Qaytarish
            </Button>
          )}
          <Button variant="outline" onClick={onClose} className="flex-1 min-h-11 rounded-xl">Yopish</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, bold, accent }) {
  return (
    <div className="flex justify-between">
      <span className={accent ? 'text-brand-ink' : 'text-muted-foreground'}>{label}</span>
      <span className={bold ? 'font-bold' : 'font-medium'}>{value}</span>
    </div>
  );
}