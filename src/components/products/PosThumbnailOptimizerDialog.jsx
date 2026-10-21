import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

export default function PosThumbnailOptimizerDialog({ open, running, summary, error, queue, onStart, onClose }) {
  const total = summary?.total ?? queue.queue.length;
  const done = summary?.done.length ?? 0;
  const failed = summary?.failed.length ?? 0;
  const skipped = summary?.skipped.length ?? queue.skipped.length;
  const processed = done + failed;
  const percent = total ? Math.round((processed / total) * 100) : 100;
  const finished = Boolean(summary) && !running;

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!running) onClose(value); }}>
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Kassa rasmlarini optimallashtirish</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Har bir rasm eng uzun tomoni 512 px gacha kichraytirilib, WebP (0.88) sifatida saqlanadi.
          Asl rasmlar o‘zgarmaydi; qayta ishga tushirilsa faqat yangi yoki o‘zgargan rasmlar ishlanadi.
        </p>

        <div className="rounded-xl border border-border bg-secondary/40 p-3 text-sm space-y-1">
          <p><strong>{total}</strong> ta mahsulot yangilanadi · <strong>{summary?.ready ?? queue.ready}</strong> ta allaqachon tayyor</p>
          {skipped > 0 && <p className="text-muted-foreground">{skipped} ta rasm http(s) havola emas — o‘tkazib yuboriladi.</p>}
        </div>

        {(running || summary) && (
          <div className="space-y-2">
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-primary transition-[width] duration-200" style={{ width: `${percent}%` }} />
            </div>
            <p role="status" className="text-xs text-muted-foreground">
              {processed} / {total} · Tayyor {done} · O‘tkazib yuborildi {skipped} · Xato {failed}
            </p>
          </div>
        )}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        {skipped > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">O‘tkazib yuborildi</p>
            <ul className="max-h-32 overflow-y-auto text-xs text-muted-foreground space-y-0.5">
              {(summary?.skipped || queue.skipped).map((row) => (
                <li key={row.id}>{row.name || row.id} — {row.reason}</li>
              ))}
            </ul>
          </div>
        )}

        {failed > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-destructive">Xato bo‘lgan rasmlar</p>
            <ul className="max-h-40 overflow-y-auto text-xs text-destructive space-y-1">
              {summary.failed.map((row) => <li key={row.id}>{row.name || row.id} — {row.error}</li>)}
            </ul>
          </div>
        )}

        {finished && total > 0 && failed === 0 && (
          <p className="text-sm font-medium text-emerald-700">Barcha rasmlar tayyor. Kassa endi yengil rasmlardan foydalanadi.</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onClose()} disabled={running}>Yopish</Button>
          <Button onClick={onStart} disabled={running || !total}
            className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {running ? 'Ishlanmoqda…' : finished ? 'Yana tekshirish' : 'Boshlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}