import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, AlertTriangle } from 'lucide-react';
import { formatNum } from '@/lib/pos';

const UNIT = { piece: 'dona', sheet: 'list' };

export default function StockCountReviewDialog({ changes, onConfirm, onClose, approving }) {
  const total = changes.reduce((s, c) => s + c.diff, 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Tasdiqlash: qoldiq tuzatishlari</DialogTitle>
          <DialogDescription>Quyidagi {changes.length} ta o‘zgarish qoldiqqa qo‘llanadi. Aniq sanab bo‘lganingizni tekshiring.</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> Tasdiqlangandan so‘ng yozuvlar o‘zgartirib bo‘lmaydi.
        </div>
        <div className="rounded-2xl border border-border overflow-hidden max-h-[50dvh] overflow-y-auto scrollbar-thin">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground sticky top-0">
              <tr>
                <th className="text-left font-semibold px-3 py-2">Mahsulot</th>
                <th className="text-right font-semibold px-2 py-2">Tizim</th>
                <th className="text-right font-semibold px-2 py-2">Amalda</th>
                <th className="text-right font-semibold px-3 py-2">Farq</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-2 py-2 text-right text-muted-foreground">{formatNum(c.system)}</td>
                  <td className="px-2 py-2 text-right">{formatNum(Number(c.counted))} {UNIT[c.unit] || c.unit}</td>
                  <td className={`px-3 py-2 text-right font-semibold ${c.diff > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {c.diff > 0 ? '+' : ''}{formatNum(c.diff)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-secondary/40 border-t-2 border-border">
              <tr><td className="px-3 py-2 font-semibold" colSpan={3}>Jami net farq</td><td className="px-3 py-2 text-right font-bold">{formatNum(total)} dona</td></tr>
            </tfoot>
          </table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={approving}>Bekor</Button>
          <Button onClick={onConfirm} disabled={approving} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {approving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Tasdiqlash va qo'llash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}