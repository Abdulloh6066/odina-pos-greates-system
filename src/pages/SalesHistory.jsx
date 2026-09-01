import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { ReceiptText, Search, Eye } from 'lucide-react';
import { formatUZS, formatNum, isSameDay } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export default function SalesHistory() {
  const { user } = useOutletContext();
  const role = user?.role || 'cashier';
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [selected, setSelected] = useState(null);

  const load = async () => {
    setLoading(true);
    const all = await base44.entities.Sale.list('-created_date', 500);
    setSales(all || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    let list = sales;
    if (role === 'cashier') list = list.filter((s) => s.user_id === user?.id);
    if (filterDate) list = list.filter((s) => isSameDay(s.created_date, new Date(filterDate)));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((s) => (s.user_name || '').toLowerCase().includes(q) || (s.payment_methods_summary || '').toLowerCase().includes(q));
    }
    return list;
  }, [sales, role, user, search, filterDate]);

  const totalRev = visible.reduce((s, x) => s + x.total, 0);

  return (
    <div className="p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader title="Sales History" subtitle={`${formatNum(visible.length)} sales · ${formatUZS(totalRev)}`} icon={ReceiptText} />

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by cashier or payment…" className="pl-9" />
        </div>
        <Input type="date" value={filterDate} onChange={(e) => setFilterDate(e.target.value)} className="sm:w-48" />
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-20 rounded-2xl bg-secondary animate-pulse" />)}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-5xl mb-3">🧾</div>
          <p className="text-sm text-muted-foreground">No sales found.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((s) => (
            <button key={s.id} onClick={() => setSelected(s)} className="w-full text-left rounded-2xl bg-card border border-border premium-shadow hover:premium-shadow-lg transition-all p-4 flex items-center gap-4">
              <div className="w-11 h-11 rounded-xl bg-primary/15 text-primary-strong flex items-center justify-center shrink-0">
                <Eye className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{formatUZS(s.total)}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">{s.payment_methods_summary}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {new Date(s.created_date).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {role !== 'cashier' && ` · ${s.user_name || ''}`}
                  {s.shop_name && ` · ${s.shop_name}`}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-xs text-muted-foreground">{s.items?.length || 0} items</div>
                {s.discount_amount > 0 && <div className="text-xs text-primary-strong">−{formatUZS(s.discount_amount)}</div>}
              </div>
            </button>
          ))}
        </div>
      )}

      <SaleDetailDialog sale={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function SaleDetailDialog({ sale, onClose }) {
  if (!sale) return null;
  return (
    <Dialog open={!!sale} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Sale details</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground mb-3">
          {new Date(sale.created_date).toLocaleString('en-GB')}
          {sale.shop_name && ` · ${sale.shop_name}`} · Cashier: {sale.user_name}
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
          <Row label="Subtotal" value={formatUZS(sale.subtotal)} />
          {sale.discount_amount > 0 && <Row label={`Discount (${sale.discount_code})`} value={`−${formatUZS(sale.discount_amount)}`} accent />}
          <Row label="Total" value={formatUZS(sale.total)} bold />
          <div className="pt-2 mt-2 border-t border-border">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Payments</div>
            {sale.payments?.map((p, i) => <Row key={i} label={p.method} value={formatUZS(p.amount)} />)}
          </div>
        </div>
        <Button variant="outline" onClick={onClose} className="mt-4 w-full">Close</Button>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, bold, accent }) {
  return (
    <div className="flex justify-between">
      <span className={accent ? 'text-primary-strong' : 'text-muted-foreground'}>{label}</span>
      <span className={bold ? 'font-bold' : 'font-medium'}>{value}</span>
    </div>
  );
}