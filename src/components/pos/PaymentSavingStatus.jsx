import React from 'react';
import { RefreshCw } from 'lucide-react';

export default function PaymentSavingStatus({ saving }) {
  if (!saving) return null;
  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      className="mx-3 sm:mx-5 mt-3 shrink-0 flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/10 px-4 py-3 text-brand-ink">
      <RefreshCw className="h-5 w-5 shrink-0 animate-spin" aria-hidden="true" />
      <div>
        <p className="text-sm font-semibold">Savdo saqlanmoqda…</p>
        <p className="text-xs text-muted-foreground">To‘lov va qoldiq tasdiqlanishini kuting.</p>
      </div>
    </div>
  );
}
