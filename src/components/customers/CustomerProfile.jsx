import { displayOrderNumber } from '@/lib/orders';
import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Phone, Cake, Wallet, Receipt, ClipboardList } from 'lucide-react';
import { fullName, formatPhone, birthdayDisplay, nextBirthdayInfo, normalizePhone } from '@/lib/customers';
import { formatUZS } from '@/lib/pos';
import { uzbekistanDateKey } from '@/lib/uzbekistan-time';

const ORDER_STATUS_LABELS = {
  qabul_qilindi: 'Qabul qilindi',
  tayyorlanmoqda: 'Tayyorlanmoqda',
  tayyor: 'Tayyor',
  yuborildi_olib_ketildi: 'Yuborildi',
  yakunlandi: 'Yakunlandi',
  bekor_qilindi: 'Bekor qilindi',
};

export default function CustomerProfile({ open, onClose, customer, onEdit, canEdit }) {
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState([]);
  const [sales, setSales] = useState([]);
  const [lifetime, setLifetime] = useState(0);

  useEffect(() => {
    if (!open || !customer?.id) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [linkedOrders, byPhoneOrders, linkedSales, byPhoneSales] = await Promise.all([
          base44.entities.CustomerOrder.filter({ customer_id: customer.id }, '-created_date', 200),
          customer.phone_normalized
            ? base44.entities.CustomerOrder.filter({ customer_phone: customer.phone }, '-created_date', 200)
            : Promise.resolve([]),
          base44.entities.Sale.filter({ customer_id: customer.id }, '-created_date', 200),
          customer.phone
            ? base44.entities.Sale.filter({ customer_phone_snapshot: customer.phone }, '-created_date', 200)
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const phoneNorm = customer.phone_normalized || normalizePhone(customer.phone);
        const orderMap = new Map();
        [...(linkedOrders || []), ...(byPhoneOrders || [])].forEach((o) => {
          const matches = o.customer_id === customer.id || normalizePhone(o.customer_phone) === phoneNorm;
          if (matches) orderMap.set(o.id, o);
        });
        const saleMap = new Map();
        [...(linkedSales || []), ...(byPhoneSales || [])].forEach((s) => {
          const matches = s.customer_id === customer.id || normalizePhone(s.customer_phone_snapshot) === phoneNorm;
          if (matches) saleMap.set(s.id, s);
        });
        const allOrders = Array.from(orderMap.values()).sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')));
        const allSales = Array.from(saleMap.values()).sort((a, b) => String(b.created_date || b.sold_at || '').localeCompare(String(a.created_date || a.sold_at || '')));
        setOrders(allOrders);
        setSales(allSales);
        const orderSpend = allOrders
          .filter((o) => o.order_status !== 'bekor_qilindi')
          .reduce((s, o) => s + Number(o.total || 0), 0);
        const saleSpend = allSales
          .filter((s) => s.status === 'completed')
          .reduce((s, s2) => s + Number(s2.total || 0), 0);
        setLifetime(orderSpend + saleSpend);
      } catch {
        if (!cancelled) { setOrders([]); setSales([]); setLifetime(0); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [open, customer?.id, customer?.phone, customer?.phone_normalized]);

  const bdInfo = customer ? nextBirthdayInfo(customer.birth_date) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="customer-profile-dialog max-w-2xl max-h-[92vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{customer ? fullName(customer) : 'Mijoz'}</DialogTitle>
          <DialogDescription>Mijoz profili va xarid tarixi</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : customer ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <InfoTile icon={<Phone className="w-4 h-4" />} label="Telefon" value={formatPhone(customer.phone)} />
              <InfoTile icon={<Cake className="w-4 h-4" />} label="Tug‘ilgan kun" value={birthdayDisplay(customer.birth_date) || '—'} highlight={bdInfo?.isToday || bdInfo?.isTomorrow} />
            </div>
            {customer.label && (
              <span className="customer-profile-label inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold">{customer.label}</span>
            )}
            {customer.notes && <p className="text-sm text-muted-foreground bg-secondary/40 rounded-xl px-3 py-2">{customer.notes}</p>}

            <div className="customer-profile-total rounded-2xl border p-4 flex items-center gap-3">
              <span className="customer-total-icon w-11 h-11 rounded-xl flex items-center justify-center shrink-0">
                <Wallet className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Jami sarflagan (shu kungacha)</div>
                <div className="font-display text-2xl font-bold text-brand-ink">{formatUZS(lifetime)}</div>
              </div>
            </div>

            {bdInfo && (bdInfo.isToday || bdInfo.isTomorrow) && (
              <div className="customer-birthday-notice rounded-xl border px-3 py-2 text-sm">
                {bdInfo.isToday ? '🎂 Bugun tug‘ilgan kun!' : '📅 Ertaga tug‘ilgan kun — eslatma yuboriladi.'}
              </div>
            )}

            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2"><ClipboardList className="w-4 h-4" /> Buyurtmalar ({orders.length})</h4>
              <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                {orders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Buyurtmalar topilmadi.</p>
                ) : orders.map((o) => (
                  <div key={o.id} className="flex items-center justify-between rounded-xl border border-border bg-card px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{displayOrderNumber(o)}</div>
                      <div className="text-xs text-muted-foreground">{uzbekistanDateKey(o.created_date || o.created_at)} · {ORDER_STATUS_LABELS[o.order_status] || o.order_status}</div>
                    </div>
                    <div className="text-sm font-semibold shrink-0">{formatUZS(o.total)}</div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2"><Receipt className="w-4 h-4" /> Kassa savdolari ({sales.length})</h4>
              <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                {sales.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Kassa savdolari topilmadi.</p>
                ) : sales.map((s) => (
                  <div key={s.id} className={`flex items-center justify-between rounded-xl border px-3 py-2 ${s.status === 'refunded' ? 'border-destructive/30 bg-destructive/5' : 'border-border bg-card'}`}>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.sale_number}</div>
                      <div className="text-xs text-muted-foreground">
                        {uzbekistanDateKey(s.sold_at || s.created_date)} · {s.status === 'completed' ? 'Yakunlandi' : 'Qaytarilgan'}
                        {s.sale_items_count ? ` · ${s.sale_items_count} ta` : ''}
                        {s.payment_methods_summary ? ` · ${s.payment_methods_summary}` : ''}
                      </div>
                    </div>
                    <div className={`text-sm font-semibold shrink-0 ${s.status === 'refunded' ? 'text-destructive line-through' : ''}`}>{formatUZS(s.total)}</div>
                  </div>
                ))}
              </div>
            </div>

            {canEdit && (
              <div className="flex justify-end pt-2 border-t border-border">
                <Button variant="outline" onClick={onEdit}>Tahrirlash</Button>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function InfoTile({ icon, label, value, highlight }) {
  return (
    <div className={`customer-profile-info rounded-xl border px-3 py-2.5 flex items-center gap-2.5 ${highlight ? 'is-highlighted' : ''}`}>
      <span className="w-9 h-9 rounded-lg bg-secondary text-foreground/70 flex items-center justify-center shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-medium truncate">{value}</div>
      </div>
    </div>
  );
}