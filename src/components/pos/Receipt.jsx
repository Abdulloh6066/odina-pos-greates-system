import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { startReceiptPrint } from '@/lib/receipt-print-lifecycle';
import { toast } from '@/components/ui/use-toast';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import odinaMark from '@/components/brand/odina-mark';
import { receiptWishForSale } from '@/lib/receipt-wishes';

export default function Receipt({ sale, settings, print, onAfterPrint }) {
  const onAfterPrintRef = useRef(onAfterPrint);

  useEffect(() => {
    onAfterPrintRef.current = onAfterPrint;
  }, [onAfterPrint]);

  useEffect(() => {
    if (!print || !sale) return undefined;
    return startReceiptPrint({
      onDone: () => onAfterPrintRef.current?.(sale),
      onWarning: (description) => toast({ title: 'Chekni tekshiring', description, variant: 'destructive' }),
    });
  }, [print, sale]);

  if (!sale || !print) return null;

  const timeStr = formatUzbekistanDateTime(sale.sold_at || sale.created_date || sale.created_at || Date.now());
  // Legacy shared footers may contain a different shop's Instagram or location.
  // Keep them for old receipts, but never print a conflicting shared social footer
  // beside a newly snapshotted shop-specific Instagram.
  const sharedFooter = settings?.receipt_footer || '';
  const showSharedFooter = !sale.receipt_instagram_snapshot || !/@[a-z0-9._]+/i.test(sharedFooter);

  const receiptContent = (
    <div className="font-mono text-[13.2px] leading-relaxed text-foreground">
          <div className="text-center">
            <img src={odinaMark} alt="Odina" width="72" height="72" style={{ display: 'block', margin: '0 auto 6px', objectFit: 'contain', filter: 'grayscale(1) contrast(2)' }} />
            <div className="font-display text-[19.8px] font-bold">{settings?.shop_name || 'Odina Shop'}</div>
            <div className="text-[12.1px] text-muted-foreground">{sale.shop_name || ''}</div>
            {sale.is_delivery === true && <div className="border-2 border-current rounded px-2 py-1 my-2 text-[16px] font-bold tracking-wide">DOSTAVKA</div>}
            {Number.isInteger(sale.table_number_snapshot) && sale.table_number_snapshot > 0 && (
              <div className="text-[13.2px] font-bold">Stol: {sale.table_number_snapshot}</div>
            )}
            <div className="text-[12.1px] text-muted-foreground">{timeStr}</div>
            <div className="text-[12.1px] text-muted-foreground">Chek #{sale.sale_number || (sale.id || '').slice(-6).toUpperCase()}</div>
            <div className="text-[12.1px] text-muted-foreground">Kassir: {sale.user_name || ''}</div>
          </div>
          <div className="border-t border-dashed border-border my-2" />
          <div className="space-y-1">
            {sale.items?.map((it, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span className="min-w-0 flex-1 break-words">{it.quantity}{it.sale_unit === 'gram' ? ' g' : '×'} {it.product_name}</span>
                <span className="shrink-0">{formatUZS(it.subtotal)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-dashed border-border my-2" />
          <div className="flex justify-between"><span>Oraliq summa</span><span>{formatUZS(sale.subtotal)}</span></div>
          {sale.discount_amount > 0 && (
            <div className="flex justify-between"><span>{sale.discount_code === 'QAYTIB_BERISH' ? 'Qaytib berish' : sale.discount_code === 'YAXLITLASH' ? 'Yaxlitlash' : `Chegirma (${sale.discount_code || ''})`}</span><span>−{formatUZS(sale.discount_amount)}</span></div>
          )}
          <div className="flex justify-between font-bold text-[15.4px]"><span>JAMI</span><span>{formatUZS(sale.total)}</span></div>
          <div className="border-t border-dashed border-border my-2" />
          <div className="text-[12.1px] uppercase tracking-wide text-muted-foreground mb-1">To‘lov</div>
          {sale.payments?.map((p, i) => (
            <div key={i} className="flex justify-between"><span className="capitalize">{p.method}</span><span>{formatUZS(p.amount)}</span></div>
          ))}
          <div className="border-t border-dashed border-border my-2" />
          <div className="text-center text-[13.2px] py-1">
            {settings?.thank_you_message || 'Sizning tabassumingiz biz uchun muhim! ❤️'}
          </div>
          <div className="text-center text-[13.2px] leading-relaxed px-1 py-1 font-semibold">
            {receiptWishForSale(sale)}
          </div>
          {(sale.receipt_instagram_snapshot || sale.receipt_phone_snapshot || sale.receipt_address_snapshot) && (
            <div className="border-t border-dashed border-border mt-2 pt-2 text-center text-[12.1px] leading-relaxed break-words">
              {sale.receipt_address_snapshot && <div>Manzil: {sale.receipt_address_snapshot}</div>}
              {sale.receipt_phone_snapshot && <div>Telefon: {sale.receipt_phone_snapshot}</div>}
              {sale.receipt_instagram_snapshot && <div>Instagram: @{String(sale.receipt_instagram_snapshot).replace(/^@/, '')}</div>}
            </div>
          )}
          {showSharedFooter && sharedFooter && <div className="text-center text-[11px] mt-1">{sharedFooter}</div>}
        </div>

  );

  return createPortal(
    <div className="receipt-print sale-receipt hidden font-mono text-[13.2px] leading-relaxed text-foreground">
      {receiptContent}
    </div>,
    document.body
  );
}