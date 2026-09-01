import React, { useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Printer } from 'lucide-react';
import { formatUZS } from '@/lib/pos';

export default function Receipt({ open, sale, settings, onClose }) {
  const ref = useRef(null);
  if (!sale) return null;

  const handlePrint = () => { window.print(); };

  const date = new Date(sale.created_date || sale.created_at || Date.now());
  const timeStr = date.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xs no-print">
        <DialogHeader>
          <DialogTitle className="font-display text-xl text-center">Sale Complete</DialogTitle>
        </DialogHeader>

        <div ref={ref} className="receipt-print font-mono text-[12px] leading-relaxed text-foreground">
          <div className="text-center">
            <div className="font-display text-lg font-bold">{settings?.shop_name || 'Odina Shop'}</div>
            <div className="text-[11px] text-muted-foreground">{sale.shop_name || ''}</div>
            <div className="text-[11px] text-muted-foreground">{timeStr}</div>
            <div className="text-[11px] text-muted-foreground">Receipt #{(sale.id || '').slice(-6).toUpperCase()}</div>
            <div className="text-[11px] text-muted-foreground">Cashier: {sale.user_name || ''}</div>
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
          <div className="flex justify-between"><span>Subtotal</span><span>{formatUZS(sale.subtotal)}</span></div>
          {sale.discount_amount > 0 && (
            <div className="flex justify-between"><span>Discount ({sale.discount_code})</span><span>−{formatUZS(sale.discount_amount)}</span></div>
          )}
          <div className="flex justify-between font-bold text-sm"><span>TOTAL</span><span>{formatUZS(sale.total)}</span></div>
          <div className="border-t border-dashed border-border my-2" />
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Payment</div>
          {sale.payments?.map((p, i) => (
            <div key={i} className="flex justify-between"><span className="capitalize">{p.method}</span><span>{formatUZS(p.amount)}</span></div>
          ))}
          <div className="border-t border-dashed border-border my-2" />
          <div className="text-center text-[12px] py-1">
            {settings?.thank_you_message || 'Rahmat! Sizning tabassumingiz biz uchun juda muhim ❤️'}
          </div>
        </div>

        <DialogFooter className="gap-2 no-print">
          <Button variant="outline" onClick={onClose} className="flex-1">New order</Button>
          <Button onClick={handlePrint} className="flex-1 bg-primary text-primary-foreground hover:bg-primary-strong">
            <Printer className="w-4 h-4 mr-1.5" /> Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}