import React from 'react';
import { Image } from '@/components/ui/image';
import { AlertTriangle, Plus } from 'lucide-react';
import { formatUZS } from '@/lib/pos';

export default function ProductCard({ product, stockQuantity = null, onAdd }) {
  return (
    <button
      type="button"
      onClick={() => onAdd(product)}
      aria-label={`${product.name}, ${formatUZS(product.price)}. Buyurtmaga qo‘shish`}
      className="group relative text-left bg-card rounded-2xl overflow-hidden border border-border hover:border-brand-sand premium-shadow hover:premium-shadow-lg transition-all duration-150 hover:-translate-y-0.5 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 touch-manipulation select-none"
    >
      <div className="relative aspect-square bg-secondary overflow-hidden">
        {product.image_url ? (
          <Image
            src={product.image_url}
            alt={product.name}
            fittingType="fill"
            className="w-full h-full transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-4xl font-display text-muted-foreground/40">
            {product.name.charAt(0)}
          </div>
        )}
        <div className="absolute top-2 right-2 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-visible:opacity-100 transition-opacity shadow-lg">
          <Plus className="w-5 h-5" strokeWidth={2.5} />
        </div>
        {stockQuantity !== null && stockQuantity <= 0 && (
          <div className="absolute left-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-red-600/95 text-white px-2 py-1 text-xs font-semibold shadow">
            <AlertTriangle className="w-3 h-3" /> Qoldiq {stockQuantity}
          </div>
        )}
      </div>
      <div className="p-3 sm:p-3.5">
        <div className="text-sm font-semibold leading-snug line-clamp-2 min-h-[2.5rem]">{product.name}</div>
        <div className="mt-1.5 text-[15px] font-bold text-brand-ink">{formatUZS(product.price)}</div>
      </div>
    </button>
  );
}