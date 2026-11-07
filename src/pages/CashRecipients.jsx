import '@/styles/operations-workbench.css';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { Navigate, useOutletContext } from 'react-router-dom';
import { Building2, Pencil, Plus, Search } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import OpeningDebtDialog from '@/components/OpeningDebtDialog';
import { OpeningDebtPaymentButton } from '@/components/OpeningDebtPaymentDialog';
import { orderRequestScope, readOrderRequest, retainOrderRequest, clearOrderRequest, orderRequestDefinitelyRejected } from '@/lib/order-request-retry';
import { buildIdempotencyKey } from '@/lib/orders';
import { uzbekistanDateKey } from '@/lib/uzbekistan-time';
import { formatUZS } from '@/lib/pos';
import SupplierProductsDialog from '@/components/warehouse/SupplierProductsDialog';

// Type only the new controls; existing shared button behavior is unchanged.
const OpeningDebtButton = /** @type {React.ComponentType<React.ComponentPropsWithRef<'button'> & import('class-variance-authority').VariantProps<typeof import('@/components/ui/button').buttonVariants> & { asChild?: boolean }>} */ (Button);

const StartingDebtInput = /** @type {React.ComponentType<React.ComponentPropsWithRef<'input'>>} */ (Input);
const StartingDebtSelect = /** @type {React.ComponentType<React.SelectHTMLAttributes<HTMLSelectElement> & { contentClassName?: string; placeholder?: string }>} */ (OdinaSelect);

export default function CashRecipients() {
  const { user, adminShopScope } = useOutletContext();
  const locations = adminShopScope?.shops || [];
  const selectedShopId = adminShopScope?.shopId || 'all';
  const selectedShop = locations.find((location) => location.id === selectedShopId);
  const defaultLocationId = adminShopScope?.isAdmin && selectedShopId !== 'all' ? selectedShopId : '';
  const canManage = user?.role === 'admin';
  const [recipients, setRecipients] = useState([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [productsSupplier, setProductsSupplier] = useState(null);
  const [loading, setLoading] = useState(true);
  const canViewOpeningDebts = canManage && selectedShopId === 'all';
  const [openingDebts, setOpeningDebts] = useState([]);
  const [openingPayments, setOpeningPayments] = useState([]);
  const [openingLoading, setOpeningLoading] = useState(true);
  const [openingError, setOpeningError] = useState('');
  const [openingRecipient, setOpeningRecipient] = useState(null);
  const [openingRefresh, setOpeningRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setOpeningDebts([]); setOpeningPayments([]); setOpeningRecipient(null);
    if (!canViewOpeningDebts) return () => { cancelled = true; };
    setOpeningLoading(true); setOpeningError('');
    (async () => {
      try {
        const result = await base44.functions.invoke('supplier-ledger', { action: 'list_opening_debts' });
        const data = result?.data || result;
        if (!Array.isArray(data?.opening_debts) || !Array.isArray(data?.payments)) throw new Error(data?.error || 'Qarz ma’lumotlari olinmadi.');
        if (!cancelled) { setOpeningDebts(data.opening_debts); setOpeningPayments(data.payments); }
      } catch (error) {
        if (!cancelled) setOpeningError(error?.message || 'Qarzlarni yuklab bo‘lmadi.');
      } finally { if (!cancelled) setOpeningLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [canViewOpeningDebts, user?.id, openingRefresh]);

  const load = async () => {
    setLoading(true);
    try {
      setRecipients(await base44.entities.CashRecipient.list('name', 500) || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const scopedRecipients = useMemo(() => {
    if (!adminShopScope?.isAdmin || selectedShopId === 'all') return recipients;
    return recipients.filter((item) => item.supplier_location_ids?.includes(selectedShopId));
  }, [recipients, adminShopScope?.isAdmin, selectedShopId]);

  const filtered = useMemo(() => {
    const query = search.toLowerCase().trim();
    if (!query) return scopedRecipients;
    return scopedRecipients.filter((item) => [item.name, item.notes].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [scopedRecipients, search]);

  if (!['admin', 'manager'].includes(user?.role)) return <Navigate to="/" replace />;

  return (
    <div className="odina-page odina-workbench odina-operations odina-cashrecipients p-5 sm:p-8 max-w-5xl mx-auto animate-fade-in">
      <PageHeader
        title="Qabul qiluvchilar"
        eyebrow="HAMKORLAR"
        subtitle={adminShopScope?.isAdmin && selectedShopId !== 'all'
          ? `${selectedShop?.name || 'Tanlangan do‘kon'}ga biriktirilgan qabul qiluvchilar`
          : 'Tovarlarga pul beriladigan kompaniya va yetkazib beruvchilar'}
        icon={Building2}
        actions={canManage && (
          <Button onClick={() => setEditing({})} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong">
            <Plus className="w-4 h-4 mr-1.5" /> Yangi qabul qiluvchi
          </Button>
        )}
      />

      <div className="odina-operations-toolbar odina-panel rounded-2xl bg-card border border-border p-4 sm:p-5 mb-5">
        <div className="odina-toolbar-heading"><h2>Hamkorlar ro‘yxati</h2><p>{filtered.length} ta qabul qiluvchi · nomi yoki izohi bo‘yicha qidiring.</p></div>
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input aria-label="Qabul qiluvchini qidirish" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Kompaniya yoki yetkazib beruvchini qidirish…" className="h-11 pl-10 rounded-xl" />
        </div>
      </div>

      {canViewOpeningDebts && <div className="rounded-xl border border-border bg-card p-4 mb-5 text-sm">
        <p>Boshlang‘ich qarzni tegishli omborga bir marta biriktirish mumkin. Avvaldan mavjud qarzni bir marta kiriting. Bu qarz xaridlardan alohida hisobga olinadi.</p>
        {openingLoading && <p className="mt-2 text-muted-foreground" role="status">Qarzlar yuklanmoqda…</p>}
        {openingError && <div className="mt-2"><p role="alert" className="text-destructive">{openingError}</p><OpeningDebtButton variant="outline" className="mt-2 min-h-11" onClick={() => setOpeningRefresh(value => value + 1)}>Qarzlarni qayta yuklash</OpeningDebtButton></div>}
      </div>}

      {loading ? (
        <div className="grid sm:grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-28 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="odina-panel rounded-2xl border border-border bg-card py-16 text-center">
          <Building2 className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="font-medium">Qabul qiluvchi topilmadi</p>
          <p className="text-sm text-muted-foreground mt-1">{search.trim()
            ? 'Qidiruv bo‘yicha qabul qiluvchi topilmadi.'
            : adminShopScope?.isAdmin && selectedShopId !== 'all'
            ? 'Bu do‘konga biriktirilgan qabul qiluvchi yo‘q. “Barcha do‘konlar”ni tanlang yoki qabul qiluvchini tahrirlab shu do‘konga biriktiring.'
            : '“Yangi qabul qiluvchi” orqali birinchi kompaniyani kiriting.'}</p>
        </div>
      ) : (
        <div className="odina-partner-grid grid sm:grid-cols-2 gap-3">
          {filtered.map((item) => (
            <article key={item.id} className={`odina-partner-card odina-panel rounded-2xl border border-border bg-card p-4 ${item.active === false ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center shrink-0"><Building2 className="w-4.5 h-4.5" /></div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.recipient_type === 'company' ? 'Kompaniya' : 'Yetkazib beruvchi'} · {item.active === false ? 'Faol emas' : 'Faol'}</p>
                  <p className="text-xs text-muted-foreground mt-1">{locations.filter(location => item.supplier_location_ids?.includes(location.id)).map(location => location.name).join(', ') || 'Kirim uchun joy biriktirilmagan'}</p>
                  {item.notes && <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{item.notes}</p>}
                </div>
                {canManage && (
                  <Button aria-label={`${item.name} — tahrirlash`} variant="outline" size="icon" onClick={() => setEditing(item)} className="h-10 w-10 rounded-xl shrink-0"><Pencil className="w-4 h-4" /></Button>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">{new Set(Array.isArray(item.supplied_ingredient_ids) ? item.supplied_ingredient_ids.filter(id => typeof id === 'string' && id) : []).size} ta mahsulot biriktirilgan</p>
                {canManage && <Button type="button" variant="outline" className="min-h-11 rounded-xl" aria-label={`${item.name} — mahsulotlar`} onClick={() => setProductsSupplier(item)}>Mahsulotlar</Button>}
              </div>
              {canViewOpeningDebts && !openingLoading && !openingError && <div className="mt-3 border-t border-border pt-3 space-y-2">
                {openingDebts.filter(debt => debt.supplier_id === item.id).map(debt => <div key={debt.id} className="space-y-2">
                  <p className="text-sm">Boshlang‘ich: {formatUZS(debt.corrected_debt_amount ?? debt.debt_amount)} · Qoldiq: <strong>{formatUZS(debt.remaining_debt)}</strong><span className="block text-xs text-muted-foreground mt-1">Ombor: {debt.location_name_snapshot || (debt.location_id ? 'Biriktirilgan' : 'Biriktirilmagan')}</span></p>
                  <OpeningDebtPaymentButton key={`${user.id}:${selectedShopId}:${debt.id}`} debt={{ ...debt, supplier_name_snapshot: debt.supplier_name_snapshot || item.name }} user={user} allowed={canViewOpeningDebts} onSaved={() => setOpeningRefresh(value => value + 1)} />
                </div>)}
                <OpeningDebtButton variant="outline" className="min-h-11 rounded-xl" onClick={() => setOpeningRecipient(item)} aria-label={`${item.name} — boshlang‘ich qarz`}>{openingDebts.some(debt => debt.supplier_id === item.id) ? 'Qarz tarixi' : 'Boshlang‘ich qarz kiritish'}</OpeningDebtButton>
              </div>}
            </article>
          ))}
        </div>
      )}

      {canViewOpeningDebts && openingRecipient && <OpeningDebtDialog
        key={`${user.id}:${openingRecipient.id}`}
        recipient={openingRecipient}
        debt={openingDebts.find(debt => debt.supplier_id === openingRecipient.id)}
        payments={openingPayments.filter(payment => openingDebts.some(debt => debt.supplier_id === openingRecipient.id && debt.id === payment.opening_debt_id))}
        user={user} locations={locations} allowed={canViewOpeningDebts}
        onClose={() => setOpeningRecipient(null)}
        onSaved={() => { setOpeningRecipient(null); setOpeningRefresh(value => value + 1); }}
      />}
      <RecipientDialog
        open={Boolean(editing)}
        recipient={editing}
        locations={locations}
        defaultLocationId={defaultLocationId}
        user={user}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); setOpeningRefresh(value => value + 1); }}
      />
      <SupplierProductsDialog supplier={productsSupplier} user={user} onClose={() => setProductsSupplier(null)} onSaved={updated => {
        setRecipients(previous => previous.map(item => item.id === updated.id ? { ...item, ...updated } : item));
        setProductsSupplier(null);
      }} />
    </div>
  );
}

function RecipientDialog({ open, recipient, locations, defaultLocationId, user, onClose, onSaved }) {
  const [locationIds, setLocationIds] = useState([]);
  const [name, setName] = useState('');
  const [type, setType] = useState('supplier');
  const [notes, setNotes] = useState('');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const isNew = !recipient?.id;
  const scope = orderRequestScope(user?.id, 'create_recipient');
  const pendingRef = useRef(null);
  const flight = useRef(false);
  const [pending, setPending] = useState(null);
  const [hasDebt, setHasDebt] = useState(false);
  const [debtAmount, setDebtAmount] = useState('');
  const [debtDate, setDebtDate] = useState('');
  const [debtLocation, setDebtLocation] = useState('');
  const [error, setError] = useState('');
  const eligibleLocations = locations.filter(location => location.active !== false && locationIds.includes(location.id));
  const locked = saving || (isNew && Boolean(pending));
  const amount = Number(debtAmount);
  const validDebt = !hasDebt || (/^\d+$/.test(String(debtAmount)) && Number.isSafeInteger(amount) && amount > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(debtDate) && uzbekistanDateKey(Date.parse(`${debtDate}T00:00:00+05:00`)) === debtDate
    && eligibleLocations.some(location => location.id === debtLocation));

  useEffect(() => {
    if (!open) return;
    const saved = recipient?.id ? null : readOrderRequest(scope);
    pendingRef.current = saved; setPending(saved); setError('');
    setLocationIds(saved?.recipient?.supplier_location_ids || recipient?.supplier_location_ids || (defaultLocationId ? [defaultLocationId] : []));
    setName(saved?.recipient?.name || recipient?.name || '');
    setType(saved?.recipient?.recipient_type || recipient?.recipient_type || 'supplier');
    setNotes(saved?.recipient?.notes || recipient?.notes || '');
    setActive(recipient?.active !== false);
    setHasDebt(Boolean(saved?.opening_debt));
    setDebtAmount(saved?.opening_debt?.amount ?? '');
    setDebtDate(saved?.opening_debt?.effective_date || uzbekistanDateKey());
    setDebtLocation(saved?.opening_debt?.location_id || '');
  }, [open, recipient, scope]);

  const save = async () => {
    if (user?.role !== 'admin' || flight.current || (!pendingRef.current && (!name.trim() || (isNew && !validDebt)))) return;
    flight.current = true; setSaving(true); setError('');
    try {
      const fields = { name: name.trim(), recipient_type: type, notes: notes.trim(), active, supplier_location_ids: locationIds };
      if (!isNew) {
        await base44.entities.CashRecipient.update(recipient.id, fields);
      } else {
        const payload = retainOrderRequest(scope, pendingRef.current || {
          action: 'create_recipient', recipient: fields,
          ...(hasDebt ? { opening_debt: { amount, effective_date: debtDate, location_id: debtLocation } } : {}),
          idempotency_key: buildIdempotencyKey('recipient'),
        });
        if (payload.action !== 'create_recipient') throw new Error('Saqlangan so‘rov turi mos emas.');
        pendingRef.current = payload; setPending(payload);
        const result = await base44.functions.invoke('supplier-ledger', payload);
        const data = result?.data || result;
        if (!data?.recipient?.id || (!payload.opening_debt && data.opening_debt != null) || (payload.opening_debt && (!data?.opening_debt?.id
          || data.opening_debt.supplier_id !== data.recipient.id || data.opening_debt.debt_amount !== payload.opening_debt.amount
          || data.opening_debt.effective_date !== payload.opening_debt.effective_date || data.opening_debt.location_id !== payload.opening_debt.location_id))) {
          throw Object.assign(new Error(data?.error || 'Qabul qiluvchi va qarz to‘liq tasdiqlanmadi. Avvalgi so‘rovni qayta tekshiring.'), { data });
        }
        clearOrderRequest(scope); pendingRef.current = null; setPending(null);
      }
      onSaved();
    } catch (failure) {
      if (isNew && orderRequestDefinitelyRejected(failure)) { clearOrderRequest(scope); pendingRef.current = null; setPending(null); }
      setError(failure?.response?.data?.error || failure?.data?.error || failure?.message || 'Qabul qiluvchini saqlab bo‘lmadi.');
    } finally { flight.current = false; setSaving(false); }
  };

  if (user?.role !== 'admin') return null;
  return (
    <Dialog open={open} onOpenChange={(value) => !value && !flight.current && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle className="font-display text-xl">{recipient?.id ? 'Qabul qiluvchini tahrirlash' : 'Yangi qabul qiluvchi'}</DialogTitle></DialogHeader>
        <fieldset disabled={locked} className="space-y-4">
          <div><Label className="text-xs mb-1.5 block">Nomi</Label><Input autoFocus value={name} onChange={(event) => !locked && setName(event.target.value)} placeholder="Masalan: Makro Trade" className="h-11 rounded-xl" /></div>
          <div>
            <Label className="text-xs mb-1.5 block">Turi</Label>
            <OdinaSelect value={type} onChange={(event) => !locked && setType(event.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
              <option value="supplier">Yetkazib beruvchi</option>
              <option value="company">Kompaniya</option>
            </OdinaSelect>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium mb-1">Kirim uchun do‘kon va omborlar</legend>
            {locations.filter(location => location.active !== false).map(location => (
              <label key={location.id} className="flex items-center gap-2 min-h-10 text-sm">
                <input type="checkbox" checked={locationIds.includes(location.id)} onChange={(event) => {
                  if (locked) return;
                  const checked = event.target.checked;
                  setLocationIds(ids => checked ? [...ids, location.id] : ids.filter(id => id !== location.id));
                }} />
                {location.name}
              </label>
            ))}
          </fieldset>
          <div><Label className="text-xs mb-1.5 block">Izoh</Label><Textarea value={notes} onChange={(event) => !locked && setNotes(event.target.value)} placeholder="Telefon yoki qo‘shimcha ma’lumot (ixtiyoriy)" rows={2} /></div>
          {recipient?.id && (
            <label className="flex items-center gap-3 rounded-xl bg-secondary/60 p-3 text-sm"><input type="checkbox" checked={active} onChange={(event) => !locked && setActive(event.target.checked)} className="w-4 h-4" /> Faol ro‘yxatda ko‘rsatish</label>
          )}
          {isNew && <section className="space-y-3 rounded-xl border border-border p-3" aria-label="Yangi qabul qiluvchining boshlang‘ich qarzi">
            <label className="flex items-center gap-3 min-h-11 text-sm"><input type="checkbox" aria-label="Boshlang‘ich qarz kiritish" checked={hasDebt} disabled={locked} onChange={event => !locked && setHasDebt(event.target.checked)} />Biz bu yetkazib beruvchiga qarzdormiz</label>
            <p className="text-xs text-muted-foreground">Ixtiyoriy: hozir biz to‘lashimiz kerak bo‘lgan summa. Bu tovar kirimi ham, to‘lov ham emas.</p>
            {hasDebt && <>
              <label className="block text-sm" htmlFor="new-recipient-debt-amount">Biz to‘lashimiz kerak bo‘lgan summa (UZS)</label>
              <StartingDebtInput id="new-recipient-debt-amount" inputMode="numeric" value={debtAmount} disabled={locked} onChange={event => !locked && setDebtAmount(event.target.value)} className="min-h-11" />
              {debtAmount !== '' && (!Number.isSafeInteger(amount) || amount <= 0 || !/^\d+$/.test(String(debtAmount))) && <p role="alert" className="text-sm text-destructive">Musbat butun summa kiriting. Qarz bo‘lmasa, “Biz bu yetkazib beruvchiga qarzdormiz” belgisini olib tashlang.</p>}
              <label className="block text-sm" htmlFor="new-recipient-debt-date">Qarz sanasi (Toshkent vaqti)</label>
              <StartingDebtInput id="new-recipient-debt-date" type="date" value={debtDate} disabled={locked} onChange={event => !locked && setDebtDate(event.target.value)} className="min-h-11" />
              <label className="block text-sm" htmlFor="new-recipient-debt-location">Qarz tegishli bo‘lgan ombor yoki do‘kon</label>
              <StartingDebtSelect id="new-recipient-debt-location" value={debtLocation} disabled={locked} onChange={event => !locked && setDebtLocation(event.target.value)} className="min-h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                <option value="">Omborni tanlang</option>
                {pending && !eligibleLocations.some(location => location.id === debtLocation) && <option value={debtLocation}>Avval tanlangan ombor</option>}
                {eligibleLocations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
              </StartingDebtSelect>
              {!eligibleLocations.length && !pending && <p className="text-sm text-muted-foreground">Yuqorida kamida bitta faol ombor yoki do‘konni belgilang.</p>}
            </>}
          </section>}
        </fieldset>
        {pending && isNew && <p role="status" className="text-sm">Avvalgi so‘rov saqlandi. Takroriy qabul qiluvchi yaratmaslik uchun aynan shu ma’lumotlar bilan qayta tekshiriladi.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{pending && isNew ? 'Yopish' : 'Bekor qilish'}</Button>
          <Button onClick={save} disabled={saving || (isNew && !pending && (!name.trim() || !validDebt)) || (!isNew && !name.trim())} className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-strong">{saving ? 'Saqlanmoqda…' : pending && isNew ? 'Avvalgi so‘rovni tekshirish' : 'Saqlash'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

