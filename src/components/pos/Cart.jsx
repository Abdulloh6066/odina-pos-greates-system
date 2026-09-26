import React, { useState } from 'react';
import { Minus, Plus, Trash2, Ticket, X, ShoppingBag, ReceiptText, ArrowUpRight } from 'lucide-react';
import { formatUZS } from '@/lib/pos';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function Cart({
  cart, onInc, onDec, onRemove, onClear,
  subtotal, discount, couponDiscount, discountCode, onApplyDiscount, onRemoveDiscount, discountError,
  roundingTarget, adjustmentMode, roundingError, onApplyRounding, onApplyManualDiscount, onRemoveRounding,
  total, onCheckout, disabled, tableMode = false, tableDirty = false,
  tableSaved = false, onSaveTable, savingTable = false, locked = false, onCancelTable,
}) {
  return (
    <div className="odina-cart flex flex-col w-full min-w-0 min-h-0 h-full bg-card overflow-hidden">
      <div className="odina-cart-header px-4 py-3 pr-16 xl:pr-4 shrink-0 border-b border-brand-sand/40 brand-surface flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="odina-cart-header-icon" aria-hidden="true"><ReceiptText className="w-4 h-4" /></span>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold">Joriy buyurtma</h2>
            <p className="text-xs text-muted-foreground">{cart.reduce((s, i) => s + (i.sale_unit === 'gram' ? 1 : i.quantity), 0)} ta mahsulot</p>
          </div>
        </div>
        {cart.length > 0 && !tableSaved && (
          <button onClick={onClear} type="button" disabled={locked} className="min-h-11 px-2 rounded-xl text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors flex items-center gap-1">
            <Trash2 className="w-3.5 h-3.5" /> Tozalash
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-3 py-1.5" aria-label="Buyurtmadagi mahsulotlar">
        {cart.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 py-16">
            <div className="odina-cart-empty-icon w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
              <ShoppingBag className="w-7 h-7 text-muted-foreground/50" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">Yangi buyurtma kutmoqda</p>
            <p className="text-xs text-muted-foreground mt-1">Buyurtmaga qo‘shish uchun mahsulotni bosing.</p>
          </div>
        ) : (
          cart.map((item) => (
            <div key={item.product_id} className="odina-cart-line grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(6.5rem,auto)_2.75rem] items-center gap-2 border-b border-dashed border-brand-sand/60 px-1 py-1.5 animate-pop-in last:border-b-0">
              <div className="flex min-w-0 items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-card overflow-hidden shrink-0 border border-border/60">
                  {item.image_url ? (
                    <img src={item.image_url} alt={item.product_name || 'Mahsulot rasmi'} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center font-display text-sm text-brand-ink">{item.product_name.charAt(0)}</div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold leading-snug" title={item.product_name}>{item.product_name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{formatUZS(item.price)}{item.sale_unit === 'gram' ? ' / kg' : ''}</div>
                </div>
              </div>
              {item.sale_unit === 'gram' ? (
                <button type="button" disabled={locked} onClick={() => onInc(item)} className="h-11 px-2 rounded-lg border border-border text-xs font-semibold" aria-label={item.product_name + ' grammini o‘zgartirish'}>{item.quantity} g ✎</button>
              ) : <div className="inline-flex shrink-0 items-center rounded-lg border border-border bg-card">
                <button type="button" onClick={() => onDec(item)} disabled={locked} aria-label={`${item.product_name} miqdorini kamaytirish`} className="w-9 h-9 rounded-l-lg flex items-center justify-center hover:bg-brand-olive/15 active:bg-brand-olive/25 touch-manipulation">
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="min-w-5 px-0.5 text-center text-xs font-semibold tabular-nums">{item.quantity}</span>
                <button type="button" onClick={() => onInc(item)} disabled={locked} aria-label={`${item.product_name} miqdorini oshirish`} className="w-9 h-9 rounded-r-lg flex items-center justify-center hover:bg-brand-olive/15 active:bg-brand-olive/25 touch-manipulation">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>}
              <div className="min-w-0 text-right text-sm font-bold leading-snug text-brand-ink break-words tabular-nums">{formatUZS(item.subtotal)}</div>
              <button type="button" onClick={() => onRemove(item)} disabled={locked} aria-label={`${item.product_name}ni buyurtmadan olib tashlash`} className="h-11 w-11 shrink-0 flex items-center justify-center rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive touch-manipulation">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="odina-cart-summary border-t border-brand-sand/50 p-3 safe-bottom shrink-0 space-y-2.5 bg-card">
        {discount > 0 && (
          <div className="flex items-center justify-between text-sm text-brand-ink">
            <span>{discountCode ? `Chegirma (${discountCode})` : adjustmentMode === 'manual' ? 'Qaytib berish' : 'Yaxlitlash'}</span>
            <span className="font-medium">−{formatUZS(discount)}</span>
          </div>
        )}
        <div className="odina-cart-total flex items-center justify-between pt-2 border-t border-border">
          <span className="font-display text-lg font-bold">Jami</span>
          <span className="text-2xl font-bold tracking-tight text-brand-ink text-right break-words">{formatUZS(total)}</span>
        </div>
        {tableMode && <div className="flex items-center gap-2 min-w-0">
          <Button type="button" variant="outline" onClick={onSaveTable}
            disabled={locked || (!tableDirty && !tableSaved) || cart.length === 0 || savingTable}
            className="flex-1 min-w-0 min-h-11 h-auto py-2 whitespace-normal text-center rounded-xl border-brand-olive bg-card text-brand-ink font-semibold hover:bg-brand-olive/15">
            {savingTable ? 'Saqlanmoqda…' : tableDirty ? 'Stolga saqlash' : 'Yangi buyurtma'}
          </Button>
          {onCancelTable && (
            <Button type="button" variant="outline" onClick={onCancelTable}
              disabled={locked || savingTable}
              className="shrink-0 min-h-11 h-auto px-3 rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10 font-semibold touch-manipulation"
              aria-label="Stolni bekor qilish">
              <X className="w-4 h-4" />
              <span className="hidden sm:inline">Bekor qilish</span>
            </Button>
          )}
        </div>}
        <Button
          onClick={onCheckout}
          disabled={disabled || locked || cart.length === 0}
          className="odina-checkout w-full min-h-12 h-auto py-3 whitespace-normal text-base font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong disabled:opacity-40"
        >
          <span>{tableMode ? 'Hisobni yopish · To‘lov' : 'To‘lovga o‘tish'}</span>
          <span className="flex items-center gap-2">{formatUZS(total)} <ArrowUpRight className="w-4 h-4 shrink-0" aria-hidden="true" /></span>
        </Button>
      </div>
    </div>
  );
}

export function RoundingRow({ subtotal, discountCode, roundingTarget, adjustmentMode, roundingError, onApplyRounding, onApplyManualDiscount, onRemoveRounding }) {
  const [manualOpen, setManualOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const step = subtotal >= 10000 ? 5000 : subtotal >= 1000 ? 1000 : 100;
  const rounded = Math.floor(subtotal / step) * step;
  if (roundingTarget !== null) return (
    <div className="flex items-center justify-between rounded-xl bg-primary/10 px-3 py-1 gap-2">
      <span className="text-sm font-medium text-brand-ink">{adjustmentMode === 'manual' ? 'Qaytib berish' : 'Yaxlitlash'}: −{formatUZS(subtotal - roundingTarget)}</span>
      <button type="button" onClick={() => { onRemoveRounding(); setAmount(''); setManualOpen(false); }} className="w-11 h-11 shrink-0 rounded-xl flex items-center justify-center hover:bg-destructive/10" aria-label="Chegirmani bekor qilish"><X className="w-4 h-4" /></button>
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" className="h-11 text-xs sm:text-sm px-2" disabled={Boolean(discountCode)} onClick={() => setManualOpen((open) => !open)}>− Qaytib berish</Button>
        <Button type="button" variant="outline" className="h-11 text-xs sm:text-sm px-2" disabled={Boolean(discountCode) || rounded <= 0 || rounded === subtotal} onClick={() => { setManualOpen(false); onApplyRounding(); }}>Yaxlitlash ↘</Button>
      </div>
      {manualOpen && !discountCode && (
        <div className="flex items-center gap-2">
          <Input type="number" step={1000} inputMode="numeric" aria-label="Ayiriladigan summa" placeholder="2000 yoki -2000" value={amount} onChange={(event) => setAmount(event.target.value)} className="h-11 min-w-0 flex-1" />
          <Button type="button" variant="outline" className="h-11 shrink-0" disabled={!amount.trim()} onClick={() => { if (onApplyManualDiscount(amount)) { setAmount(''); setManualOpen(false); } }}>Qo‘llash</Button>
        </div>
      )}
      {discountCode && <p className="text-xs text-muted-foreground">Avval chegirma kodini olib tashlang.</p>}
      {roundingError && <p role="alert" className="text-xs text-destructive">{roundingError}</p>}
    </div>
  );
}

export function DiscountRow({ discountCode, discount, onApplyDiscount, onRemoveDiscount, discountError }) {
  const [code, setCode] = useState('');
  if (discount > 0) {
    return (
      <div className="flex items-center justify-between bg-primary/10 rounded-xl px-3 py-2">
        <span className="text-sm font-medium text-brand-ink flex items-center gap-1.5">
          <Ticket className="w-4 h-4" /> {discountCode} qo‘llandi
        </span>
        <button onClick={onRemoveDiscount} type="button" aria-label="Chegirmani olib tashlash" className="w-11 h-11 flex items-center justify-center rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
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
            aria-label="Chegirma kodi"
            placeholder="Chegirma kodi"
            className="pl-8 h-11 uppercase"
          />
        </div>
        <Button variant="outline" size="sm" className="h-11" onClick={() => onApplyDiscount(code)}>
          Qo‘llash
        </Button>
      </div>
      {discountError && <p className="text-xs text-destructive mt-1">{discountError}</p>}
    </div>
  );
}