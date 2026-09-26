import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { startReceiptPrint } from '@/lib/receipt-print-lifecycle';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import { receiptWishForSale } from '@/lib/receipt-wishes';

export default function Receipt({ sale, settings, print, onAfterPrint }) {
  const onAfterPrintRef = useRef(onAfterPrint);

  useEffect(() => {
    onAfterPrintRef.current = onAfterPrint;
  }, [onAfterPrint]);

  useEffect(() => {
    if (!print || !sale) return undefined;
    return startReceiptPrint({ onDone: () => onAfterPrintRef.current?.(sale) });
  }, [print, sale]);

  if (!sale || !print) return null;

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
                <span className="truncate">{it.quantity}{it.sale_unit === 'gram' ? ' g' : '×'} {it.product_name}</span>
                <span className="shrink-0">{formatUZS(it.subtotal)}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-dashed border-border my-2" />
          <div className="flex justify-between"><span>Oraliq summa</span><span>{formatUZS(sale.subtotal)}</span></div>
          {sale.discount_amount > 0 && (
            <div className="flex justify-between"><span>{sale.discount_code === 'QAYTIB_BERISH' ? 'Qaytib berish' : sale.discount_code === 'YAXLITLASH' ? 'Yaxlitlash' : `Chegirma (${sale.discount_code || ''})`}</span><span>−{formatUZS(sale.discount_amount)}</span></div>
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

  return createPortal(
    <div className="receipt-print sale-receipt hidden font-mono text-[12px] leading-relaxed text-foreground">
      {receiptContent}
    </div>,
    document.body
  );
}