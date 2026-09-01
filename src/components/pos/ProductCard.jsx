import React from 'react';
import { Image } from '@/components/ui/image';
import { Plus } from 'lucide-react';
import { formatUZS } from '@/lib/pos';

export default function ProductCard({ product, onAdd }) {
  return (
    <button
      onClick={() => onAdd(product)}
      className="group relative text-left bg-card rounded-2xl overflow-hidden border border-border/70 premium-shadow hover:premium-shadow-lg transition-all duration-200 hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-primary"
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
        <div className="absolute top-2 right-2 w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
          <Plus className="w-5 h-5" strokeWidth={2.5} />
        </div>
      </div>
      <div className="p-3">
        <div className="text-sm font-semibold leading-snug line-clamp-2 min-h-[2.5rem]">{product.name}</div>
        <div className="mt-1.5 text-[15px] font-bold text-primary-strong">{formatUZS(product.price)}</div>
      </div>
    </button>
  );
}