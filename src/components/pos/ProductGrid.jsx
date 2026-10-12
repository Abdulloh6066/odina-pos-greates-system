import React, { memo } from 'react';
import ProductCard from './ProductCard';

function ProductGrid({ products, shopId, stockByProduct, showStock, onAdd, disabled, loading }) {
  if (loading) {
    return (
      <div className="odina-product-grid grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5">
        {Array.from({ length: 8 }).map((_, index) => <div key={index} className="aspect-[3/4] rounded-2xl bg-secondary animate-pulse" />)}
      </div>
    );
  }
  if (!products.length) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center py-20">
        <div className="text-5xl mb-3">🧁</div>
        <p className="text-sm font-medium text-muted-foreground">Mahsulot topilmadi</p>
      </div>
    );
  }
  return (
    <div className="odina-product-grid grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5">
      {products.map((product, index) => (
        <ProductCard key={product.id} product={product} shopId={shopId} priority={index < 8}
          stockQuantity={product.track_stock === false || !showStock ? null : Number(stockByProduct[product.id] || 0)}
          onAdd={onAdd} disabled={disabled} />
      ))}
    </div>
  );
}

export default memo(ProductGrid);
