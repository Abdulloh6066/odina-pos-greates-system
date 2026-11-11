import React, { useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { formatUZS } from '@/lib/pos';
import { buildIdempotencyKey } from '@/lib/orders';
import { orderRequestScope, readOrderRequest, retainOrderRequest, clearOrderRequest, orderRequestDefinitelyRejected } from '@/lib/order-request-retry';
import SharedOdinaSelect from '@/components/ui/odina-select';
import { Button as SharedButton } from '@/components/ui/button';
import { Input as SharedInput } from '@/components/ui/input';
import { Label as SharedLabel } from '@/components/ui/label';
import { Textarea as SharedTextarea } from '@/components/ui/textarea';
import { Dialog, DialogContent as SharedDialogContent, DialogFooter, DialogHeader, DialogTitle as SharedDialogTitle, DialogDescription as SharedDialogDescription } from '@/components/ui/dialog';

const Button = /** @type {React.ComponentType<React.ComponentPropsWithRef<'button'> & import('class-variance-authority').VariantProps<typeof import('@/components/ui/button').buttonVariants> & { asChild?: boolean }>} */ (SharedButton);
const Input = /** @type {React.ComponentType<React.ComponentPropsWithRef<'input'>>} */ (SharedInput);
const Textarea = /** @type {React.ComponentType<React.ComponentPropsWithRef<'textarea'>>} */ (SharedTextarea);
const Label = /** @type {React.ComponentType<React.ComponentPropsWithRef<typeof import('@radix-ui/react-label').Root>>} */ (SharedLabel);
const DialogContent = /** @type {React.ComponentType<React.ComponentPropsWithRef<typeof import('@radix-ui/react-dialog').Content>>} */ (SharedDialogContent);
const DialogTitle = /** @type {React.ComponentType<React.ComponentPropsWithRef<typeof import('@radix-ui/react-dialog').Title>>} */ (SharedDialogTitle);
const DialogDescription = /** @type {React.ComponentType<React.ComponentPropsWithRef<typeof import('@radix-ui/react-dialog').Description>>} */ (SharedDialogDescription);
const OdinaSelect = /** @type {React.ComponentType<React.SelectHTMLAttributes<HTMLSelectElement> & { contentClassName?: string; placeholder?: string }>} */ (SharedOdinaSelect);
const ACCOUNTS = [
  { id: 'cash', label: 'Naqd pul' }, { id: 'bank_all', label: 'Bank' }, { id: 'online', label: 'Online' },
];
const BANK_ACCOUNTS = ['bank', 'uzcard', 'humo'];
const paymentAccount = account => ['cash', 'online', 'bank_all', ...BANK_ACCOUNTS].includes(account);
const accountBalance = (balances, account) => (account === 'bank_all' ? BANK_ACCOUNTS : [account])
  .reduce((sum, key) => sum + Number(balances?.[key] || 0), 0);
const requestScope = (user, debt) => orderRequestScope(user?.id, 'pay_opening_debt', debt?.id);
export const hasPendingOpeningDebtPayment = (user, debt) => user?.role === 'admin' && Boolean(user?.id && debt?.id && readOrderRequest(requestScope(user, debt)));
const errorText = error => error?.response?.data?.error || error?.data?.error || error?.message || 'To‘lov natijasi tasdiqlanmadi.';

// Callers key this control to actor, visible scope and debt. Both entry points use
// the same persisted intent, including when a confirmed write lost its response.
export function OpeningDebtPaymentButton({ debt, user, allowed, onSaved }) {
  const [open, setOpen] = useState(false);
  if (!allowed || user?.role !== 'admin' || !user.id || !debt?.id || !debt.supplier_id) return null;
  const pending = readOrderRequest(requestScope(user, debt));
  if (!pending && (!['unpaid', 'partial'].includes(debt.status) || Number(debt.remaining_debt) <= 0)) return null;
  return <>
    <Button type="button" variant="outline" className="min-h-11 rounded-xl" onClick={() => setOpen(true)} aria-label={`${debt.supplier_name_snapshot || 'Yetkazib beruvchi'} — boshlang‘ich qarz to‘lovi`}>
      {pending ? 'To‘lovni qayta tekshirish' : 'To‘lov'}
    </Button>
    {open && <OpeningDebtPaymentDialog key={`${user.id}:${debt.id}`} debt={debt} user={user} allowed={allowed}
      onClose={() => setOpen(false)} onSaved={result => { setOpen(false); onSaved(result); }} />}
  </>;
}

export default function OpeningDebtPaymentDialog({ debt, user, allowed, onClose, onSaved }) {
  const scope = requestScope(user, debt);
  const pendingRef = useRef(readOrderRequest(scope));
  const [pending, setPending] = useState(pendingRef.current);
  const [account, setAccount] = useState(pending?.account || 'cash');
  const [amount, setAmount] = useState(pending ? String(pending.amount) : '');
  const [notes, setNotes] = useState(pending?.notes || '');
  const [reviewing, setReviewing] = useState(Boolean(pending));
  const [ownerPin, setOwnerPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [balances, setBalances] = useState(null);
  const [balanceError, setBalanceError] = useState('');
  const [balanceRefresh, setBalanceRefresh] = useState(0);
  const flight = useRef(false);
  const active = useRef(true);
  const permitted = allowed && user?.role === 'admin' && Boolean(user?.id && debt?.id && debt?.supplier_id);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setBalances(null); setBalanceError('');
    if (!permitted) return () => { cancelled = true; };
    (async () => {
      try {
        const response = await base44.functions.invoke('budget-ledger', { action: 'summary' });
        const data = response?.data || response;
        if (!Array.isArray(data?.balances) || data.balances.some(row => !Number.isFinite(Number(row.balance)))) {
          throw new Error(data?.error || 'Budget qoldiqlari olinmadi.');
        }
        if (!cancelled) setBalances(Object.fromEntries(data.balances.map(row => [row.account, Number(row.balance)])));
      } catch (failure) { if (!cancelled) setBalanceError(errorText(failure)); }
    })();
    return () => { cancelled = true; };
  }, [permitted, user?.id, debt?.id, balanceRefresh]);

  const value = Number(amount);
  const remaining = Number(debt?.remaining_debt);
  const available = accountBalance(balances, account);
  const validAmount = /^\d+$/.test(String(amount)) && Number.isSafeInteger(value) && value > 0;
  const valid = validAmount && value <= remaining && balances !== null && value <= available
    && ACCOUNTS.some(item => item.id === account) && ['unpaid', 'partial'].includes(debt?.status);
  const validPin = /^\d{4,8}$/.test(ownerPin);
  const locked = reviewing || saving || Boolean(pending);
  // An older pending intent must keep its exact physical account and key.
  const accountOptions = pending && !ACCOUNTS.some(item => item.id === pending.account)
    ? [...ACCOUNTS, { id: pending.account, label: BANK_ACCOUNTS.includes(pending.account) ? 'Bank' : pending.account }] : ACCOUNTS;
  const accountLabel = accountOptions.find(item => item.id === account)?.label || account;
  const close = () => { if (!flight.current) { setOwnerPin(''); onClose(); } };

  const submit = async () => {
    if (!permitted || flight.current || !reviewing || !validPin || (!pendingRef.current && !valid)) return;
    flight.current = true; setSaving(true); setError('');
    const hadPending = Boolean(pendingRef.current);
    const pin = ownerPin;
    setOwnerPin('');
    try {
      const payload = retainOrderRequest(scope, pendingRef.current || {
        action: 'pay_supplier', supplier_id: debt.supplier_id, opening_debt_id: debt.id,
        ...(debt.location_id ? { location_id: debt.location_id } : {}),
        account, amount: value, notes: notes.trim(), idempotency_key: buildIdempotencyKey('opening-payment'),
      });
      pendingRef.current = payload; setPending(payload);
      if (payload.action !== 'pay_supplier' || payload.opening_debt_id !== debt.id || payload.supplier_id !== debt.supplier_id
        || (!hadPending && (payload.location_id || '') !== (debt.location_id || '')) || !paymentAccount(payload.account)) {
        throw new Error('Saqlangan to‘lov ushbu qarz yoki omborga mos emas. Yangi to‘lov yuborilmadi.');
      }
      if (!hadPending && (payload.amount !== value || payload.account !== account || payload.notes !== notes.trim())) {
        setAmount(String(payload.amount)); setAccount(payload.account); setNotes(payload.notes || '');
        throw new Error('Avvalgi to‘lov so‘rovi topildi. Uning summasi va hisobini tekshirib, PINni qayta kiriting.');
      }
      // PIN is sent only for this call and never included in session storage.
      const response = await base44.functions.invoke('budget-ledger', { ...payload, owner_pin: pin });
      const data = response?.data || response;
      if (data?.opening_debt_id !== debt.id || data.paid !== true || data.amount !== payload.amount
        || data.account !== payload.account || (payload.location_id && data.location_id !== payload.location_id)
        || !Number.isSafeInteger(data.opening_remaining_debt) || data.opening_remaining_debt < 0 || !data.payment_number
        || !Array.isArray(data.payments) || !data.payments.length
        || data.payments.some(payment => payment.opening_debt_id !== debt.id || payment.supplier_id !== debt.supplier_id)
        || data.payments.reduce((sum, payment) => sum + Number(payment.amount), 0) !== payload.amount) {
        throw Object.assign(new Error(data?.error || 'To‘lov tasdig‘i to‘liq olinmadi. Avvalgi to‘lovni qayta tekshiring.'), { data });
      }
      clearOrderRequest(scope); pendingRef.current = null;
      if (active.current) { setPending(null); onSaved(data); }
    } catch (failure) {
      const data = failure?.response?.data || failure?.data;
      if ((!hadPending && orderRequestDefinitelyRejected(failure)) || data?.operation_reversed === true) {
        clearOrderRequest(scope); pendingRef.current = null;
        if (active.current) { setPending(null); setReviewing(false); setBalanceRefresh(value => value + 1); }
      }
      if (active.current) setError(errorText(failure));
    } finally { flight.current = false; if (active.current) setSaving(false); }
  };

  if (!permitted) return null;
  return <Dialog open onOpenChange={open => !open && close()}>
    <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto" onEscapeKeyDown={event => flight.current && event.preventDefault()} onPointerDownOutside={event => flight.current && event.preventDefault()}>
      <DialogHeader className="">
        <DialogTitle>Boshlang‘ich qarz to‘lovi</DialogTitle>
        <DialogDescription>{debt.supplier_name_snapshot || 'Yetkazib beruvchi'} · {debt.location_name_snapshot || (debt.location_id ? 'Biriktirilgan ombor' : 'Omborga biriktirilmagan')}</DialogDescription>
      </DialogHeader>
      <p className="text-sm">Faqat shu boshlang‘ich qarz to‘lanadi. Mablag‘ tanlangan Budget hisobidan yechiladi va qarz shuncha kamayadi. Kirim hujjatlari va boshqa qarzlar o‘zgarmaydi.</p>
      <p className="text-sm">Qolgan qarz: <strong>{formatUZS(remaining)}</strong></p>
      {balances === null && !balanceError && <p role="status" className="text-sm text-muted-foreground">Budget qoldiqlari yuklanmoqda…</p>}
      {balanceError && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">Budget yuklanmadi: {balanceError}</p><Button type="button" variant="outline" disabled={saving} onClick={() => setBalanceRefresh(value => value + 1)} className="min-h-11">Budgetni qayta yuklash</Button></div>}
      <fieldset disabled={locked} className="space-y-4">
        <div><Label htmlFor="opening-payment-account">Budget hisobi</Label><OdinaSelect id="opening-payment-account" value={account} disabled={locked} onChange={event => !locked && setAccount(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
          {accountOptions.map(item => <option key={item.id} value={item.id}>{item.label}{balances !== null ? ` · ${formatUZS(accountBalance(balances, item.id))}` : ''}</option>)}
        </OdinaSelect></div>
        <div><Label htmlFor="opening-payment-amount">To‘lov summasi (UZS)</Label><Input data-money id="opening-payment-amount" inputMode="numeric" value={amount} disabled={locked} onChange={event => !locked && setAmount(event.target.value)} placeholder="Butun musbat summa" className="mt-1 min-h-11" />
          {!pending && validAmount && value > remaining && <p className="mt-1 text-sm text-destructive">Summa qolgan qarzdan oshmasligi kerak.</p>}
          {!pending && validAmount && balances !== null && value > available && <p className="mt-1 text-sm text-destructive">Tanlangan Budget hisobida mablag‘ yetarli emas.</p>}
        </div>
        <div><Label htmlFor="opening-payment-notes">Izoh (ixtiyoriy)</Label><Textarea id="opening-payment-notes" maxLength={2000} value={notes} disabled={locked} onChange={event => !locked && setNotes(event.target.value)} className="mt-1" /></div>
      </fieldset>
      {reviewing && <section aria-label="To‘lovni tasdiqlash" className="rounded-xl border border-border bg-secondary/40 p-4 space-y-2 text-sm">
        <h3 className="font-semibold">{pending ? 'Avvalgi to‘lovni tekshirish' : 'To‘lovni tasdiqlang'}</h3>
        <p>{debt.supplier_name_snapshot || 'Yetkazib beruvchi'} uchun {formatUZS(value)} · Budget: {accountLabel}.</p>
        {pending && (pending.location_id || '') !== (debt.location_id || '') && <p className="text-xs">Qarzning ombor ma’lumoti keyin o‘zgargan. Avvalgi to‘lov aynan saqlangan ombor doirasi bilan tekshiriladi.</p>}
        {pending ? <p role="status">Avvalgi so‘rov saqlandi. Summa, hisob, izoh va qarz o‘zgarmasdan qayta tekshiriladi; bu yangi to‘lov emas. PINni qayta kiriting.</p> : <>
          <p>Budgetdagi {accountLabel}: {formatUZS(available)} → {formatUZS(available - value)}.</p>
          <p>Shu boshlang‘ich qarz: {formatUZS(remaining)} → {formatUZS(remaining - value)}.</p>
          <p className="text-xs text-muted-foreground">Server to‘lov paytida joriy qoldiqlarni yana tekshiradi.</p>
        </>}
        <Label htmlFor="opening-payment-pin">Owner PIN</Label>
        <Input id="opening-payment-pin" type="password" autoComplete="one-time-code" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" inputMode="numeric" maxLength={8} value={ownerPin} disabled={saving} onChange={event => !saving && setOwnerPin(event.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="4–8 xonali PIN" className="min-h-11" />
      </section>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={close} className="min-h-11">{pending ? 'Yopish' : 'Bekor qilish'}</Button>
        {reviewing && !pending && <Button type="button" variant="outline" disabled={saving} onClick={() => { setReviewing(false); setOwnerPin(''); }} className="min-h-11">Orqaga</Button>}
        {!reviewing ? <Button type="button" disabled={!valid} onClick={() => { if (valid) { setReviewing(true); setError(''); } }} className="min-h-11">To‘lovni ko‘rib chiqish</Button>
          : <Button type="button" disabled={saving || !validPin || (!pending && !valid)} onClick={submit} className="min-h-11">{saving ? 'Tekshirilmoqda…' : pending ? 'Avvalgi to‘lovni tekshirish' : 'Budgetdan to‘lash'}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
