import React from 'react';
import { AlertTriangle, ArrowRightLeft, BookOpen, CakeSlice, Layers3, PackagePlus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatNum } from '@/lib/pos';

export default function CakeLayersPanel({
  layerRows, capacityRows, canManage, canAdjust, canProduce,
  onCreate, onAdjust, onRecipe, onProduce, onTransfer,
}) {
  const totalLayers = layerRows.reduce((sum, row) => sum + row.quantity, 0);
  const actionClass = 'min-h-11 h-auto whitespace-normal rounded-xl px-4 py-3 text-sm leading-snug touch-manipulation';
  return (
    <div className="min-w-0 space-y-6 sm:space-y-8">
      <header className="overflow-hidden rounded-2xl border border-border bg-card premium-shadow">
        <div className="h-1.5 bg-brand-olive" aria-hidden="true" />
        <div className="p-5 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 max-w-2xl">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-brand-ink"><Layers3 className="h-4 w-4 shrink-0" aria-hidden="true" /> Markaziy ishlab chiqarish</div>
              <h2 className="font-display text-2xl font-bold sm:text-3xl">Qavatlar va listlar</h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Pishirilgan biskvit va korj qoldig‘i. Tort yig‘ilganda retseptdagi qavatlar, krem va boshqa masalliqlar kamayadi; tayyor mahsulot markaziy omborga kiradi.</p>
            </div>
            <Button variant="outline" onClick={onTransfer} className={`${actionClass} w-full shrink-0 sm:w-auto`}><ArrowRightLeft className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" /> Filiallarga jo‘natish</Button>
          </div>
          <dl className="mt-6 grid gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 items-center justify-between gap-4 rounded-xl border border-border bg-secondary/40 p-4"><dt className="text-sm text-muted-foreground">Ombordagi qavat/list</dt><dd className="break-all text-right text-3xl font-semibold tabular-nums tracking-tight">{formatNum(totalLayers)}</dd></div>
            <div className="flex min-w-0 items-center justify-between gap-4 rounded-xl border border-border bg-secondary/40 p-4"><dt className="text-sm text-muted-foreground">Retsepti bog‘langan mahsulotlar</dt><dd className="break-all text-right text-3xl font-semibold tabular-nums tracking-tight">{capacityRows.length}</dd></div>
          </dl>
        </div>
      </header>

      <section aria-labelledby="cake-layer-stock-title" className="min-w-0">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-brand-ink" aria-hidden="true"><Layers3 className="h-5 w-5" /></span>
            <div className="min-w-0"><h3 id="cake-layer-stock-title" className="font-display text-xl font-bold">Bor qavatlar</h3><p className="mt-1 text-sm text-muted-foreground">Pishirilgan listlar va ularning ombordagi qoldig‘i.</p></div>
          </div>
          {canManage && <Button onClick={onCreate} className={`${actionClass} w-full shrink-0 sm:w-auto`}><Plus className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" /> Qavat turi qo‘shish</Button>}
        </div>
        {!layerRows.length ? (
          <div className="rounded-2xl border border-dashed border-brand-sand bg-card px-5 py-8 sm:px-8">
            <div className="mx-auto flex max-w-xl flex-col items-center text-center">
              <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-olive/15 text-brand-ink" aria-hidden="true"><Layers3 className="h-7 w-7" /></span>
              <h4 className="text-lg font-semibold">Ko‘rsatish uchun qavat topilmadi</h4>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Avval qavat turini qo‘shing, keyin pishirilgan listlarning haqiqiy sonini kiriting. Masalan: “Oq biskvit — katta list”.</p>
              <p className="mt-4 rounded-lg bg-secondary/60 px-4 py-2 text-sm text-muted-foreground">Qidiruv ishlatilgan bo‘lsa, so‘rovni ham tekshiring.</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {layerRows.map(({ ingredient, quantity, valid }) => (
              <article key={ingredient.id} className={`group relative isolate flex min-w-0 flex-col rounded-2xl border border-border bg-card p-5 premium-shadow ${canAdjust && valid ? 'transition-colors hover:border-brand-olive hover:bg-brand-olive/5 focus-within:border-brand-olive' : ''}`}>
                {canAdjust && valid && <button
                  type="button"
                  aria-label={`${ingredient.name}: qavat kirimi / tuzatish`}
                  aria-haspopup="dialog"
                  aria-describedby={`layer-quantity-${ingredient.id}`}
                  onClick={() => onAdjust(ingredient)}
                  className="absolute inset-0 z-10 min-h-11 w-full cursor-pointer rounded-2xl bg-transparent touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />}
                <h4 className="min-w-0 break-words text-base font-semibold leading-snug">{ingredient.name}</h4>
                <div id={`layer-quantity-${ingredient.id}`} className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1"><strong className="break-all text-3xl font-semibold tabular-nums tracking-tight">{valid ? formatNum(quantity) : '—'}</strong><span className="text-sm text-muted-foreground">list/qavat</span></div>
                {canAdjust && valid && <p className="mt-2 text-sm text-muted-foreground">Miqdor kiritish uchun kartani bosing.</p>}
                {!valid && <p role="status" className="mt-3 text-sm text-destructive">Qoldiq yoki birlik noto‘g‘ri. Egasi tekshirishi kerak.</p>}
                {canAdjust && <div className="pointer-events-none relative z-20 mt-auto pt-5"><Button type="button" aria-haspopup="dialog" variant="outline" onClick={() => onAdjust(ingredient)} disabled={!valid} className={`${actionClass} pointer-events-auto w-full`}><PackagePlus className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" /> Qavat kirimi / tuzatish</Button></div>}
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="cake-layer-capacity-title" className="min-w-0 border-t border-border pt-6 sm:pt-8">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-brand-ink" aria-hidden="true"><CakeSlice className="h-5 w-5" /></span>
            <div className="min-w-0"><h3 id="cake-layer-capacity-title" className="font-display text-xl font-bold">Nechta tayyorlash mumkin?</h3><p className="mt-1 text-sm text-muted-foreground">Retsept va mavjud masalliqlar asosidagi imkoniyat.</p></div>
          </div>
          {canManage && <Button variant="outline" onClick={() => onRecipe()} className={`${actionClass} w-full shrink-0 sm:w-auto`}><BookOpen className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" /> Retsept bog‘lash</Button>}
        </div>
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-brand-sand/10 p-4"><BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-brand-ink" aria-hidden="true" /><p className="text-sm leading-relaxed text-muted-foreground">Har bir mahsulot alohida hisoblanadi. Bir xil qavat yoki krem bir necha retseptda ishlatilsa, ko‘rsatilgan imkoniyatlarni <strong className="font-semibold text-foreground">qo‘shib bo‘lmaydi.</strong></p></div>
        {!capacityRows.length ? (
          <div className="rounded-2xl border border-dashed border-brand-sand bg-card px-5 py-8 sm:px-8">
            <div className="mx-auto flex max-w-xl flex-col items-center text-center">
              <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary text-brand-ink" aria-hidden="true"><BookOpen className="h-7 w-7" /></span>
              <h4 className="text-lg font-semibold">Ko‘rsatish uchun qavatli retsept topilmadi</h4>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Mahsulot retseptiga qavatlarni qo‘shing: nechta mahsulot chiqishi va unga jami nechta list ketishini kiriting. Krem va boshqa masalliqlar ham shu retseptga qo‘shiladi.</p>
              <p className="mt-4 rounded-lg bg-secondary/60 px-4 py-2 text-sm text-muted-foreground">Qidiruv ishlatilgan bo‘lsa, so‘rovni ham tekshiring.</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {capacityRows.map(({ product, capacity, prepared }) => {
              const unit = product.production_unit === 'sheet' ? 'tayyor list' : 'dona';
              const stackSize = capacity.layers.reduce((sum, row) => sum + row.perOutput, 0);
              return (
                <article key={product.id} className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card premium-shadow">
                  <div className="flex-1 p-5 sm:p-6">
                    <h4 className="break-words text-lg font-semibold leading-snug">{product.name}</h4>
                    {stackSize > 0 && <div className="mt-3 flex items-center gap-3"><div aria-hidden="true" className="w-10 shrink-0 space-y-1">{Array.from({ length: Math.min(stackSize, 6) }).map((_, index) => <div key={index} className="h-1 rounded bg-brand-olive/60" />)}</div><p className="text-sm text-muted-foreground">{formatNum(stackSize)} qavat → 1 {unit === 'dona' ? 'mahsulot' : 'tayyor list'}</p></div>}
                    <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                      <div className="min-w-0 rounded-xl border border-border bg-secondary/40 p-4"><dt className="text-sm text-muted-foreground">Faqat qavatlardan</dt><dd className="mt-2 break-words text-2xl font-semibold tabular-nums">{formatNum(capacity.layerPossible)} <span className="text-sm font-normal text-muted-foreground">{unit}</span></dd></div>
                      <div className="min-w-0 rounded-xl border border-brand-olive/50 bg-brand-olive/15 p-4"><dt className="text-sm font-medium">Barcha masalliqlar bilan</dt><dd className="mt-2 break-words text-3xl font-semibold tabular-nums">{formatNum(capacity.possible)} <span className="text-sm font-normal">{unit}</span></dd></div>
                    </dl>
                    <div className="mt-5 space-y-2">{capacity.layers.map((row) => <div key={row.ingredient.id} className="rounded-lg border border-border bg-background/50 p-3 text-sm"><p className="break-words font-medium">{row.ingredient.name}</p><p className="mt-1 leading-relaxed text-muted-foreground">Bor: {formatNum(row.available)} list · 1 mahsulotga: {formatNum(row.perOutput)} list</p></div>)}</div>
                    <p className="mt-4 text-sm leading-relaxed text-muted-foreground">Tayyor ombor qoldig‘i: <strong className="font-semibold text-foreground">{prepared === null ? 'Tekshiring' : formatNum(prepared)} {unit}</strong></p>
                    {capacity.issue && <p role="status" className="mt-4 flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{capacity.issue}</p>}
                  </div>
                  {(canProduce || canManage) && <div className="mt-auto flex flex-col gap-2 border-t border-border bg-background/40 p-4 sm:px-6">
                    {canProduce && <Button onClick={() => onProduce(product)} disabled={!!capacity.issue || capacity.possible < 1 || prepared === null} className={`${actionClass} w-full`}><CakeSlice className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" /> Tort / mahsulot yig‘ish</Button>}
                    {canManage && <Button variant="outline" onClick={() => onRecipe(product)} className={`${actionClass} w-full`}><BookOpen className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" /> Retseptni ko‘rish / tahrirlash</Button>}
                  </div>}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
