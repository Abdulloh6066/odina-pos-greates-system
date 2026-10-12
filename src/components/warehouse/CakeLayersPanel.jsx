import React from 'react';
import { AlertTriangle, ArrowRightLeft, BookOpen, CakeSlice, Layers3, PackagePlus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatNum } from '@/lib/pos';

export default function CakeLayersPanel({
  layerRows, capacityRows, canManage, canAdjust, canProduce,
  onCreate, onAdjust, onRecipe, onProduce, onTransfer,
}) {
  const totalLayers = layerRows.reduce((sum, row) => sum + row.quantity, 0);
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5">
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          <div className="flex-1">
            <h2 className="font-display text-xl font-bold flex items-center gap-2"><Layers3 className="w-5 h-5" /> Qavatlar va listlar</h2>
            <p className="text-sm text-muted-foreground mt-2">Pishirilgan biskvit va korj qoldig‘i. Tort yig‘ilganda retseptdagi qavatlar, krem va boshqa masalliqlar kamayadi; tayyor mahsulot markaziy omborga kiradi.</p>
          </div>
          <Button variant="outline" onClick={onTransfer} className="min-h-11 shrink-0"><ArrowRightLeft className="w-4 h-4 mr-2" /> Filiallarga jo‘natish</Button>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-5">
          <div className="rounded-xl bg-card border border-border p-3"><p className="text-xs text-muted-foreground">Ombordagi qavat/list</p><p className="text-2xl font-semibold mt-1">{formatNum(totalLayers)}</p></div>
          <div className="rounded-xl bg-card border border-border p-3"><p className="text-xs text-muted-foreground">Retsepti bog‘langan mahsulotlar</p><p className="text-2xl font-semibold mt-1">{capacityRows.length}</p></div>
        </div>
      </div>

      <section>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="font-semibold flex items-center gap-2"><Layers3 className="w-5 h-5" /> Bor qavatlar</h3>
          {canManage && <Button onClick={onCreate} className="min-h-11"><Plus className="w-4 h-4 mr-1.5" /> Qavat turi qo‘shish</Button>}
        </div>
        {!layerRows.length ? (
          <div className="rounded-2xl border border-dashed border-border bg-card p-7 text-center text-sm text-muted-foreground">Avval qavat turini qo‘shing, keyin pishirilgan listlarning haqiqiy sonini kiriting. Masalan: “Oq biskvit — katta list”.</div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {layerRows.map(({ ingredient, quantity, valid }) => (
              <div key={ingredient.id} className="odina-panel rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold min-w-0 break-words">{ingredient.name}</p>
                  <span className="rounded-xl bg-emerald-50 px-3 py-2 text-emerald-800 text-right shrink-0"><strong className="text-xl">{valid ? formatNum(quantity) : '—'}</strong><span className="block text-xs">list/qavat</span></span>
                </div>
                {!valid && <p className="mt-3 text-xs text-destructive">Qoldiq yoki birlik noto‘g‘ri. Egasi tekshirishi kerak.</p>}
                {canAdjust && <Button variant="outline" onClick={() => onAdjust(ingredient)} disabled={!valid} className="w-full mt-4 min-h-11"><PackagePlus className="w-4 h-4 mr-1.5" /> Qavat kirimi / tuzatish</Button>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="font-semibold flex items-center gap-2"><CakeSlice className="w-5 h-5" /> Nechta tayyorlash mumkin?</h3>
          {canManage && <Button variant="outline" onClick={() => onRecipe()} className="min-h-11"><BookOpen className="w-4 h-4 mr-1.5" /> Retsept bog‘lash</Button>}
        </div>
        <p className="text-xs text-muted-foreground mb-3">Har bir mahsulot alohida hisoblanadi. Bir xil qavat yoki krem bir necha retseptda ishlatilsa, ko‘rsatilgan imkoniyatlarni qo‘shib bo‘lmaydi.</p>
        {!capacityRows.length ? (
          <div className="rounded-2xl border border-dashed border-border bg-card p-7 text-center text-sm text-muted-foreground">Mahsulot retseptiga qavatlarni qo‘shing: nechta mahsulot chiqishi va unga jami nechta list ketishini kiriting. Krem va boshqa masalliqlar ham shu retseptga qo‘shiladi.</div>
        ) : (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
            {capacityRows.map(({ product, capacity, prepared }) => {
              const unit = product.production_unit === 'sheet' ? 'tayyor list' : 'dona';
              const stackSize = capacity.layers.reduce((sum, row) => sum + row.perOutput, 0);
              return (
                <div key={product.id} className="odina-panel rounded-2xl border border-border bg-card p-4 flex flex-col">
                  <p className="font-semibold text-lg">{product.name}</p>
                  {stackSize > 0 && (
                    <div className="mt-4 flex items-center gap-3">
                      <div aria-hidden="true" className="w-20 shrink-0 space-y-1">{Array.from({ length: Math.min(stackSize, 6) }).map((_, index) => <div key={index} className="h-1.5 rounded bg-emerald-200" />)}</div>
                      <p className="text-xs text-muted-foreground">{formatNum(stackSize)} qavat → 1 {unit === 'dona' ? 'mahsulot' : 'tayyor list'}</p>
                    </div>
                  )}
                  <div className="mt-4 space-y-2">
                    {capacity.layers.map((row) => (
                      <div key={row.ingredient.id} className="rounded-lg bg-secondary/50 p-2 text-xs">
                        <p className="font-medium">{row.ingredient.name}</p>
                        <p className="text-muted-foreground mt-1">Bor: {formatNum(row.available)} list · 1 mahsulotga: {formatNum(row.perOutput)} list</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-secondary/60 p-3"><p className="text-xs text-muted-foreground">Faqat qavatlardan</p><p className="text-xl font-semibold mt-1">{formatNum(capacity.layerPossible)} <span className="text-xs font-normal">{unit}</span></p></div>
                    <div className="rounded-xl bg-emerald-50 p-3 text-emerald-900"><p className="text-xs">Barcha masalliqlar bilan</p><p className="text-xl font-semibold mt-1">{formatNum(capacity.possible)} <span className="text-xs font-normal">{unit}</span></p></div>
                  </div>
                  <p className="mt-3 text-sm">Tayyor ombor qoldig‘i: <strong>{prepared === null ? 'Tekshiring' : formatNum(prepared)} {unit}</strong></p>
                  {capacity.issue && <p role="status" className="mt-3 text-xs text-destructive flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0" />{capacity.issue}</p>}
                  <div className="mt-auto pt-4 flex flex-col gap-2">
                    {canProduce && <Button onClick={() => onProduce(product)} disabled={!!capacity.issue || capacity.possible < 1 || prepared === null} className="w-full min-h-11"><CakeSlice className="w-4 h-4 mr-1.5" /> Tort / mahsulot yig‘ish</Button>}
                    {canManage && <Button variant="outline" onClick={() => onRecipe(product)} className="w-full min-h-11"><BookOpen className="w-4 h-4 mr-1.5" /> Retseptni ko‘rish / tahrirlash</Button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
