import React, { useRef, useState } from 'react';
import SharedOdinaSelect from '@/components/ui/odina-select';
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

const OdinaSelect = /** @type {React.ComponentType<React.SelectHTMLAttributes<HTMLSelectElement> & { contentClassName?: string; placeholder?: string }>} */ (SharedOdinaSelect);

// Mount with a key scoped to the actor and recipient so an unresolved request
// can never migrate to another recipient. The existing retry store survives refresh.
export default function OpeningDebtDialog({ recipient, debt, payments = [], locations = [], user, allowed, onClose, onSaved }) {
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
          <DialogDescription>{recipient.name} · {debt?.location_name_snapshot || (debt?.location_id ? 'Biriktirilgan ombor' : 'Omborga biriktirilmagan')}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Avvaldan mavjud qarz bir marta kiritiladi. Dastlabki yozuv saqlanadi; to‘lov boshlanmagan bo‘lsa, summa bir marta sabab bilan tuzatilishi mumkin. Bu amal tovar kirimi yoki pul harakati yaratmaydi. Boshlang‘ich qarz xaridlardan alohida hisobga olinadi.</p>
        {debt && <section aria-label="Boshlang‘ich qarz tarixi" className="space-y-3 rounded-xl border border-border p-4">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt>Boshlang‘ich summa</dt><dd className="text-right font-semibold">{formatUZS(debt.corrected_debt_amount ?? debt.debt_amount)}</dd>
            <dt>Qolgan qarz</dt><dd className="text-right font-semibold">{formatUZS(debt.remaining_debt)}</dd>
            <dt>Qarz sanasi</dt><dd className="text-right">{formatUzbekistanDate(`${debt.effective_date}T00:00:00+05:00`)}</dd>
          </dl>
          {debt.corrected_debt_amount != null && <div className="rounded-xl border border-border p-3 text-sm space-y-1" aria-label="Qarz tuzatish tarixi">
            <p>Dastlabki summa: {formatUZS(debt.debt_amount)}</p>
            <p>Tuzatilgan summa: {formatUZS(debt.corrected_debt_amount)}</p>
            <p>Sabab: {debt.amount_correction_reason}</p>
            <p className="text-xs text-muted-foreground">Tuzatildi: {formatUzbekistanDateTime(debt.amount_corrected_at)} · {debt.amount_corrected_by_name || '—'}</p>
            <p className="text-xs text-muted-foreground">Bu tuzatish to‘lov yoki pul harakati emas.</p>
          </div>}
          <p className="text-xs text-muted-foreground">Kiritildi: {formatUzbekistanDateTime(debt.created_at)}{debt.created_by_name ? ` · ${debt.created_by_name}` : ''}</p>
          <p className="text-sm">Ombor: {debt.location_name_snapshot || (debt.location_id ? 'Biriktirilgan ombor' : 'Biriktirilmagan')}</p>
          {debt.location_assigned_at && <p className="text-xs text-muted-foreground">Biriktirildi: {formatUzbekistanDateTime(debt.location_assigned_at)} · {debt.location_assigned_by_name || '—'}</p>}
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
        {debt && !pending && <OpeningDebtAmountCorrection key={`correction:${user.id}:${debt.id}`} debt={debt} payments={payments} user={user} allowed={allowed} onSaved={onSaved} />}
        {debt && !pending && <OpeningDebtLocationAssignment key={`${user.id}:${debt.id}`} debt={debt} recipient={recipient} locations={locations} user={user} allowed={allowed} onSaved={onSaved} />}
        {(!debt || pending) && <>
          <fieldset disabled={locked} className="space-y-4">
            <div><Label htmlFor="opening-debt-amount">Summa (UZS)</Label><Input data-money id="opening-debt-amount" inputMode="numeric" value={amount} disabled={locked} onChange={event => !locked && setAmount(event.target.value)} placeholder="Butun musbat summa" className="mt-1 min-h-11" /></div>
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


function OpeningDebtLocationAssignment({ debt, recipient, locations, user, allowed, onSaved }) {
  const scope = orderRequestScope(user?.id, 'assign_opening_debt_location', debt.id);
  const pendingRef = useRef(readOrderRequest(scope));
  const [pending, setPending] = useState(pendingRef.current);
  const [locationId, setLocationId] = useState(pending?.location_id || '');
  const [saving, setSaving] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState('');
  const available = locations.filter(location => location.active !== false && recipient.supplier_location_ids?.includes(location.id));
  const locked = saving || Boolean(pending);
  const assign = async () => {
    if (!allowed || user?.role !== 'admin' || flight.current || (!pendingRef.current && (debt.location_id || !available.some(location => location.id === locationId)))) return;
    flight.current = true; setSaving(true); setError('');
    try {
      const payload = retainOrderRequest(scope, pendingRef.current || {
        action: 'assign_opening_debt_location', opening_debt_id: debt.id,
        location_id: locationId, idempotency_key: buildIdempotencyKey('opening-location'),
      });
      if (payload.opening_debt_id !== debt.id || payload.action !== 'assign_opening_debt_location') throw new Error('Saqlangan so‘rov qarzga mos emas.');
      pendingRef.current = payload; setPending(payload);
      const response = await base44.functions.invoke('supplier-ledger', payload);
      const data = response?.data || response;
      if (data?.opening_debt?.id !== debt.id || data.opening_debt.location_id !== payload.location_id) {
        throw Object.assign(new Error(data?.error || 'Omborga biriktirish tasdiqlanmadi. Avvalgi so‘rovni qayta tekshiring.'), { data });
      }
      clearOrderRequest(scope); pendingRef.current = null; setPending(null);
      onSaved(data.opening_debt);
    } catch (failure) {
      if (orderRequestDefinitelyRejected(failure)) { clearOrderRequest(scope); pendingRef.current = null; setPending(null); }
      setError(failure?.response?.data?.error || failure?.data?.error || failure?.message || 'Biriktirish natijasi noma’lum.');
    } finally { flight.current = false; setSaving(false); }
  };
  if (debt.location_id && !pending) return null;
  return <section aria-label="Qarzni omborga biriktirish" className="space-y-3 rounded-xl border border-border p-4">
    <p className="text-sm">Qarzni omborga bir marta biriktiring. Summa, sana va to‘lovlar o‘zgarmaydi. Keyin boshqa omborga ko‘chirib bo‘lmaydi.</p>
    <Label htmlFor="opening-debt-location">Ombor yoki do‘kon</Label>
    <OdinaSelect id="opening-debt-location" value={locationId} disabled={locked} onChange={event => !locked && setLocationId(event.target.value)} className="min-h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
      <option value="">Omborni tanlang</option>
      {pending && !available.some(location => location.id === pending.location_id) && <option value={pending.location_id}>Avval tanlangan ombor</option>}
      {available.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
    </OdinaSelect>
    {!available.length && !pending && <p className="text-sm text-muted-foreground">Bu qabul qiluvchiga biriktirilgan faol ombor yo‘q. Avval qabul qiluvchining omborlarini tekshiring.</p>}
    {pending && <p role="status" className="text-sm">Avvalgi biriktirish so‘rovi saqlandi. Faqat aynan shu ombor bilan qayta tekshiriladi.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button className="min-h-11" disabled={saving || (!pending && !available.some(location => location.id === locationId))} onClick={assign}>{saving ? 'Biriktirilmoqda…' : pending ? 'Biriktirishni qayta tekshirish' : 'Omborga biriktirish'}</Button>
  </section>;
}


function OpeningDebtAmountCorrection({ debt, payments, user, allowed, onSaved }) {
  const scope = orderRequestScope(user?.id, 'correct_opening_debt_amount', debt.id);
  const pendingRef = useRef(readOrderRequest(scope));
  const [pending, setPending] = useState(pendingRef.current);
  const [amount, setAmount] = useState(pending?.amount ?? '');
  const [reason, setReason] = useState(pending?.reason || '');
  const [saving, setSaving] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState('');
  // Journal eligibility is determined by the backend, not inferred from zero payments.
  const eligible = debt.can_correct_amount === true && debt.corrected_debt_amount == null
    && !debt.amount_correction_key && debt.status === 'unpaid' && payments.length === 0
    && Number(debt.remaining_debt) === Number(debt.debt_amount);
  const value = Number(amount);
  const valid = /^\d+$/.test(String(amount)) && Number.isSafeInteger(value) && value > 0
    && value !== Number(debt.debt_amount) && reason.trim().length >= 3 && reason.trim().length <= 2000;
  const locked = saving || Boolean(pending);
  const correct = async () => {
    if (!allowed || user?.role !== 'admin' || flight.current || (!pendingRef.current && (!eligible || !valid))) return;
    flight.current = true; setSaving(true); setError('');
    try {
      const payload = retainOrderRequest(scope, pendingRef.current || {
        action: 'correct_opening_debt_amount', opening_debt_id: debt.id, amount: value,
        reason: reason.trim(), idempotency_key: buildIdempotencyKey('opening-correction'),
      });
      if (payload.opening_debt_id !== debt.id || payload.action !== 'correct_opening_debt_amount') throw new Error('Saqlangan so‘rov qarzga mos emas.');
      pendingRef.current = payload; setPending(payload);
      const result = await base44.functions.invoke('supplier-ledger', payload);
      const data = result?.data || result;
      if (data?.opening_debt?.id !== debt.id || data.opening_debt.corrected_debt_amount !== payload.amount
        || data.opening_debt.amount_correction_reason !== payload.reason || data.opening_debt.amount_correction_key !== payload.idempotency_key) {
        throw Object.assign(new Error(data?.error || 'Tuzatish tasdiqlanmadi. Avvalgi so‘rovni qayta tekshiring.'), { data });
      }
      clearOrderRequest(scope); pendingRef.current = null; setPending(null);
      onSaved(data.opening_debt);
    } catch (failure) {
      if (orderRequestDefinitelyRejected(failure)) { clearOrderRequest(scope); pendingRef.current = null; setPending(null); }
      setError(failure?.response?.data?.error || failure?.data?.error || failure?.message || 'Tuzatish natijasi noma’lum.');
    } finally { flight.current = false; setSaving(false); }
  };
  if (!eligible && !pending) return null;
  return <section aria-label="Boshlang‘ich qarz summasini tuzatish" className="space-y-3 rounded-xl border border-border p-4">
    <h3 className="font-semibold">Boshlang‘ich summani tuzatish</h3>
    <p className="text-sm">Faqat to‘lov boshlanishidan oldin bir marta tuzatiladi. Dastlabki summa tarixda qoladi. Tovar kirimi yoki pul harakati yaratilmaydi.</p>
    <Label htmlFor="opening-correction-amount">To‘g‘ri summa (UZS)</Label>
    <Input data-money id="opening-correction-amount" inputMode="numeric" value={amount} disabled={locked} onChange={event => !locked && setAmount(event.target.value)} className="min-h-11" />
    <Label htmlFor="opening-correction-reason">Tuzatish sababi</Label>
    <Textarea id="opening-correction-reason" maxLength={2000} value={reason} disabled={locked} onChange={event => !locked && setReason(event.target.value)} />
    {pending && <p role="status" className="text-sm">Avvalgi tuzatish so‘rovi saqlandi. Summa va sabab o‘zgarmasdan qayta tekshiriladi.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button className="min-h-11" onClick={correct} disabled={saving || (!pending && !valid)}>{saving ? 'Tuzatilmoqda…' : pending ? 'Tuzatishni qayta tekshirish' : 'Sabab bilan summani tuzatish'}</Button>
  </section>;
}
