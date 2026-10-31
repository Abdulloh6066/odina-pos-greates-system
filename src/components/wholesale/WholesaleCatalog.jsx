import React from 'react';
import { Image } from '@/components/ui/image';
import { Button } from '@/components/ui/button';
import { formatUZS } from '@/lib/pos';

export default function WholesaleCatalog({ products, onSell, loading }) {
  if (loading) return <p role="status">Mahsulotlar yuklanmoqda…</p>;
  if (!products.length) return <p className="py-8 text-muted-foreground">Central mahsulotlari topilmadi.</p>;
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{products.map(product => <article key={product.id} className="rounded-2xl border bg-card p-4 space-y-3">
    <div className="flex gap-3 items-center">
      {product.image_url && <Image src={product.image_url} alt={product.name} className="h-16 w-16 shrink-0 rounded-xl" />}
      <div className="min-w-0"><h2 className="font-body text-base font-semibold">{product.name}</h2><p className="text-sm text-muted-foreground">{product.list_ready ? `Qoldiq: ${product.stock_quantity} list` : 'List hisobi sozlanmagan'}</p></div>
    </div>
    <div className="flex items-center justify-between gap-2"><p className="font-semibold">{product.sheet_price > 0 ? `${formatUZS(product.sheet_price)} / list` : 'List narxi belgilanmagan'}</p>
      <Button onClick={() => onSell(product)} disabled={!product.list_ready || !(product.sheet_price > 0) || product.stock_quantity < 0.5}>Sotish</Button></div>
  </article>)}</div>;
}