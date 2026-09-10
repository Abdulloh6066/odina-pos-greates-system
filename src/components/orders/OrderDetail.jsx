import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { formatUZS, PAYMENT_METHODS } from '@/lib/pos';
import { statusLabel, statusTone, typeLabel, payStatusLabel, payStatusTone, fulfilmentLabel } from '@/lib/orders';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';
import OrderPaymentDialog from '@/components/orders/OrderPaymentDialog';
import OrderCompleteDialog from '@/components/orders/OrderCompleteDialog';
import { useAuth } from '@/lib/AuthContext';
import { Calendar, Clock, Phone, MapPin, Store, User, CreditCard, Truck, PackageCheck, Repeat2 } from 'lucide-react';

export default function OrderDetail({ order, onClose, onPaid, onRepeat }) {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);

  useEffect(() => {
    if (!order) return;
    setLoading(true);
    Promise.all([
      base44.entities.CustomerOrderItem.filter({ order_id: order.id }),
      base44.entities.OrderPayment.filter({ order_id: order.id }),
    ]).then(([it, pm]) => {
      setItems(it || []);
      setPayments((pm || []).sort((a, b) => (a.paid_at < b.paid_at ? 1 : -1)));
    }).finally(() => setLoading(false));
  }, [order]);

  if (!order) return null;

  const methodLabel = (m) => PAYMENT_METHODS.find((p) => p.id === m)?.label || m;
  const refresh = async () => {
    const updated = await base44.entities.CustomerOrder.get(order.id);
    const pm = await base44.entities.OrderPayment.filter({ order_id: order.id });
    setPayments((pm || []).sort((a, b) => (a.paid_at < b.paid_at ? 1 : -1)));
    onPaid();
    if (onPaid.length) { /* parent reloads */ }
    // update local detail object
    Object.assign(order, updated);
    setItems([...items]);
  };

  return (
    <Dialog open={!!order} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span>{order.order_number}</span>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${statusTone(order.order_status)}`}>{statusLabel(order.order_status)}</span>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${payStatusTone(order.payment_status)}`}>{payStatusLabel(order.payment_status)}</span>
          </DialogTitle>
          <DialogDescription>{typeLabel(order.order_type)} · {fulfilmentLabel(order.fulfilment_type)}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-10"><div className="w-7 h-7 border-4 border-secondary border-t-primary rounded-full animate-spin" /></div>
        ) : (
          <div className="space-y-5 mt-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <Info icon={User} label="Mijoz" value={order.customer_name} />
              <Info icon={Phone} label="Telefon" value={order.customer_phone} />
              <Info icon={Calendar} label="Sana" value={order.required_date} />
              <Info icon={Clock} label="Vaqt" value={order.required_time} />
              <Info icon={Store} label="Do‘kon" value={order.shop_name_snapshot} />
              {order.fulfilment_type === 'delivery' && <Info icon={MapPin} label="Manzil" value={order.delivery_address || '—'} />}
              <Info icon={User} label="Yaratdi" value={`${order.creator_name} (${order.creator_role})`} />
            </div>

            <div>
              <h4 className="text-sm font-semibold mb-2">Mahsulotlar</h4>
              <div className="space-y-2">
                {items.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 border border-border rounded-xl p-2.5 bg-card">
                    <div className="w-10 h-10 rounded-lg overflow-hidden bg-secondary shrink-0 flex items-center justify-center">
                      {it.product_image_snapshot ? <Image src={it.product_image_snapshot} fittingType="fill" className="w-full h-full" /> : <span>{it.product_name_snapshot?.[0]}</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{it.product_name_snapshot}</div>
                      <div className="text-xs text-muted-foreground">
                        {it.category_name_snapshot} · {it.quantity} {it.unit_snapshot === 'sheet' ? 'varaq' : 'dona'}
                        {it.unit_snapshot === 'sheet' && it.event_pieces_per_sheet_snapshot ? ` (~${it.event_pieces_per_sheet_snapshot} dona)` : ''}
                        · {formatUZS(it.unit_price_snapshot)}
                      </div>
                      {it.customization_note && <div className="text-xs text-brand-olive mt-0.5">Izoh: {it.customization_note}</div>}
                    </div>
                    <div className="text-sm font-semibold shrink-0">{formatUZS(it.line_total)}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-secondary/40 rounded-xl p-4 text-sm space-y-1.5">
              <Row label="Mahsulotlar" value={formatUZS(order.subtotal)} />
              <Row label="Yetkazib berish" value={formatUZS(order.delivery_fee)} />
              {Number(order.adjustment_amount || 0) !== 0 && (
                <Row label={`Chegirma/Qo‘shimcha (${order.adjustment_reason || '—'})`} value={formatUZS(order.adjustment_amount)} />
              )}
              <div className="border-t border-border pt-1.5 flex justify-between font-bold text-base"><span>Jami</span><span>{formatUZS(order.total)}</span></div>
              <Row label="To‘langan" value={formatUZS(order.paid_amount)} />
              <div className="flex justify-between font-semibold"><span className="text-rose-600">Qoldi</span><span className="text-rose-600">{formatUZS(order.remaining_balance)}</span></div>
            </div>

            {order.notes && <div className="text-sm"><span className="text-muted-foreground">Izoh: </span>{order.notes}</div>}

            <div>
              <h4 className="text-sm font-semibold mb-2 flex items-center gap-2"><CreditCard className="w-4 h-4" /> To‘lovlar tarixi</h4>
              {payments.length === 0 ? (
                <p className="text-sm text-muted-foreground">To‘lovlar yo‘q.</p>
              ) : (
                <div className="relative pl-4 space-y-3 before:absolute before:left-1 before:top-1 before:bottom-1 before:w-px before:bg-border">
                  {payments.map((pm) => (
                    <div key={pm.id} className="relative">
                      <span className="absolute -left-[13px] top-1.5 w-2.5 h-2.5 rounded-full bg-brand-olive border-2 border-card" />
                      <div className="bg-card border border-border rounded-xl p-3">
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium">{methodLabel(pm.payment_method)} · {pm.payment_kind === 'advance' ? 'Avans' : pm.payment_kind === 'balance' ? 'Qoldiq' : 'Qo‘shimcha'}</span>
                          <span className="font-semibold">{formatUZS(pm.amount)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {new Date(pm.paid_at).toLocaleString('uz')} · {pm.employee_name}
                          {pm.shift_id ? ` · smena` : ' · smenasiz'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {(() => {
              const canComplete = (order.order_status === 'tayyor' || order.order_status === 'yuborildi_olib_ketildi')
                && order.order_status !== 'bekor_qilindi'
                && (user?.role === 'admin' || (user?.role === 'cashier' && user?.shop_id === order.shop_id));
              const canRepeat = user?.role === 'admin' || user?.role === 'cashier';
              const handoffLabel = order.fulfilment_type === 'delivery' ? 'Yuborildi' : 'Olib ketildi';
              const showPay = order.remaining_balance > 0 && order.order_status !== 'bekor_qilindi';
              if (!canComplete && !showPay && !canRepeat) return null;
              return (
                <div className="flex flex-wrap justify-end gap-2 sticky bottom-0 bg-card pt-3">
                  {canRepeat && (
                    <Button variant="outline" className="mr-auto" onClick={() => onRepeat(order, items)}>
                      <Repeat2 className="w-4 h-4" /> Qayta buyurtma
                    </Button>
                  )}
                  {showPay && <Button variant="outline" onClick={() => setPayOpen(true)}>To‘lov qo‘shish</Button>}
                  {canComplete && (
                    <Button onClick={() => setCompleteOpen(true)}>
                      {order.fulfilment_type === 'delivery' ? <Truck className="w-4 h-4" /> : <PackageCheck className="w-4 h-4" />}
                      {handoffLabel}
                    </Button>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </DialogContent>

      <OrderPaymentDialog open={payOpen} onClose={() => setPayOpen(false)} order={order} onDone={() => { setPayOpen(false); refresh(); }} />
      <OrderCompleteDialog open={completeOpen} onClose={() => setCompleteOpen(false)} order={order} onDone={() => { setCompleteOpen(false); refresh(); }} />
    </Dialog>
  );
}

const Info = ({ icon: Icon, label, value }) => (
  <div className="flex items-center gap-2">
    <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
    <span className="text-muted-foreground">{label}:</span>
    <span className="font-medium truncate">{value}</span>
  </div>
);
const Row = ({ label, value }) => (
  <div className="flex justify-between"><span className="text-muted-foreground">{label}</span><span>{value}</span></div>
);