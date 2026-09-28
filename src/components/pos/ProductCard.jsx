import React from 'react';
import { Image } from '@/components/ui/image';
import { formatUZS } from '@/lib/pos';
import { posThumbnailFor } from '@/lib/pos-thumbnails';

export default function ProductCard({ product, shopId, stockQuantity = null, onAdd, disabled = false }) {
  const [failedThumbnail, setFailedThumbnail] = React.useState(null);
  const thumbnail = posThumbnailFor(product, shopId);
  const useThumbnail = Boolean(thumbnail && thumbnail !== failedThumbnail);
  const imageSrc = useThumbnail ? thumbnail : product.image_url;

  return (
    <button
      type="button"
      onClick={() => onAdd(product)}
      disabled={disabled}
      aria-label={`${product.name}, ${formatUZS(product.price)}. Buyurtmaga qo‘shish`}
      className="odina-product-card group relative text-left bg-card rounded-2xl overflow-hidden border border-border hover:border-brand-sand premium-shadow hover:premium-shadow-lg transition-all duration-150 hover:-translate-y-0.5 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 touch-manipulation select-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="odina-product-photo relative aspect-square bg-white overflow-hidden">
        {product.image_url ? (
          <Image
            src={imageSrc}
            loading={useThumbnail ? 'eager' : undefined}
            decoding={useThumbnail ? 'async' : undefined}
            onError={useThumbnail ? () => setFailedThumbnail(thumbnail) : undefined}
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
          <span className="odina-product-price">{formatUZS(product.price)}{product.sale_unit === 'gram' ? ' / kg' : ''}</span>
        </div>
      </div>
    </button>
  );
}