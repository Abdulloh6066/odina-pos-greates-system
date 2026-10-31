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
      <div className="min-w-0"><h2 className="font-body text-base font-semibold">{product.name}</h2><p className="text-sm text-muted-foreground">{product.list_ready ? (product.wholesale_unit === 'piece' ? `Qoldiq: ${product.stock_quantity} dona` : `Qoldiq: ${Number(product.stock_quantity.toFixed(3))} list · 1 list = ${product.pieces_per_sheet} dona`) : 'List hisobi sozlanmagan'}</p></div>
    </div>
    <div className="flex items-center justify-between gap-2"><p className="font-semibold">{product.unit_price > 0 ? `${formatUZS(product.unit_price)} / ${product.wholesale_unit === 'piece' ? 'dona' : 'list'}` : 'List narxi belgilanmagan'}</p>
      <Button onClick={() => onSell(product)} disabled={!product.list_ready || !(product.unit_price > 0) || product.stock_quantity < (product.wholesale_unit === 'piece' ? 1 : 0.5)}>Sotish</Button></div>
  </article>)}</div>;
}