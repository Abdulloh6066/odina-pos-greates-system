import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Opens an existing app route in a new browser tab without navigating the
 * current tab away. The window.open() call runs synchronously inside the
 * click handler so popup blockers treat it as user-initiated. If the browser
 * still blocks it, a clear Uzbek message with a clickable fallback link is
 * shown instead.
 *
 * No global screen selection is stored: each tab keeps its own route, so
 * Kassa, Ombor and Ishlab chiqarish can stay open in separate tabs at once.
 */
export default function ScreenLaunchButton({ to, label, icon: Icon, active, onAfterOpen }) {
  const [blocked, setBlocked] = useState(false);
  const url = `${window.location.origin}${to}`;

  const handleOpen = (e) => {
    e.preventDefault();
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      setBlocked(true);
      return;
    }
    onAfterOpen?.();
  };

  if (blocked) {
    return (
      <div className="odina-nav-child flex flex-col gap-1.5 min-h-11 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-900">
        <span className="text-[12px] leading-snug font-medium">
          Brauzer yangi oynani blokladi. Iltimos, quyidagi havolaga bosing:
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-[13px] font-semibold text-brand-ink hover:underline"
        >
          <Icon className="w-4 h-4 shrink-0" strokeWidth={2} />
          <span className="min-w-0 break-words">{label}</span>
          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
        </a>
        <button
          type="button"
          onClick={() => setBlocked(false)}
          className="self-start text-[12px] font-medium text-red-700 hover:underline"
        >
          Yopish
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      aria-label={label}
      className={cn(
        'odina-nav-child w-full flex items-center gap-2.5 min-h-11 px-3 py-2 rounded-xl text-[13px] leading-snug font-medium transition-colors touch-manipulation',
        active ? 'bg-primary/25 text-brand-ink' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      )}
    >
      <Icon className="w-4 h-4 shrink-0" strokeWidth={2} />
      <span className="min-w-0 flex-1 break-words text-left">{label}</span>
      <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-60" />
    </button>
  );
}