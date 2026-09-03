import React, { useState } from 'react';
import { Minus, Plus, Trash2, Ticket, X, Search } from 'lucide-react';
import { formatUZS } from '@/lib/pos';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function Cart({
  cart, onInc, onDec, onRemove, onClear,
  subtotal, discount, discountCode, onApplyDiscount, onRemoveDiscount, discountError,
  total, onCheckout, disabled,
}) {
  return (
    <div className="flex flex-col h-full bg-card">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-bold">Joriy buyurtma</h2>
          <p className="text-xs text-muted-foreground">{cart.reduce((s, i) => s + i.quantity, 0)} ta mahsulot</p>
        </div>
        {cart.length > 0 && (
          <button onClick={onClear} className="text-xs text-muted-foreground hover:text-destructive transition-colors flex items-center gap-1">
            <Trash2 className="w-3.5 h-3.5" /> Tozalash
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3 space-y-2">
        {cart.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 py-16">
            <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
              <Search className="w-7 h-7 text-muted-foreground/50" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">Hali mahsulot yo‘q</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Buyurtmaga qo‘shish uchun mahsulotni bosing.</p>
          </div>
        ) : (
          cart.map((item) => (
            <div key={item.product_id} className="flex items-center gap-3 p-2.5 rounded-xl bg-secondary/60 animate-pop-in">
              <div className="w-12 h-12 rounded-lg bg-card overflow-hidden shrink-0 border border-border/60">
                {item.image_url ? (
                  <img src={item.image_url} alt={item.product_name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-sm font-semibold text-muted-foreground/50">{item.product_name.charAt(0)}</div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{item.product_name}</div>
                <div className="text-xs text-muted-foreground">{formatUZS(item.price)}</div>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => onDec(item)} className="w-9 h-9 rounded-xl bg-card border border-border flex items-center justify-center hover:bg-primary/10 active:scale-95 transition-all touch-manipulation">
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="w-6 text-center text-sm font-semibold">{item.quantity}</span>
                <button onClick={() => onInc(item)} className="w-9 h-9 rounded-xl bg-card border border-border flex items-center justify-center hover:bg-primary/10 active:scale-95 transition-all touch-manipulation">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="w-20 text-right">
                <div className="text-sm font-semibold">{formatUZS(item.subtotal)}</div>
                <button onClick={() => onRemove(item)} className="text-muted-foreground/60 hover:text-destructive transition-colors mt-0.5">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border p-4 space-y-3 bg-card">
        <DiscountRow
          discountCode={discountCode}
          discount={discount}
          onApplyDiscount={onApplyDiscount}
          onRemoveDiscount={onRemoveDiscount}
          discountError={discountError}
        />
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Oraliq summa</span>
          <span className="font-medium text-foreground">{formatUZS(subtotal)}</span>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-sm text-primary-strong">
            <span>Chegirma ({discountCode})</span>
            <span className="font-medium">−{formatUZS(discount)}</span>
          </div>
        )}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <span className="font-display text-lg font-bold">Jami</span>
          <span className="font-display text-2xl font-bold text-primary-strong">{formatUZS(total)}</span>
        </div>
        <Button
          onClick={onCheckout}
          disabled={disabled || cart.length === 0}
          className="w-full h-12 text-base font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong disabled:opacity-40"
        >
          To‘lovga o‘tish · {formatUZS(total)}
        </Button>
      </div>
    </div>
  );
}

function DiscountRow({ discountCode, discount, onApplyDiscount, onRemoveDiscount, discountError }) {
  const [code, setCode] = useState('');
  if (discount > 0) {
    return (
      <div className="flex items-center justify-between bg-primary/10 rounded-xl px-3 py-2">
        <span className="text-sm font-medium text-primary-strong flex items-center gap-1.5">
          <Ticket className="w-4 h-4" /> {discountCode} qo‘llandi
        </span>
        <button onClick={onRemoveDiscount} className="text-muted-foreground hover:text-destructive">
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Ticket className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Chegirma kodi"
            className="pl-8 h-9 text-sm uppercase"
          />
        </div>
        <Button variant="outline" size="sm" className="h-9" onClick={() => onApplyDiscount(code)}>
          Qo‘llash
        </Button>
      </div>
      {discountError && <p className="text-xs text-destructive mt-1">{discountError}</p>}
    </div>
  );
}