import '@/styles/operations-workbench.css';
import React, { useEffect, useMemo, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { Navigate, useOutletContext } from 'react-router-dom';
import { Building2, Pencil, Plus, Search } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { odinaAlert } from '@/lib/odina-dialog';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import OpeningDebtDialog from '@/components/OpeningDebtDialog';
import { formatUZS } from '@/lib/pos';
import SupplierProductsDialog from '@/components/warehouse/SupplierProductsDialog';

// Type only the new controls; existing shared button behavior is unchanged.
const OpeningDebtButton = /** @type {React.ComponentType<React.ComponentPropsWithRef<'button'> & import('class-variance-authority').VariantProps<typeof import('@/components/ui/button').buttonVariants> & { asChild?: boolean }>} */ (Button);

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
        <p>Boshlang‘ich qarzlar do‘konga bog‘lanmaydi. Avvaldan mavjud qarzni bir marta kiriting. Bu qarz xaridlardan alohida hisobga olinadi.</p>
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
                {openingDebts.filter(debt => debt.supplier_id === item.id).map(debt => <p key={debt.id} className="text-sm">Boshlang‘ich: {formatUZS(debt.debt_amount)} · Qoldiq: <strong>{formatUZS(debt.remaining_debt)}</strong></p>)}
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
        user={user} allowed={canViewOpeningDebts}
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
        onSaved={() => { setEditing(null); load(); }}
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

  useEffect(() => {
    if (!open) return;
    setLocationIds(recipient?.supplier_location_ids || (defaultLocationId ? [defaultLocationId] : []));
    setName(recipient?.name || '');
    setType(recipient?.recipient_type || 'supplier');
    setNotes(recipient?.notes || '');
    setActive(recipient?.active !== false);
  }, [open, recipient]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = { name: name.trim(), recipient_type: type, notes: notes.trim(), active, supplier_location_ids: locationIds };
      if (recipient?.id) await base44.entities.CashRecipient.update(recipient.id, payload);
      else await base44.entities.CashRecipient.create({ ...payload, created_by: user.id, created_by_name: user.full_name || user.email });
      onSaved();
    } catch (error) {
      void odinaAlert('Qabul qiluvchini saqlab bo‘lmadi: ' + (error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle className="font-display text-xl">{recipient?.id ? 'Qabul qiluvchini tahrirlash' : 'Yangi qabul qiluvchi'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div><Label className="text-xs mb-1.5 block">Nomi</Label><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Masalan: Makro Trade" className="h-11 rounded-xl" /></div>
          <div>
            <Label className="text-xs mb-1.5 block">Turi</Label>
            <OdinaSelect value={type} onChange={(event) => setType(event.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
              <option value="supplier">Yetkazib beruvchi</option>
              <option value="company">Kompaniya</option>
            </OdinaSelect>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium mb-1">Kirim uchun do‘kon va omborlar</legend>
            {locations.filter(location => location.active !== false).map(location => (
              <label key={location.id} className="flex items-center gap-2 min-h-10 text-sm">
                <input type="checkbox" checked={locationIds.includes(location.id)} onChange={(event) => {
                  const checked = event.target.checked;
                  setLocationIds(ids => checked ? [...ids, location.id] : ids.filter(id => id !== location.id));
                }} />
                {location.name}
              </label>
            ))}
          </fieldset>
          <div><Label className="text-xs mb-1.5 block">Izoh</Label><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Telefon yoki qo‘shimcha ma’lumot (ixtiyoriy)" rows={2} /></div>
          {recipient?.id && (
            <label className="flex items-center gap-3 rounded-xl bg-secondary/60 p-3 text-sm"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} className="w-4 h-4" /> Faol ro‘yxatda ko‘rsatish</label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving || !name.trim()} className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-strong">{saving ? 'Saqlanmoqda…' : 'Saqlash'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

