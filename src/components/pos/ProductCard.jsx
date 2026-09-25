import React from 'react';
import { Image } from '@/components/ui/image';
import { formatUZS } from '@/lib/pos';

export default function ProductCard({ product, stockQuantity = null, onAdd, disabled = false }) {
  return (
    <button
      type="button"
      onClick={() => onAdd(product)}
      disabled={disabled}
      aria-label={`${product.name}, ${formatUZS(product.price)}. Buyurtmaga qo‘shish`}
      className="odina-product-card group relative text-left bg-card rounded-2xl overflow-hidden border border-border hover:border-brand-sand premium-shadow hover:premium-shadow-lg transition-all duration-150 hover:-translate-y-0.5 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 touch-manipulation select-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="odina-product-photo relative aspect-square bg-secondary overflow-hidden">
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
      </div>
      <div className="odina-product-info p-3 sm:p-3.5">
        <div className="odina-product-name text-sm font-semibold leading-snug line-clamp-2 min-h-[2.5rem]">{product.name}</div>
        <div className="odina-product-meta">
          <span className="odina-product-price">{formatUZS(product.price)}</span>
        </div>
      </div>
    </button>
  );
}