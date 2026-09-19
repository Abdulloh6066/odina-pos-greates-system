import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Armchair, Clock, ShoppingBag, ArrowRight, CreditCard,
  Printer, AlertCircle, CheckCircle2
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import StaffOrderTicketModal from './StaffOrderTicketModal';

export default function TableDetailSheet({
  open,
  onClose,
  tableNumber,
  shop,
  onOpenPos,
  onPayDirect,
}) {
  const [loading, setLoading] = useState(false);
  const [tableOrder, setTableOrder] = useState(null);
  const [staffTicketOpen, setStaffTicketOpen] = useState(false);
  const [error, setError] = useState('');
  const printRef = useRef(null);

  useEffect(() => {
    if (!open || !shop?.id || !tableNumber) {
      setTableOrder(null);
      setError('');
      return;
    }

    let active = true;
    setLoading(true);
    setError('');

    base44.functions.invoke('restaurant-tables', {
      action: 'get_table_order',
      shop_id: shop.id,
      table_number: tableNumber,
    })
      .then((response) => {
        if (!active) return;
        const result = response?.data || response;
        if (result?.ok) {
          setTableOrder(result.order || null);
        } else {
          setError(result?.error || 'Stol buyurtmasini yuklab bo‘lmadi.');
        }
      })
      .catch((err) => {
        if (!active) return;
        setError(err?.response?.data?.error || err?.message || 'Buyurtmani yuklab bo‘lmadi.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open, shop?.id, tableNumber]);

  if (!open || !tableNumber) return null;

  const isOccupied = Boolean(tableOrder && tableOrder.state !== 'empty');
  const isPaying = tableOrder?.state === 'paying';
  const items = tableOrder?.items || [];
  const totalAmount = Number(tableOrder?.total || 0);

  const handlePrintPrecheck = () => {
    window.print();
  };

  return (
    <>
    <Dialog open={open && !staffTicketOpen} onOpenChange={(val) => !val && onClose()}>
      <DialogContent className="sm:max-w-md p-0 overflow-hidden rounded-[24px] border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-border bg-brand-surface flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border ${
              isOccupied
                ? isPaying
                  ? 'bg-amber-100 border-amber-300 text-amber-900'
                  : 'bg-[#FECD7C]/40 border-brand-olive text-brand-ink'
                : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            }`}>
              <Armchair className="w-6 h-6" />
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold tracking-wider uppercase text-brand-ink">
                {shop?.name || 'Do‘kon'} · Stol ma’lumoti
              </div>
              <DialogTitle className="font-display text-2xl font-bold flex items-center gap-2">
                {tableNumber}-stol
                <span className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border ${
                  isOccupied
                    ? isPaying
                      ? 'bg-amber-100 border-amber-300 text-amber-900'
                      : 'bg-[#FECD7C]/50 border-brand-olive text-foreground'
                    : 'bg-emerald-100 border-emerald-300 text-emerald-800'
                }`}>
                  {isOccupied ? (isPaying ? 'To‘lovda' : 'Band') : 'Bo‘sh'}
                </span>
              </DialogTitle>
              {tableOrder?.started_at && (
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <Clock className="w-3.5 h-3.5" />
                  Ochilgan vaqti: {formatUzbekistanDateTime(tableOrder.started_at)}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto scrollbar-thin">
          {error && (
            <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="space-y-3 py-6">
              <div className="h-6 bg-secondary rounded-lg animate-pulse w-1/3" />
              <div className="h-16 bg-secondary rounded-xl animate-pulse" />
              <div className="h-16 bg-secondary rounded-xl animate-pulse" />
            </div>
          ) : isOccupied ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <span>Buyurtma qilingan mahsulotlar ({items.reduce((s, i) => s + (i.quantity || 0), 0)} ta)</span>
                <span>Summa</span>
              </div>

              <div className="divide-y divide-border/60 border border-border rounded-2xl bg-background/60 overflow-hidden">
                {items.length === 0 ? (
                  <div className="p-4 text-center text-xs text-muted-foreground">
                    Mahsulotlar ro‘yxati bo‘sh.
                  </div>
                ) : (
                  items.map((item, idx) => (
                    <div key={item.product_id || idx} className="p-3 flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <div className="font-semibold text-foreground truncate">{item.product_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {item.quantity} × {formatUZS(item.price)}
                        </div>
                      </div>
                      <div className="font-bold tabular-nums text-brand-ink shrink-0">
                        {formatUZS(item.subtotal)}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Total Card */}
              <div className="rounded-2xl border border-brand-sand/60 bg-[#fbf6eb] p-4 flex items-center justify-between">
                <div>
                  <div className="text-xs text-muted-foreground font-medium">To‘lanishi kerak bo‘lgan summa</div>
                  <div className="text-2xl font-bold font-display text-brand-ink tabular-nums mt-0.5">
                    {formatUZS(totalAmount)}
                  </div>
                </div>
                {tableOrder?.revision > 1 && (
                  <span className="text-[10px] rounded-lg border border-border bg-card px-2 py-1 text-muted-foreground">
                    Tahrir #{tableOrder.revision}
                  </span>
                )}
              </div>

              {/* Printable Pre-check Section */}
              {createPortal(<div ref={printRef} className="receipt-print table-precheck font-mono text-[12px] leading-relaxed hidden">
                <div className="text-center space-y-1">
                  <div className="font-display text-lg font-bold">{shop?.name || 'Odina'}</div>
                  <div className="text-[11px] font-bold uppercase tracking-wider">HISOB VARAQASI (PRE-CHECK)</div>
                  <div className="text-sm font-bold">{tableNumber}-stol</div>
                  <div className="text-[10px] text-muted-foreground">{formatUzbekistanDateTime(Date.now())}</div>
                </div>
                <div className="border-t border-dashed border-border my-2" />
                <div className="space-y-1">
                  {items.map((it, i) => (
                    <div key={i} className="flex justify-between gap-2">
                      <span className="truncate">{it.quantity}× {it.product_name}</span>
                      <span className="shrink-0">{formatUZS(it.subtotal)}</span>
                    </div>
                  ))}
                </div>
                <div className="border-t border-dashed border-border my-2" />
                <div className="flex justify-between font-bold text-sm">
                  <span>JAMI TO‘LOV:</span>
                  <span>{formatUZS(totalAmount)}</span>
                </div>
                <div className="border-t border-dashed border-border my-2" />
                <div className="text-center text-[10px] pt-1 text-muted-foreground">
                  Xizmatingizdan mamnunmiz! Ushbu varaq to‘lov hujjati hisoblanmaydi.
                </div>
              </div>, document.body)}
            </div>
          ) : (
            <div className="py-8 text-center space-y-3">
              <div className="w-16 h-16 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center mx-auto border border-emerald-200">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <div>
                <h3 className="font-display text-lg font-semibold">Stol hozir bo‘sh</h3>
                <p className="text-xs text-muted-foreground max-w-xs mx-auto mt-1">
                  Mehmon kelganda Kassani ochib, mazkur stol uchun yangi buyurtma yozishni boshlang.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-border bg-card/50 flex flex-col gap-2">
          {isOccupied ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenPos(tableNumber);
                  }}
                  className="min-h-12 rounded-xl bg-card border-2 border-brand-olive text-brand-ink font-semibold hover:bg-brand-olive/15"
                >
                  <ShoppingBag className="w-4 h-4 mr-1.5" />
                  Kassada ochish
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    onClose();
                    onPayDirect(tableNumber);
                  }}
                  className="min-h-12 rounded-xl bg-primary text-primary-foreground font-bold hover:bg-primary-strong shadow-sm"
                >
                  <CreditCard className="w-4 h-4 mr-1.5" />
                  To‘lov qilish
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handlePrintPrecheck}
                  className="flex-1 min-h-11 rounded-xl text-xs font-semibold"
                >
                  <Printer className="w-4 h-4 mr-1.5" />
                  Hisob cheki (Pre-check)
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStaffTicketOpen(true)}
                  className="flex-1 min-h-11 rounded-xl text-xs font-semibold"
                >
                  <Printer className="w-4 h-4 mr-1.5" /> Xizmat cheki
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  className="min-h-11 rounded-xl text-xs"
                >
                  Yopish
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                className="min-h-12 rounded-xl flex-1 text-sm font-semibold"
              >
                Yopish
              </Button>
              <Button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenPos(tableNumber);
                }}
                className="min-h-12 rounded-xl bg-primary text-primary-foreground font-bold hover:bg-primary-strong flex-1 shadow-sm"
              >
                Buyurtma ochish <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
    <StaffOrderTicketModal open={open && staffTicketOpen} onClose={() => setStaffTicketOpen(false)}
      shop={shop} shopId={shop?.id} tableNumber={tableNumber} order={tableOrder} />
    </>
  );
}
