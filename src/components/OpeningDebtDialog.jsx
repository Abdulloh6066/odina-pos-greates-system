import React, { useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDate, formatUzbekistanDateTime, uzbekistanDateKey } from '@/lib/uzbekistan-time';
import { buildIdempotencyKey } from '@/lib/orders';
import { orderRequestScope, readOrderRequest, retainOrderRequest, clearOrderRequest, orderRequestDefinitelyRejected } from '@/lib/order-request-retry';
import { Button as SharedButton } from '@/components/ui/button';
import { Input as SharedInput } from '@/components/ui/input';
import { Label as SharedLabel } from '@/components/ui/label';
import { Textarea as SharedTextarea } from '@/components/ui/textarea';
import { Dialog, DialogContent as SharedDialogContent, DialogFooter, DialogHeader, DialogTitle as SharedDialogTitle, DialogDescription as SharedDialogDescription } from '@/components/ui/dialog';

// Local prop contracts preserve the shared primitives without widening their APIs.
const Button = /** @type {React.ComponentType<React.ComponentPropsWithRef<'button'> & import('class-variance-authority').VariantProps<typeof import('@/components/ui/button').buttonVariants> & { asChild?: boolean }>} */ (SharedButton);
const Input = /** @type {React.ComponentType<React.ComponentPropsWithRef<'input'>>} */ (SharedInput);
const Textarea = /** @type {React.ComponentType<React.ComponentPropsWithRef<'textarea'>>} */ (SharedTextarea);
const Label = /** @type {React.ComponentType<React.ComponentPropsWithRef<typeof import('@radix-ui/react-label').Root>>} */ (SharedLabel);
const DialogContent = /** @type {React.ComponentType<React.ComponentPropsWithRef<typeof import('@radix-ui/react-dialog').Content>>} */ (SharedDialogContent);
const DialogTitle = /** @type {React.ComponentType<React.ComponentPropsWithRef<typeof import('@radix-ui/react-dialog').Title>>} */ (SharedDialogTitle);
const DialogDescription = /** @type {React.ComponentType<React.ComponentPropsWithRef<typeof import('@radix-ui/react-dialog').Description>>} */ (SharedDialogDescription);

// Mount with a key scoped to the actor and recipient so an unresolved request
// can never migrate to another recipient. The existing retry store survives refresh.
export default function OpeningDebtDialog({ recipient, debt, payments = [], user, allowed, onClose, onSaved }) {
  const scope = orderRequestScope(user?.id, 'create_opening_debt', recipient?.id);
  const pendingRef = useRef(readOrderRequest(scope));
  const [pending, setPending] = useState(pendingRef.current);
  const [amount, setAmount] = useState(pending?.amount ?? '');
  const [effectiveDate, setEffectiveDate] = useState(pending?.effective_date || '');
  const [notes, setNotes] = useState(pending?.notes || '');
  const [saving, setSaving] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState('');
  const locked = saving || Boolean(pending);
  const amountValue = Number(amount);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
    && uzbekistanDateKey(Date.parse(`${effectiveDate}T00:00:00+05:00`)) === effectiveDate;
  const valid = /^\d+$/.test(String(amount)) && Number.isSafeInteger(amountValue) && amountValue > 0 && validDate;

  const save = async () => {
    if (!allowed || user?.role !== 'admin' || !recipient?.id || flight.current || (!pendingRef.current && (!valid || debt))) return;
    flight.current = true; setSaving(true); setError('');
    try {
      const payload = retainOrderRequest(scope, pendingRef.current || {
        action: 'create_opening_debt', supplier_id: recipient.id, amount: amountValue,
        effective_date: effectiveDate, notes: notes.trim(), idempotency_key: buildIdempotencyKey('opening-debt'),
      });
      if (payload.supplier_id !== recipient.id || payload.action !== 'create_opening_debt') throw new Error('Saqlangan so‘rov qabul qiluvchiga mos emas.');
      pendingRef.current = payload; setPending(payload);
      const result = await base44.functions.invoke('supplier-ledger', payload);
      const data = result?.data || result;
      if (!data?.opening_debt?.id || data.opening_debt.supplier_id !== recipient.id) {
        throw Object.assign(new Error(data?.error || 'Server tasdig‘i olinmadi. Shu so‘rovni qayta tekshiring.'), { data });
      }
      clearOrderRequest(scope); pendingRef.current = null; setPending(null);
      onSaved(data.opening_debt);
    } catch (failure) {
      if (orderRequestDefinitelyRejected(failure)) {
        clearOrderRequest(scope); pendingRef.current = null; setPending(null);
      }
      setError(failure?.response?.data?.error || failure?.data?.error || failure?.message || 'Saqlash natijasi noma’lum. Shu so‘rovni qayta tekshiring.');
    } finally { flight.current = false; setSaving(false); }
  };

  if (!allowed || user?.role !== 'admin' || !recipient) return null;
  return (
    <Dialog open onOpenChange={open => !open && !flight.current && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader className="">
          <DialogTitle>Boshlang‘ich qarz</DialogTitle>
          <DialogDescription>{recipient.name} · Barcha do‘konlar</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Avvaldan mavjud qarz bir marta kiritiladi va tahrirlanmaydi. Bu amal tovar kirimi yoki pul harakati yaratmaydi. Boshlang‘ich qarz xaridlardan alohida hisobga olinadi.</p>
        {debt && <section aria-label="Boshlang‘ich qarz tarixi" className="space-y-3 rounded-xl border border-border p-4">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>Boshlang‘ich summa</dt><dd className="text-right font-semibold">{formatUZS(debt.debt_amount)}</dd>
            <dt>Qolgan qarz</dt><dd className="text-right font-semibold">{formatUZS(debt.remaining_debt)}</dd>
            <dt>Qarz sanasi</dt><dd className="text-right">{formatUzbekistanDate(`${debt.effective_date}T00:00:00+05:00`)}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">Kiritildi: {formatUzbekistanDateTime(debt.created_at)}{debt.created_by_name ? ` · ${debt.created_by_name}` : ''}</p>
          {debt.notes && <p className="text-sm whitespace-pre-wrap break-words">{debt.notes}</p>}
          <h3 className="text-sm font-semibold">To‘lovlar tarixi</h3>
          {payments.length === 0 ? <p className="text-sm text-muted-foreground">Hali to‘lov yo‘q.</p> : <ul className="space-y-2">
            {payments.map(payment => <li key={payment.id} className="border-t border-border pt-2 text-sm">
              <div className="flex justify-between gap-3"><span>{payment.payment_number}</span><strong>{formatUZS(payment.amount)}</strong></div>
              <p className="text-xs text-muted-foreground">{formatUzbekistanDateTime(payment.paid_at)} · {payment.user_name || payment.authorized_by_name || '—'}</p>
              {payment.notes && <p className="break-words">{payment.notes}</p>}
            </li>)}
          </ul>}
        </section>}
        {(!debt || pending) && <>
          <fieldset disabled={locked} className="space-y-4">
            <div><Label htmlFor="opening-debt-amount">Summa (UZS)</Label><Input id="opening-debt-amount" inputMode="numeric" value={amount} disabled={locked} onChange={event => !locked && setAmount(event.target.value)} placeholder="Butun musbat summa" className="mt-1 min-h-11" /></div>
            <div><Label htmlFor="opening-debt-date">Qarz sanasi (Toshkent vaqti)</Label><Input id="opening-debt-date" type="date" value={effectiveDate} disabled={locked} onChange={event => !locked && setEffectiveDate(event.target.value)} className="mt-1 min-h-11" /></div>
            <div><Label htmlFor="opening-debt-notes">Izoh (ixtiyoriy)</Label><Textarea id="opening-debt-notes" maxLength={2000} value={notes} disabled={locked} onChange={event => !locked && setNotes(event.target.value)} className="mt-1" /></div>
          </fieldset>
          {pending && <p role="status" className="text-sm text-muted-foreground">Avvalgi so‘rov saqlandi. Natija tasdiqlanmaguncha summa, sana va izoh o‘zgarmaydi. Qayta tekshirish aynan shu so‘rovni yuboradi.</p>}
        </>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={saving} onClick={onClose} className="min-h-11">Yopish</Button>
          {(!debt || pending) && <Button disabled={saving || (!pending && !valid)} onClick={save} className="min-h-11">{saving ? 'Tekshirilmoqda…' : pending ? 'Avvalgi so‘rovni tekshirish' : 'Boshlang‘ich qarzni saqlash'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
