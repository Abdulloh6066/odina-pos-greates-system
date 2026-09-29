import React, { useState } from 'react';
import { Button } from '@/components/ui/button';

// Keep confirmation inside the order card: no second modal or focus trap.
export default function TakeawayCancelAction({ ticketNumber, disabled, busy, error, onConfirm }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="w-full space-y-2">
      {confirming ? (
        <div className="rounded-xl border border-brand-sand/60 bg-brand-warm/10 p-3 space-y-3"
          role="group" aria-label={`Buyurtma #${ticketNumber}ni bekor qilish`}>
          <p className="text-sm font-semibold">Buyurtma #{ticketNumber} bekor qilinsinmi?</p>
          <p className="text-xs text-muted-foreground">Buyurtma ochiq ro‘yxatdan olinadi va tarixda saqlanadi. Pul tushumi yozilmaydi.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="min-h-11 flex-1"
              disabled={busy} onClick={() => setConfirming(false)}>Yo‘q, qolsin</Button>
            <Button type="button" className="min-h-11 flex-1"
              disabled={disabled || busy} onClick={onConfirm}>
              {busy ? 'Bekor qilinmoqda…' : 'Ha, bekor qilish'}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline"
          className="min-h-11 w-full text-destructive border-destructive/25 hover:bg-destructive/5"
          disabled={disabled || busy} onClick={() => setConfirming(true)}>Bekor qilish</Button>
      )}
      {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
    </div>
  );
}
