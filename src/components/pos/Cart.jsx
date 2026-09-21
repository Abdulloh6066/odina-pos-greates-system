import React, { useState } from 'react';
import { Minus, Plus, Trash2, Ticket, X, ShoppingBag, ReceiptText, ArrowUpRight, ChevronDown } from 'lucide-react';
import { formatUZS } from '@/lib/pos';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function Cart({
  cart, onInc, onDec, onRemove, onClear,
  subtotal, discount, couponDiscount, discountCode, onApplyDiscount, onRemoveDiscount, discountError,
  roundingTarget, adjustmentMode, roundingError, onApplyRounding, onApplyManualDiscount, onRemoveRounding,
  total, onCheckout, disabled, tableMode = false, tableDirty = false,
  tableSaved = false, onSaveTable, onStaffTicket, savingTable = false, locked = false,
}) {
  const [adjustmentsOpen, setAdjustmentsOpen] = useState(false);

  return (
    <div className="odina-cart flex flex-col w-full min-w-0 min-h-0 h-full bg-card overflow-hidden">
      <div className="odina-cart-header px-4 py-3 pr-16 xl:pr-4 shrink-0 border-b border-brand-sand/40 brand-surface flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="odina-cart-header-icon" aria-hidden="true"><ReceiptText className="w-4 h-4" /></span>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold">Joriy buyurtma</h2>
            <p className="text-xs text-muted-foreground">{cart.reduce((s, i) => s + i.quantity, 0)} ta mahsulot</p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {tableMode && cart.length > 0 && onStaffTicket && (
            <button
              type="button"
              onClick={onStaffTicket}
              disabled={locked || savingTable}
              className="min-h-11 px-2 rounded-xl text-xs font-semibold text-brand-ink hover:bg-brand-olive/15 transition-colors flex items-center gap-1 touch-manipulation"
              aria-label="Xizmat chekini ochish"
            >
              <ReceiptText className="w-3.5 h-3.5" />
              <span className="sm:hidden">Chek</span>
              <span className="hidden sm:inline">Xizmat cheki</span>
            </button>
          )}
          {cart.length > 0 && !tableSaved && (
            <button onClick={onClear} type="button" disabled={locked} className="min-h-11 px-2 rounded-xl text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> Tozalash
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-[9rem] overflow-y-auto overscroll-contain scrollbar-thin px-3 py-1.5" aria-label="Buyurtmadagi mahsulotlar">
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
            <div key={item.product_id} className="odina-cart-line min-w-0 border-b border-dashed border-brand-sand/60 px-1 py-2 animate-pop-in last:border-b-0">
              <div className="flex items-start gap-2">
                <div className="w-9 h-9 rounded-lg bg-card overflow-hidden shrink-0 border border-border/60">
                  {item.image_url ? (
                    <img src={item.image_url} alt={item.product_name || 'Mahsulot rasmi'} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center font-display text-sm text-brand-ink">{item.product_name.charAt(0)}</div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold leading-snug break-words">{item.product_name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{formatUZS(item.price)}</div>
                </div>
                <button type="button" onClick={() => onRemove(item)} disabled={locked} aria-label={`${item.product_name}ni buyurtmadan olib tashlash`} className="h-11 w-11 -mr-1 -mt-1 shrink-0 flex items-center justify-center rounded-xl text-muted-foreground hover:bg-destructive/10 hover:text-destructive touch-manipulation">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center justify-between gap-2 mt-1.5">
                <div className="inline-flex items-center rounded-lg border border-border bg-card shrink-0">
                  <button type="button" onClick={() => onDec(item)} disabled={locked} aria-label={`${item.product_name} miqdorini kamaytirish`} className="w-11 h-11 rounded-l-lg flex items-center justify-center hover:bg-brand-olive/15 active:bg-brand-olive/25 touch-manipulation">
                    <Minus className="w-4 h-4" />
                  </button>
                  <span className="min-w-7 px-0.5 text-center text-sm font-semibold tabular-nums">{item.quantity}</span>
                  <button type="button" onClick={() => onInc(item)} disabled={locked} aria-label={`${item.product_name} miqdorini oshirish`} className="w-11 h-11 rounded-r-lg flex items-center justify-center hover:bg-brand-olive/15 active:bg-brand-olive/25 touch-manipulation">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <div className="min-w-0 text-right text-sm font-bold leading-snug text-brand-ink break-words tabular-nums">{formatUZS(item.subtotal)}</div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="odina-cart-summary max-h-[48%] overflow-y-auto overscroll-contain border-t border-brand-sand/50 p-3 shrink-0 space-y-2.5 bg-card">
        <button
          type="button"
          onClick={() => setAdjustmentsOpen((open) => !open)}
          aria-expanded={adjustmentsOpen}
          className="w-full min-h-11 rounded-xl border border-border bg-card px-3 flex items-center justify-between gap-2 text-sm font-semibold hover:bg-secondary/60 touch-manipulation"
        >
          <span className="flex items-center gap-2 min-w-0">
            <Ticket className="w-4 h-4 shrink-0 text-brand-ink" />
            <span className="truncate">Chegirma va tuzatish</span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground">
            {discount > 0 ? `−${formatUZS(discount)}` : 'Ochish'}
            <ChevronDown className={`w-4 h-4 transition-transform ${adjustmentsOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>
        {adjustmentsOpen && (
          <div className="space-y-2.5 rounded-xl border border-border/70 bg-secondary/20 p-2.5">
            <DiscountRow
              discountCode={discountCode}
              discount={couponDiscount}
              onApplyDiscount={onApplyDiscount}
              onRemoveDiscount={onRemoveDiscount}
              discountError={discountError}
            />
            {cart.length > 0 && (
              <RoundingRow
                subtotal={subtotal}
                discountCode={discountCode}
                roundingTarget={roundingTarget}
                adjustmentMode={adjustmentMode}
                roundingError={roundingError}
                onApplyRounding={onApplyRounding}
                onApplyManualDiscount={onApplyManualDiscount}
                onRemoveRounding={onRemoveRounding}
              />
            )}
          </div>
        )}
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Oraliq summa</span>
          <span className="font-medium text-foreground">{formatUZS(subtotal)}</span>
        </div>
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
        {tableMode && <div className="rounded-xl border border-brand-olive/30 bg-brand-olive/5 p-2.5 space-y-2">
          <p className="text-xs font-semibold text-brand-ink">{tableDirty ? '● Saqlanmagan o‘zgarishlar bor' : tableSaved ? '✓ Stolga saqlangan · hali to‘lanmagan' : 'Mahsulot qo‘shib, stolga saqlang'}</p>
          {(discountCode || roundingTarget !== null) && <p className="text-xs text-muted-foreground">Chegirma to‘lov paytida qayta qo‘llanadi.</p>}
          <Button type="button" variant="outline" onClick={onSaveTable}
            disabled={locked || (!tableDirty && !tableSaved) || cart.length === 0 || savingTable}
            className="w-full min-w-0 min-h-11 h-auto py-2 whitespace-normal text-center rounded-xl border-brand-olive bg-card text-brand-ink font-bold hover:bg-brand-olive/15">
            {savingTable ? 'Saqlanmoqda…' : tableDirty ? 'Stolga saqlash →' : 'Yangi buyurtmaga o‘tish'}
          </Button>
        </div>}
      </div>
      <div className="odina-cart-checkout shrink-0 border-t border-brand-sand/50 bg-card p-3 safe-bottom">
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

function RoundingRow({ subtotal, discountCode, roundingTarget, adjustmentMode, roundingError, onApplyRounding, onApplyManualDiscount, onRemoveRounding }) {
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
          <Input type="text" inputMode="numeric" aria-label="Ayiriladigan summa" placeholder="2000 yoki -2000" value={amount} onChange={(event) => setAmount(event.target.value)} className="h-11 min-w-0 flex-1" />
          <Button type="button" variant="outline" className="h-11 shrink-0" disabled={!amount.trim()} onClick={() => { if (onApplyManualDiscount(amount)) { setAmount(''); setManualOpen(false); } }}>Qo‘llash</Button>
        </div>
      )}
      {discountCode && <p className="text-xs text-muted-foreground">Avval chegirma kodini olib tashlang.</p>}
      {roundingError && <p role="alert" className="text-xs text-destructive">{roundingError}</p>}
    </div>
  );
}

function DiscountRow({ discountCode, discount, onApplyDiscount, onRemoveDiscount, discountError }) {
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