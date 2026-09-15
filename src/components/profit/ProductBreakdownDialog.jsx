import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';
import { Loader2, AlertTriangle } from 'lucide-react';
import { formatUZS } from '@/lib/pos';

export default function ProductBreakdownDialog({ open, onClose, loading, data }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {data?.image_url && (
              <span className="w-8 h-8 rounded-lg overflow-hidden bg-secondary shrink-0">
                <Image src={data.image_url} alt={data.product_name || 'Mahsulot rasmi'} fittingType="fill" className="w-full h-full" />
              </span>
            )}
            <span>{data?.product_name || 'Mahsulot tannarxi'}</span>
          </DialogTitle>
          <DialogDescription>
            Retsept bo‘yicha masalliqlar tannarxi (tech card). Narxlar xariddan o‘rtacha hisoblanadi.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : !data ? (
          <div className="text-center py-10 text-muted-foreground text-sm">Ma’lumot topilmadi.</div>
        ) : !data.has_recipe ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <AlertTriangle className="w-4 h-4 inline mr-1.5" />
            Bu mahsulot uchun faol retsept (tech card) yaratilmagan. Tannarxni hisoblab bo‘lmaydi.
          </div>
        ) : (
          <div className="space-y-3">
            {data.missing?.length > 0 && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                <AlertTriangle className="w-4 h-4 inline mr-1.5" />
                Xarid narxi kiritilmagan: <b>{data.missing.join(', ')}</b>
              </div>
            )}
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-secondary/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left font-semibold px-3 py-2">Masalliq</th>
                    <th className="text-right font-semibold px-3 py-2">Miqdor</th>
                    <th className="text-right font-semibold px-3 py-2">1 birlik narxi</th>
                    <th className="text-right font-semibold px-3 py-2">Tannarxi</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ingredients.map((r) => (
                    <tr key={r.ingredient_id} className="border-t border-border">
                      <td className="px-3 py-2">{r.ingredient_name}{!r.has_price && <span className="text-rose-600 ml-1">*</span>}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{r.quantity} {r.unit}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{r.has_price ? formatUZS(r.cost_per_unit) : '—'}</td>
                      <td className="px-3 py-2 text-right font-medium">{r.has_price ? formatUZS(r.line_cost) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-secondary/40 border-t-2 border-border">
                  <tr>
                    <td className="px-3 py-2 font-semibold" colSpan={3}>Retsept (batch) tannarxi — {data.recipe?.output_quantity} {data.recipe?.output_unit === 'sheet' ? 'varaq' : 'dona'}</td>
                    <td className="px-3 py-2 text-right font-bold">{formatUZS(data.batch_cost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl border border-border p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">1 {data.recipe?.output_unit === 'sheet' ? 'varaq' : 'dona'} tannarxi</div>
                <div className="font-bold text-base">{formatUZS(data.unit_cost_per_output)}</div>
              </div>
              <div className="rounded-xl border border-brand-olive/30 bg-brand-olive/10 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">1 dona (bo‘lak) tannarxi</div>
                <div className="font-bold text-base text-brand-ink">{formatUZS(data.unit_cost_per_piece)}</div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}