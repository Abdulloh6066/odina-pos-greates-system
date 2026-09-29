import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Printer, AlertCircle, Loader2, UtensilsCrossed, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { staffTicketFromSale, staffTicketFromCustomerOrder } from '@/lib/staff-order-ticket';
import { startReceiptPrint } from '@/lib/receipt-print-lifecycle';
import { toast } from '@/components/ui/use-toast';

function getTicketPrintCount(orderId, revision) {
  if (!orderId || typeof window === 'undefined') return 0;
  try {
    const raw = sessionStorage.getItem(`odina_staff_ticket_${orderId}_r${revision || 1}`);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function incrementTicketPrintCount(orderId, revision) {
  if (!orderId || typeof window === 'undefined') return 1;
  try {
    const current = getTicketPrintCount(orderId, revision);
    sessionStorage.setItem(`odina_staff_ticket_${orderId}_r${revision || 1}`, String(current + 1));
    return current + 1;
  } catch {
    return 1;
  }
}

export default function StaffOrderTicketModal({
  open,
  onClose,
  shop,
  shopId,
  tableNumber,
  order: initialOrder = null,
  mode = 'table',
  orderItems,
  autoPrint = true,
}) {
  const [ticketOrder, setTicketOrder] = useState(initialOrder);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [localPrintCount, setLocalPrintCount] = useState(0);
  const printRef = useRef(null);

  const effectiveShopId = shop?.id || shopId || initialOrder?.shop_id;
  const effectiveShopName = shop?.name || ticketOrder?.shop_name || 'Odina';

  // Only print data loaded for this exact opening/order. A previous ticket may
  // still be in React state while the next order is being fetched.
  const [loadedRequest, setLoadedRequest] = useState(null);
  const [printRequested, setPrintRequested] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    let active = true;
    setLoadedRequest(null);
    setPrintRequested(false);
    setError('');
    if (!open) {
      setLocalPrintCount(0);
      return;
    }
    setLoading(true);
    const loadTicket = async () => {
      if (mode === 'table' || mode === 'takeaway') {
        if (mode === 'table' && (!effectiveShopId || !tableNumber)) {
          if (initialOrder) return initialOrder;
          throw new Error('Stol tanlanmagan.');
        }
        if (mode === 'takeaway' && (!initialOrder?.id || !effectiveShopId)) {
          throw new Error('Buyurtma yoki do‘kon topilmadi.');
        }
        const response = await base44.functions.invoke('restaurant-tables', {
          action: mode === 'table' ? 'get_table_order' : 'get_takeaway_order',
          shop_id: effectiveShopId,
          ...(mode === 'table' ? { table_number: tableNumber } : { order_id: initialOrder.id }),
        });
        const result = response?.data || response;
        if (!result?.ok || !result.order) {
          throw new Error(result?.error || 'Buyurtma yopilgan yoki topilmadi. Buyurtmalarni yangilang.');
        }
        return result.order;
      }
      if (mode === 'customer') {
        if (!initialOrder?.id) throw new Error('Buyurtma saqlanmagan.');
        const savedItems = orderItems?.length ? orderItems
          : await base44.entities.CustomerOrderItem.filter({ order_id: initialOrder.id });
        if (!savedItems?.length) throw new Error('Buyurtma mahsulotlari topilmadi.');
        return staffTicketFromCustomerOrder(initialOrder, savedItems);
      }
      return staffTicketFromSale(initialOrder);
    };
    loadTicket().then((order) => {
      if (!active) return;
      setTicketOrder(order);
      setLocalPrintCount(getTicketPrintCount(order?.id, order?.revision));
      setLoadedRequest({ initialOrder, mode, effectiveShopId, tableNumber, orderItems });
    }).catch((err) => {
      if (active) setError(err?.response?.data?.error || err?.message || 'Buyurtmani yuklab bo‘lmadi.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, mode, effectiveShopId, tableNumber, initialOrder, orderItems]);

  const ticketReady = Boolean(loadedRequest
    && loadedRequest.initialOrder === initialOrder
    && loadedRequest.mode === mode
    && loadedRequest.effectiveShopId === effectiveShopId
    && loadedRequest.tableNumber === tableNumber
    && loadedRequest.orderItems === orderItems);

  const items = ticketOrder?.items || [];
  const displayTableNumber = tableNumber || ticketOrder?.table_number;
  const source = displayTableNumber
    ? `${displayTableNumber}-stol`
    : mode === 'customer'
      ? (ticketOrder?.fulfilment_type === 'delivery' ? 'Yetkazib berish' : 'Olib ketish')
      : 'Olib ketish';
  const orderTime = ticketOrder?.updated_at || ticketOrder?.started_at || Date.now();
  const revision = ticketOrder?.revision || 1;
  const orderId = ticketOrder?.id;

  const isReprint = Boolean(
    (revision > 1) ||
    localPrintCount > 0 ||
    (orderId && getTicketPrintCount(orderId, revision) > 0)
  );

  const handlePrint = () => {
    if (ticketReady && !loading && !error && items.length) setPrintRequested(true);
  };

  useEffect(() => {
    if (!open || !ticketReady || (!autoPrint && !printRequested)
      || loading || error || !items.length) return undefined;
    return startReceiptPrint({
      printClass: 'odina-staff-printing',
      warningMessage: 'Xizmat cheki chiqmagan bo‘lsa, “Xizmat cheki” tugmasidan qayta chop eting.',
      onWarning: (description) => toast({ title: 'Chekni tekshiring', description, variant: 'destructive' }),
      onDone: () => {
        if (orderId) incrementTicketPrintCount(orderId, revision);
        onCloseRef.current?.();
      },
    });
  }, [open, ticketReady, autoPrint, printRequested, loading, error, ticketOrder, items.length, orderId, revision]);

  // One shared, plain black-on-white layout for the screen preview and 80mm print.
  // Identifiers and table labels come from the actual order, never sample text.
  const displayOrderNumber = ticketOrder?.ticket_number ?? ticketOrder?.number
    ?? displayTableNumber ?? ticketOrder?.id ?? '—';
  const renderTicketContent = (isPrint = false) => (
    <div className={isPrint
      ? 'w-full min-w-0 bg-white text-black font-sans leading-snug'
      : 'w-full max-w-[440px] min-w-0 bg-white text-black px-2 py-3 sm:px-3 font-sans leading-snug select-text'}>
      {/* The reference has no large reprint banner obscuring the order number. */}
      <div className="flex items-start justify-between gap-3">
        <span className={`min-w-0 font-black tracking-tight text-black break-words ${isPrint ? 'text-[16.5px]' : 'text-lg sm:text-xl'}`}>
          BUYURTMA № #{String(displayOrderNumber).replace(/^#/, '')}
        </span>
        <span className={`shrink-0 text-right font-black tracking-tight text-black ${isPrint ? 'text-[16.5px]' : 'text-lg sm:text-xl'}`}>
          {source}
        </span>
      </div>

      <div className={`border-b-2 border-black ${isPrint ? 'my-2' : 'my-3'}`} />

      {mode === 'takeaway' && <p className={`${isPrint ? 'text-[13.2px]' : 'text-xs'} font-black mb-2`}>TO‘LANMAGAN</p>}
      {/* Row 2 & 3: Metadata */}
      <div className={`space-y-1.5 text-black ${isPrint ? 'text-[12.1px]' : 'text-sm'}`}>
        <div className="flex justify-between items-baseline gap-3">
          <span className="shrink-0 font-black tracking-wide">VAQT</span>
          <span className="min-w-0 text-right font-medium tabular-nums">{formatUzbekistanDateTime(orderTime)}</span>
        </div>
        {Boolean(ticketOrder?.opened_by_name) && (
          <div className="flex justify-between items-baseline gap-3">
            <span className="shrink-0 font-black tracking-wide">BUYURTMA OLUVCHI</span>
            <span className="min-w-0 text-right font-black break-words">{ticketOrder.opened_by_name}</span>
          </div>
        )}
        {Boolean(ticketOrder?.customer_name) && (
          <div className="flex justify-between items-center">
            <span className="font-black tracking-wider">MIJOZ</span>
            <span className="font-black">{ticketOrder.customer_name}</span>
          </div>
        )}
        {Boolean(ticketOrder?.delivery_address) && (
          <div className="flex justify-between items-start pt-0.5">
            <span className="font-black tracking-wider shrink-0 mr-2">MANZIL</span>
            <span className="font-medium text-right break-words">{ticketOrder.delivery_address}</span>
          </div>
        )}
        {Boolean(ticketOrder?.notes) && (
          <div className="flex justify-between items-start pt-0.5">
            <span className="font-black tracking-wider shrink-0 mr-2">ESLATMA</span>
            <span className="italic text-right break-words">{ticketOrder.notes}</span>
          </div>
        )}
      </div>

      {/* Solid divider line */}
      <div className={`border-b-2 border-black ${isPrint ? 'my-2' : 'my-3'}`} />

      {/* Items Section */}
      <div className={`pt-0.5 ${isPrint ? 'space-y-2' : 'space-y-3'}`}>
        {items.map((item, idx) => (
          <div key={idx}>
            <div className="flex justify-between items-baseline gap-3">
              <span className={`min-w-0 font-black text-black uppercase break-words flex-1 leading-snug ${isPrint ? 'text-[14.3px]' : 'text-lg'}`}>
                {item.product_name}
              </span>
              <span className={`font-black text-black tabular-nums shrink-0 ${isPrint ? 'text-[16.5px]' : 'text-xl'}`}>
                {item.quantity}{item.sale_unit === 'gram' ? ' g' : ''}
              </span>
            </div>
            {Boolean(item.variant_name) && (
              <div className={`font-bold mt-0.5 ${isPrint ? 'text-[11px]' : 'text-xs text-zinc-700'}`}>
                Variant: {item.variant_name}
              </div>
            )}
            {Boolean(item.notes) && (
              <div className={`italic mt-0.5 ${isPrint ? 'text-[11px]' : 'text-xs text-zinc-700'}`}>
                Eslatma: {item.notes}
              </div>
            )}
            {idx < items.length - 1 && (
              <div className={`border-b border-dashed border-black ${isPrint ? 'my-1.5' : 'my-2'}`} />
            )}
          </div>
        ))}
      </div>
      {/* Retain reprint traceability without the oversized boxed banner. */}
      {isReprint && <p className={`text-right font-semibold text-black ${isPrint ? 'mt-2 text-[9.9px]' : 'mt-3 text-[10px]'}`}>
        Qayta chop · {revision}-tahrir
      </p>}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg p-0 overflow-hidden bg-background border-border shadow-2xl rounded-2xl flex flex-col max-h-[92vh]">
        <DialogTitle className="sr-only">Xizmat cheki (Oshxona)</DialogTitle>
        <DialogDescription className="sr-only">
          Oshxona va xizmat xodimlari uchun buyurtma varaqasi.
        </DialogDescription>

        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-border bg-card/60 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-brand-olive/15 text-brand-ink flex items-center justify-center font-bold">
              <UtensilsCrossed className="w-5 h-5 text-brand-ink" />
            </div>
            <div>
              <h2 className="font-display font-bold text-base text-foreground leading-tight">
                Xizmat cheki (Oshxona)
              </h2>
              <p className="text-xs text-muted-foreground">
                {source} · {effectiveShopName}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Yopish"
            className="h-9 w-9 rounded-xl text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Modal Content / Preview Area */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 bg-white flex flex-col items-center">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="w-7 h-7 animate-spin text-brand-olive" />
              <p className="text-sm">Buyurtma cheki tayyorlanmoqda…</p>
            </div>
          ) : error ? (
            <div className="py-8 px-4 text-center max-w-xs space-y-3">
              <AlertCircle className="w-8 h-8 text-destructive mx-auto" />
              <p className="text-sm text-destructive font-medium">{error}</p>
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 px-4 text-center max-w-xs space-y-2 text-muted-foreground">
              <p className="text-sm font-medium">Bu buyurtmada saqlangan mahsulotlar yo‘q.</p>
            </div>
          ) : (
            renderTicketContent(false)
          )}

          {/* Printable Thermal Receipt (Hidden on Screen, Visible on Print) */}
          {open && typeof document !== 'undefined' && createPortal(
            <div
              ref={printRef}
              className="receipt-print staff-order-ticket font-sans text-[14.3px] leading-relaxed hidden text-black"
            >
              {renderTicketContent(true)}
            </div>,
            document.body
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-border bg-card/60 flex items-center justify-end gap-2 no-print">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="min-h-11 rounded-xl text-xs font-semibold px-4"
          >
            Yopish
          </Button>
          <Button
            type="button"
            onClick={handlePrint}
            disabled={!ticketReady || loading || Boolean(error) || items.length === 0 || autoPrint || printRequested}
            className="min-h-11 rounded-xl bg-primary text-primary-foreground font-bold hover:bg-primary-strong shadow-sm px-5"
          >
            <Printer className="w-4 h-4 mr-1.5" />
            Chop etish (80mm)
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
