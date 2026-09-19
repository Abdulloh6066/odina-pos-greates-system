import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Loader2, Printer, UtensilsCrossed } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import { staffTicketFromSale, staffTicketFromCustomerOrder } from '@/lib/staff-order-ticket';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export default function StaffOrderTicketModal({
  open, onClose, shop, shopId, tableNumber, order, mode = 'table', orderItems, autoPrint = false,
}) {
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const autoPrintedRef = useRef(false);
  const effectiveShopId = shop?.id || shopId;

  useEffect(() => {
    if (!open) {
      setTicket(null);
      setError('');
      return;
    }
    let active = true;
    const showTicket = (value) => {
      if (!active) return;
      setTicket(value);
      setError('');
    };
    setLoading(false);
    setError('');

    if (mode === 'table') {
      // Fetch the saved server order: unsaved cart changes are never printed.
      setTicket(null);
      if (!effectiveShopId || !tableNumber) {
        setError('Stol tanlanmagan.');
        return;
      }
      setLoading(true);
      base44.functions.invoke('restaurant-tables', {
        action: 'get_table_order', shop_id: effectiveShopId, table_number: tableNumber,
      }).then((response) => {
        const result = response?.data || response;
        if (!result?.ok || !result.order) throw new Error(result?.error || 'Stol buyurtmasi topilmadi.');
        showTicket(result.order);
      }).catch((err) => {
        if (active) setError(err?.response?.data?.error || err?.message || 'Buyurtmani yuklab bo‘lmadi.');
      }).finally(() => { if (active) setLoading(false); });
    } else if (mode === 'customer') {
      setTicket(null);
      if (!order?.id) {
        setError('Buyurtma saqlanmagan.');
      } else if (orderItems?.length) {
        showTicket(staffTicketFromCustomerOrder(order, orderItems));
      } else {
        // Idempotent responses can contain the order without its saved items.
        setLoading(true);
        base44.entities.CustomerOrderItem.filter({ order_id: order.id })
          .then((items) => {
            if (!items?.length) throw new Error('Buyurtma mahsulotlari topilmadi.');
            showTicket(staffTicketFromCustomerOrder(order, items));
          }).catch((err) => {
            if (active) setError(err?.message || 'Mahsulotlarni yuklab bo‘lmadi.');
          }).finally(() => { if (active) setLoading(false); });
      }
    } else if (mode === 'sale') {
      showTicket(staffTicketFromSale(order));
    }
    return () => { active = false; };
  }, [open, mode, effectiveShopId, tableNumber, order, orderItems]);

  const items = ticket?.items || [];
  const displayTableNumber = tableNumber || ticket?.table_number;
  const source = displayTableNumber ? displayTableNumber + '-stol'
    : mode === 'customer' ? (ticket?.fulfilment_type === 'delivery' ? 'Yetkazib berish' : 'Olib ketish')
      : 'Oddiy buyurtma';
  const shopName = shop?.name || ticket?.shop_name || 'Odina';
  const units = new Set(items.map((item) => item.unit_label || 'ta'));
  const totalUnit = units.size === 1 ? [...units][0] : 'birlik';

  const printTicket = useCallback(() => {
    if (loading || error || !items.length) return;
    window.print();
  }, [loading, error, items.length]);

  useEffect(() => {
    if (!open) {
      autoPrintedRef.current = false;
      return;
    }
    if (!autoPrint || loading || error || !items.length || !ticket || autoPrintedRef.current) return;
    // Wait for the service-ticket portal to reach the DOM before opening the print dialog.
    const frame = window.requestAnimationFrame(() => {
      if (autoPrintedRef.current) return;
      autoPrintedRef.current = true;
      printTicket();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, autoPrint, loading, error, items.length, ticket, printTicket]);

  const body = items.length > 0 && ticket && (
    <div className="font-mono text-xs leading-snug text-zinc-950">
      <div className="border-b border-zinc-900 pb-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <span className="text-[11px] font-semibold">TURI</span>
          <strong className="min-w-0 text-right text-sm leading-tight">{source}</strong>
        </div>
        <div>
          <div className="text-[11px] font-semibold">BUYURTMA №</div>
          <strong className="block break-all text-xs leading-snug">#{ticket.number || displayTableNumber || '—'}</strong>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="shrink-0 text-[11px] font-semibold">VAQT</span>
          <span className="min-w-0 text-right">{formatUzbekistanDateTime(ticket.updated_at || ticket.started_at || Date.now())}</span>
        </div>
        {ticket.opened_by_name && (
          <div className="flex items-start justify-between gap-3">
            <span className="shrink-0 text-[11px] font-semibold">BUYURTMA OLUVCHI</span>
            <strong className="min-w-0 text-right break-words">{ticket.opened_by_name}</strong>
          </div>
        )}
      </div>
      <div className="py-3 text-[11px] font-bold tracking-wide">MAHSULOTLAR VA MIQDOR</div>
      <div>
        {items.map((item, index) => (
          <div key={index} className="flex items-start justify-between gap-3 border-b border-dashed border-zinc-400 py-2.5 break-inside-avoid">
            <span className="min-w-0 flex-1 break-words text-sm font-bold leading-tight">{item.product_name}</span>
            <strong className="shrink-0 border border-zinc-900 px-2 py-1 text-sm leading-none">{item.quantity} {item.unit_label || 'ta'}</strong>
          </div>
        ))}
      </div>
      <div className="border-t border-zinc-900 pt-3 mt-2 space-y-1">
        <div className="flex justify-between gap-3"><span>Mahsulot turlari</span><strong>{items.length} ta</strong></div>
        <div className="flex justify-between gap-3 text-sm font-black"><span>Jami miqdor</span><span>{items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)} {totalUnit}</span></div>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-md max-h-[92dvh] overflow-hidden flex flex-col bg-background p-0">
        <DialogTitle className="sr-only">Xizmat cheki (Oshxona)</DialogTitle>
        <DialogDescription className="sr-only">Xodimlar uchun mahsulotlar va buyurtma manzili.</DialogDescription>
        <div className="flex items-center gap-2.5 border-b border-border bg-card p-4">
          <UtensilsCrossed className="h-5 w-5 text-brand-ink" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="font-semibold">Xizmat cheki</h2>
            <p className="text-xs text-muted-foreground truncate">{source} · {shopName}</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6">
          {loading ? <div className="flex items-center justify-center gap-2 py-12"><Loader2 className="h-5 w-5 animate-spin" /> Yuklanmoqda…</div>
            : error ? <p role="alert" className="flex gap-2 text-destructive"><AlertCircle className="h-5 w-5" /> {error}</p>
              : body ? <div className="mx-auto max-w-[320px] rounded-xl border border-border bg-white p-4 shadow-sm">{body}</div>
                : <p className="py-8 text-center text-muted-foreground">Saqlangan mahsulotlar yo‘q.</p>}
        </div>
        {open && createPortal(
          <div className="receipt-print staff-order-ticket hidden">{body}</div>,
          document.body
        )}
        <div className="flex justify-end gap-2 border-t border-border bg-card p-4 no-print">
          <Button variant="outline" type="button" onClick={onClose} className="min-h-11">Yopish</Button>
          <Button type="button" onClick={printTicket} disabled={loading || !!error || !items.length}
            className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-strong">
            <Printer className="mr-2 h-4 w-4" /> Chop etish (80mm)
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
