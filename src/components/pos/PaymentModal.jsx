import React, { useState, useEffect, useRef } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Plus, X, Check, CreditCard, Smartphone, Banknote, ReceiptText } from 'lucide-react';
import { PAYMENT_METHODS, formatUZS } from '@/lib/pos';

const RECEIPT_PRINT_KEY = 'odina-pos:print-receipt';

// The first method covers the balance after the other methods.
function balanceFirstPayment(rows, total) {
  if (rows.length === 0) return rows;
  const otherPayments = rows.slice(1).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  return rows.map((row, index) => index === 0
    ? { ...row, amount: Math.max(0, total - otherPayments) }
    : row);
}

function savedReceiptPreference() {
  try {
    return window.localStorage.getItem(RECEIPT_PRINT_KEY) !== 'off';
  } catch {
    return true;
  }
}

export default function PaymentModal({ open, total, onClose, onConfirm, loading, offline = false, fullDiscount = false, discountControls = null, discountPending = false, checking = false, isDelivery = false, attemptKey = '', retryPending = false }) {
  const [payments, setPayments] = useState([]);
  const [error, setError] = useState('');
  const [showMethodPicker, setShowMethodPicker] = useState(false);
  const [printReceipt, setPrintReceipt] = useState(savedReceiptPreference);

  const changePrintReceipt = (enabled) => {
    setPrintReceipt(enabled);
    try { window.localStorage.setItem(RECEIPT_PRINT_KEY, enabled ? 'on' : 'off'); } catch { /* Keep the choice for this page when storage is unavailable. */ }
  };

  const previous = useRef({ open: false, total, attemptKey: null });
  useEffect(() => {
    const before = previous.current;
    if (open && !before.open && (!attemptKey || attemptKey !== before.attemptKey)) {
      setPayments([]);
      setError('');
      setShowMethodPicker(total > 0);
    } else if (open && total !== before.total) {
      setPayments((rows) => {
        if (total <= 0) return [];
        if (rows.length === 0) return [];
        if (rows.length === 1 && Number(rows[0].amount) === before.total) {
          return [{ ...rows[0], amount: total }];
        }
        if (rows.length > 1) return balanceFirstPayment(rows, total);
        return rows;
      });
      setError('');
    }
    previous.current = { open, total, attemptKey: open ? attemptKey : before.attemptKey };
  }, [open, total, attemptKey]);

  const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const remaining = Math.max(0, total - paid);
  const overpay = Math.max(0, paid - total);

  const updatePayment = (idx, field, value) => {
    setPayments((prev) => {
      const rows = prev.map((p, i) => i === idx
        ? { ...p, [field]: field === 'method' ? value : (value === '' ? '' : Math.max(0, Number(value) || 0)) }
        : p);
      return field === 'amount' && idx > 0 ? balanceFirstPayment(rows, total) : rows;
    });
    setError('');
  };

  const addPaymentMethod = (methodId) => {
    if (!methodId || payments.some((p) => p.method === methodId)) return;
    setPayments((prev) => [
      ...prev,
      { method: methodId, amount: remaining > 0 ? remaining : '' },
    ]);
    setShowMethodPicker(false);
    setError('');
  };

  const availableMethods = PAYMENT_METHODS.filter(
    (method) => !payments.some((payment) => payment.method === method.id),
  );

  const methodIcon = (method) => {
    if (method.id === 'cash') return Banknote;
    if (method.group === 'card') return CreditCard;
    if (method.group === 'online') return Smartphone;
    return CreditCard;
  };

  const removeRow = (idx) => {
    setPayments((prev) => balanceFirstPayment(prev.filter((_, i) => i !== idx), total));
    setError('');
  };

  const handleConfirm = () => {
    if (checking || loading || discountPending) return;
    if (total <= 0) {
      if (!fullDiscount) {
        setError('To‘lov summasi 0 UZS. Mahsulot narxini yoki savatni tekshiring.');
        return;
      }
      onConfirm([], printReceipt);
      return;
    }
    const valid = payments.filter((p) => Number(p.amount) > 0);
    if (valid.length === 0) { setError('Avval to‘lov usulini tanlang.'); setShowMethodPicker(true); return; }
    const sum = valid.reduce((s, p) => s + Number(p.amount), 0);
    // Match the backend: no 1 UZS tolerance, or the cashier sees a false success path.
    if (sum !== total) {
      setError(`Jami ${formatUZS(total)}, to‘lovlar esa ${formatUZS(sum)}. Farq: ${formatUZS(Math.abs(sum - total))}.`);
      return;
    }
    onConfirm(valid.map((p) => ({ method: p.method, amount: Number(p.amount) })), printReceipt);
  };

  // Remove the modal immediately on close; printing must not interrupt its exit animation.
  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="odina-payment-workbench sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{isDelivery ? '🚚 Dostavka · To‘lov' : 'To‘lov'}</DialogTitle>
        </DialogHeader>

        <div className="odina-payment-total rounded-2xl bg-primary/10 px-4 py-3 mb-4 flex items-center justify-between">
          <span className="text-sm font-medium text-brand-ink">To‘lanadigan jami</span>
          <span className="font-display text-2xl font-bold text-brand-ink">{formatUZS(total)}</span>
        </div>

        {/* Announce the check without adding/removing space above the touch targets. */}
        <span role="status" className="sr-only">{checking ? 'Qoldiq tekshirilmoqda.' : ''}</span>

        {discountControls && <div className="odina-payment-adjustments border-b border-border pb-4 mb-1">{discountControls}</div>}

        {total <= 0 && fullDiscount && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm font-medium text-emerald-700 flex items-center gap-2">
            <Check className="w-5 h-5 shrink-0" />
            Tasdiqlangan 100% chegirma — to‘lov talab qilinmaydi.
          </div>
        )}
        {total <= 0 && !fullDiscount && (
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-sm font-medium text-red-800">
            To‘lov summasi 0 UZS. Savdoni yakunlashdan oldin mahsulot narxini yoki savatni tekshiring.
          </div>
        )}

        {offline && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 mb-3 text-sm text-amber-900">
            Savdo avval shu qurilmaga saqlanadi, keyin serverga navbat bilan yuboriladi.
          </div>
        )}
        {retryPending && <p role="status" className="text-sm text-amber-900">
          Avvalgi to‘lov natijasi tekshiriladi. Mahsulot va to‘lov usullari o‘zgarmaydi; qayta pul olmang.
        </p>}

        <div className={total <= 0 ? 'hidden' : 'space-y-2.5'}>
          {payments.length > 0 && <div className={`odina-payment-column-labels ${payments.length > 1 ? 'odina-payment-split-labels' : ''}`} aria-hidden="true"><span>To‘lov usuli</span><span>Summa (UZS)</span></div>}
          {payments.map((p, idx) => (
            <div key={idx} className="odina-payment-row flex gap-2 items-center">
              <OdinaSelect
                value={p.method}
                disabled={retryPending}
                aria-label={`To‘lov usuli ${idx + 1}`}
                onChange={(e) => updatePayment(idx, 'method', e.target.value)}
                className="h-10 rounded-lg border border-input bg-card px-2 text-sm font-medium flex-1 min-w-0"
              >
                {PAYMENT_METHODS
                  .filter((m) => m.id === p.method || !payments.some((other, otherIdx) => otherIdx !== idx && other.method === m.id))
                  .map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
              </OdinaSelect>
              <Input
                type="number"
                step={1000}
                min={0}
                aria-label={`To‘lov summasi ${idx + 1}`}
                value={p.amount}
                disabled={retryPending}
                onChange={(e) => updatePayment(idx, 'amount', e.target.value)}
                className="w-32 h-10 text-right font-medium"
                placeholder="0"
              />
              {payments.length > 1 && (
                <button type="button" disabled={retryPending} aria-label="To‘lov usulini olib tashlash" onClick={() => removeRow(idx)} className="odina-payment-remove w-9 h-10 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-destructive shrink-0">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className={total <= 0 ? 'hidden' : 'mt-3'}>
          <div className="odina-payment-balance-toolbar flex items-center justify-between text-sm gap-3">
            <button
              type="button"
              onClick={() => setShowMethodPicker((prev) => !prev)}
              disabled={retryPending || availableMethods.length === 0}
              className="min-h-11 rounded-xl px-2 -ml-2 text-brand-ink font-medium flex items-center gap-1.5 disabled:opacity-40"
              aria-expanded={showMethodPicker}
            >
              <Plus className="w-4 h-4" /> {payments.length === 0 ? 'To‘lov usulini tanlang' : 'To‘lov usuli qo‘shish'}
            </button>
            <div className="text-right shrink-0">
              {remaining > 0 ? (
                <span className="text-destructive font-medium">Qoldi: {formatUZS(remaining)}</span>
              ) : overpay > 0 ? (
                <span className="text-brand-ink font-medium">Qaytim: {formatUZS(overpay)}</span>
              ) : (
                <span className="text-emerald-600 font-medium flex items-center gap-1"><Check className="w-4 h-4" /> To‘liq</span>
              )}
            </div>
          </div>

          {showMethodPicker && availableMethods.length > 0 && (
            <div className="odina-payment-method-picker mt-3 rounded-2xl border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <p className="font-semibold text-sm text-foreground">To‘lov usulini tanlang</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {remaining > 0 ? `Qolgan summa: ${formatUZS(remaining)}` : 'Yangi usul uchun summani keyin kiriting'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowMethodPicker(false)}
                  className="w-9 h-9 rounded-xl border border-border bg-card flex items-center justify-center text-muted-foreground"
                  aria-label="To‘lov usullarini yopish"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {availableMethods.map((method) => {
                  const MethodIcon = methodIcon(method);
                  return (
                    <button
                      key={method.id}
                      type="button"
                      disabled={retryPending}
                      onClick={() => addPaymentMethod(method.id)}
                      className="odina-payment-method min-h-14 rounded-xl border border-border bg-card px-3 py-2.5 flex items-center gap-2.5 text-left font-semibold text-sm hover:bg-primary/10 hover:border-primary/40 transition-colors"
                    >
                      <span className="w-9 h-9 rounded-lg bg-primary/10 text-brand-ink flex items-center justify-center shrink-0">
                        <MethodIcon className="w-4.5 h-4.5" />
                      </span>
                      <span className="leading-tight">{method.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {error && <p role="alert" className="text-sm text-destructive mt-2">{error}</p>}

        <div className="odina-payment-footer mt-4 grid grid-cols-2 items-center gap-2 border-t border-border pt-4 sm:grid-cols-[max-content_max-content_minmax(0,1fr)]">
          <div className="odina-payment-print-choice flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-3">
            <ReceiptText className="h-4 w-4 text-brand-ink" aria-hidden="true" />
            <label htmlFor="print-receipt" className="cursor-pointer whitespace-nowrap text-sm font-semibold">Chek chiqarish</label>
            <Switch
              id="print-receipt"
              checked={printReceipt}
              onCheckedChange={changePrintReceipt}
              disabled={loading}
              aria-label="Savdo chekini chop etish"
            />
            <span className="w-7 text-xs font-bold text-muted-foreground">{printReceipt ? 'Ha' : 'Yo‘q'}</span>
          </div>
          <Button variant="outline" onClick={onClose} disabled={loading || retryPending} className="min-h-11 whitespace-nowrap">
            Bekor qilish
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={checking || loading || discountPending || (total <= 0 && !fullDiscount) || (total > 0 && payments.length === 0)}
            className="odina-payment-confirm col-span-2 min-h-11 whitespace-nowrap bg-primary text-primary-foreground hover:bg-primary-strong sm:col-span-1"
          >
            {loading
              ? 'Amalga oshirilmoqda…'
              : checking ? 'Tekshirilmoqda…' : (offline ? 'Qurilmaga saqlash' : 'Yakunlash')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
