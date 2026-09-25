import React from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

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
export default function ScreenLaunchButton({ to, label, icon: Icon, active, onAfterOpen, blocked, onBlocked, onClear }) {
  const url = new URL(to, 'https://odinatort.uz').href;

  const handleOpen = (e) => {
    e.preventDefault();
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      onBlocked?.();
      return;
    }
    onAfterOpen?.();
  };

  if (blocked) {
    return (
      <div
        role="alert"
        className="odina-nav-child flex flex-col gap-2 min-h-11 px-3 py-3 rounded-xl bg-red-50 border border-red-200 text-red-900"
      >
        <span className="text-[12px] leading-snug font-medium">
          Brauzer yangi oynani blokladi. Iltimos, quyidagi havolaga bosing:
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl px-1 py-1.5 text-[13px] font-semibold text-brand-ink hover:underline"
        >
          <Icon className="w-4 h-4 shrink-0" strokeWidth={2} />
          <span className="min-w-0 break-words">{label}</span>
          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
        </a>
        <Button
          type="button"
          variant="outline"
          aria-label="Yopish"
          onClick={onClear}
          className="w-full min-h-11 h-11 border-red-200 text-red-700 hover:bg-red-100 hover:text-red-800"
        >
          Yopish
        </Button>
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