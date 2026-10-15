import React from 'react';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';

export default function CheckoutTimingStatus({ timing, pending, userRole, onOpenHistory }) {
  if (userRole !== 'admin') return null;
  const outcomes = {
    confirmed: ['Yakunlash', 'Savdo saqlandi.'],
    rechecked: ['Qayta tekshirish', 'Saqlangan savdo tasdiqlandi.'],
    queued: ['Qurilmaga saqlash', 'Server tasdig‘i kutilmoqda.'],
    unconfirmed: ['Yakunlash tasdiqlanmadi', 'Savdo holatini tekshiring.'],
  };
  const result = outcomes[timing?.outcome];
  const measured = !pending && result && Number.isFinite(timing?.totalMs);

  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      className="shrink-0 min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-card px-3 sm:px-6 py-2 text-xs sm:text-sm">
      {measured ? <>
        <span className="font-medium">{result[0]}:</span>
        <span className="font-semibold tabular-nums whitespace-nowrap">{(Math.max(0, timing.totalMs) / 1000).toFixed(1).replace('.', ',')} soniya</span>
        <span className="text-muted-foreground">{result[1]}</span>
        {timing.completedAt && <time dateTime={timing.completedAt} className="text-muted-foreground">
          Oxirgi urinish: {formatUzbekistanDateTime(timing.completedAt, { second: '2-digit' })}
        </time>}
        {timing.persisted === false && <span className="text-muted-foreground">Vaqt faqat shu oynada: qurilmaga saqlab bo‘lmadi.</span>}
      </> : <span className="text-muted-foreground">
        {pending ? 'Yakunlash vaqti o‘lchanmoqda…' : 'Yakunlashdan so‘ng vaqt shu yerda ko‘rinadi.'}
      </span>}
      {onOpenHistory && <button type="button" onClick={onOpenHistory}
        className="ml-auto min-h-9 rounded-lg border border-border px-3 py-1.5 font-medium touch-manipulation hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-olive">
        Xodimlar vaqti
      </button>}
    </div>
  );
}

