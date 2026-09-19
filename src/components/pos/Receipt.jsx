import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Printer, ReceiptText } from 'lucide-react';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import { receiptWishForSale } from '@/lib/receipt-wishes';

export default function Receipt({ open, sale, settings, onClose, onStaffTicket }) {
  const afterPrintRef = useRef(null);
  const questionRef = useRef(null);
  const [askStaffTicket, setAskStaffTicket] = useState(false);
  const canOfferStaffTicket = Boolean(onStaffTicket && sale?.items?.length && !sale?.table_number_snapshot);

  useEffect(() => {
    if (open) return;
    setAskStaffTicket(false);
    if (afterPrintRef.current) window.removeEventListener('afterprint', afterPrintRef.current);
    afterPrintRef.current = null;
    document.body.classList.remove('odina-sale-printing');
  }, [open, sale?.id]);

  useEffect(() => {
    if (askStaffTicket) questionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [askStaffTicket]);

  useEffect(() => () => {
    if (afterPrintRef.current) window.removeEventListener('afterprint', afterPrintRef.current);
    document.body.classList.remove('odina-sale-printing');
  }, []);

  if (!sale) return null;

  const handlePrint = () => {
    if (afterPrintRef.current) return;
    setAskStaffTicket(false);
    const onAfterPrint = () => {
      if (afterPrintRef.current !== onAfterPrint) return;
      afterPrintRef.current = null;
      document.body.classList.remove('odina-sale-printing');
      if (canOfferStaffTicket) setAskStaffTicket(true);
    };
    afterPrintRef.current = onAfterPrint;
    window.addEventListener('afterprint', onAfterPrint, { once: true });
    document.body.classList.add('odina-sale-printing');
    try {
      window.print();
    } catch {
      window.removeEventListener('afterprint', onAfterPrint);
      afterPrintRef.current = null;
      document.body.classList.remove('odina-sale-printing');
    }
  };

  const timeStr = formatUzbekistanDateTime(sale.sold_at || sale.created_date || sale.created_at || Date.now());
  // Legacy shared footers may contain a different shop's Instagram or location.
  // Keep them for old receipts, but never print a conflicting shared social footer
  // beside a newly snapshotted shop-specific Instagram.
  const sharedFooter = settings?.receipt_footer || '';
  const showSharedFooter = !sale.receipt_instagram_snapshot || !/@[a-z0-9._]+/i.test(sharedFooter);

  const receiptContent = (
    <div className="font-mono text-[12px] leading-relaxed text-foreground">
          <div className="text-center">
            <div className="font-display text-lg font-bold">{settings?.shop_name || 'Odina Shop'}</div>
            <div className="text-[11px] text-muted-foreground">{sale.shop_name || ''}</div>
            {Number.isInteger(sale.table_number_snapshot) && sale.table_number_snapshot > 0 && (
              <div className="text-[12px] font-bold">Stol: {sale.table_number_snapshot}</div>
            )}
            <div className="text-[11px] text-muted-foreground">{timeStr}</div>
            <div className="text-[11px] text-muted-foreground">Chek #{sale.sale_number || (sale.id || '').slice(-6).toUpperCase()}</div>
            <div className="text-[11px] text-muted-foreground">Kassir: {sale.user_name || ''}</div>
          </div>
          <div className="border-t border-dashed border-border my-2" />
          <div className="space-y-1">
            {sale.items?.map((it, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span className="truncate">{it.quantity}× {it.product_name}</span>
                <span className="shrink-0">{formatUZS(it.subtotal)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-dashed border-border my-2" />
          <div className="flex justify-between"><span>Oraliq summa</span><span>{formatUZS(sale.subtotal)}</span></div>
          {sale.discount_amount > 0 && (
            <div className="flex justify-between"><span>Chegirma ({sale.discount_code})</span><span>−{formatUZS(sale.discount_amount)}</span></div>
          )}
          <div className="flex justify-between font-bold text-sm"><span>JAMI</span><span>{formatUZS(sale.total)}</span></div>
          <div className="border-t border-dashed border-border my-2" />
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">To‘lov</div>
          {sale.payments?.map((p, i) => (
            <div key={i} className="flex justify-between"><span className="capitalize">{p.method}</span><span>{formatUZS(p.amount)}</span></div>
          ))}
          <div className="border-t border-dashed border-border my-2" />
          <div className="text-center text-[12px] py-1">
            {settings?.thank_you_message || 'Rahmat! Sizning tabassumingiz biz uchun juda muhim ❤️'}
          </div>
          <div className="text-center text-[12px] leading-relaxed px-1 py-1 font-semibold">
            {receiptWishForSale(sale)}
          </div>
          {(sale.receipt_instagram_snapshot || sale.receipt_phone_snapshot || sale.receipt_address_snapshot) && (
            <div className="border-t border-dashed border-border mt-2 pt-2 text-center text-[11px] leading-relaxed break-words">
              {sale.receipt_address_snapshot && <div>Manzil: {sale.receipt_address_snapshot}</div>}
              {sale.receipt_phone_snapshot && <div>Telefon: {sale.receipt_phone_snapshot}</div>}
              {sale.receipt_instagram_snapshot && <div>Instagram: @{String(sale.receipt_instagram_snapshot).replace(/^@/, '')}</div>}
            </div>
          )}
          {showSharedFooter && sharedFooter && <div className="text-center text-[10px] mt-1">{sharedFooter}</div>}
        </div>

  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xs max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl text-center">
            {sale.offline_pending ? 'Savdo qurilmaga saqlandi' : 'Savdo yakunlandi'}
          </DialogTitle>
        </DialogHeader>

        {sale.offline_pending && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 mb-3 text-center text-xs text-amber-900">
            Internet kelganda bu savdo avtomatik ravishda serverga yuboriladi.
          </div>
        )}

        <div className="receipt-preview">{receiptContent}</div>
        {open && createPortal(
          <div className="receipt-print sale-receipt hidden font-mono text-[12px] leading-relaxed text-foreground">
            {receiptContent}
          </div>,
          document.body
        )}
        {askStaffTicket && canOfferStaffTicket && (
          <div ref={questionRef} role="group" aria-label="Xizmat cheki kerakmi?"
            className="no-print rounded-xl border border-brand-olive/40 bg-brand-olive/10 p-3 space-y-2">
            <p className="text-sm font-semibold">Olib ketish buyurtmasi uchun xizmat cheki kerakmi?</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setAskStaffTicket(false)}
                className="min-h-11 flex-1">Yo‘q</Button>
              <Button type="button" onClick={() => { setAskStaffTicket(false); onStaffTicket(sale); }}
                className="min-h-11 flex-1 bg-primary text-primary-foreground hover:bg-primary-strong">
                Ha, ochish
              </Button>
            </div>
          </div>
        )}

        <DialogFooter className="flex flex-wrap gap-2 no-print">
          <Button variant="outline" onClick={onClose} className="flex-1 min-w-[120px]">Yangi buyurtma</Button>
          {canOfferStaffTicket && (
            <Button variant="outline" onClick={() => onStaffTicket(sale)} className="flex-1 min-w-[120px]">
              <ReceiptText className="w-4 h-4 mr-1.5" /> Xizmat cheki
            </Button>
          )}
          <Button onClick={handlePrint} className="flex-1 min-w-[120px] bg-primary text-primary-foreground hover:bg-primary-strong">
            <Printer className="w-4 h-4 mr-1.5" /> Chop etish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}