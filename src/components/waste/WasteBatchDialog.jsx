import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, CheckCircle2, Loader2, PackageX, Search, Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatNum } from '@/lib/pos';
import { odinaAlert } from '@/lib/odina-dialog';
import { makeWasteRow, submitWasteRows, validateWasteRows, wasteRequest, wasteError, WASTE_REASONS } from '@/lib/waste';
import OdinaSelect from '@/components/ui/odina-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function WasteBatchDialog({ open, initial, shops, stockItems, onClose, onSaved, onUpdated }) {
  const [rows, setRows] = useState({});
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [savedCount, setSavedCount] = useState(0);
  const busy = useRef(false);
  const locationId = initial?.location_id || '';
  const locationName = shops.find((shop) => shop.id === locationId)?.name || '';

  const items = useMemo(() => stockItems
    .filter((item) => item.location_id === locationId)
    .sort((a, b) => String(a.product_name).localeCompare(String(b.product_name))),
  [stockItems, locationId]);

  useEffect(() => {
    if (!open) return;
    const selected = {};
    for (const preset of initial?.items || []) {
      const item = stockItems.find((entry) => entry.location_id === initial?.location_id && entry.product_id === preset.product_id);
      if (item) selected[item.product_id] = makeWasteRow(item, preset);
    }
    setRows(selected);
    setSearch('');
    setNotes('');
    setPhotoUrl('');
    setSavedCount(0);
    setReview(false);
    setProgress({ done: 0, total: 0 });
  }, [open, initial]);

  const selected = Object.values(rows);
  // Keep uncertain rows visible even if a refresh no longer returns their stock.
  const displayItems = [...items, ...selected
    .filter((row) => !items.some((item) => item.product_id === row.product_id))
    .map((row) => ({ product_id: row.product_id, product_name: row.product_name, quantity: 0 }))];
  const visibleItems = displayItems.filter((item) => String(item.product_name).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const totalQuantity = selected.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);

  const toggle = (item, checked) => {
    if (busy.current) return;
    setRows((current) => {
      if (checked) {
        if (current[item.product_id]) return current;
        if (Object.keys(current).length >= 50) {
          void odinaAlert('Bir martada 50 tagacha mahsulot turini tanlang.');
          return current;
        }
        return { ...current, [item.product_id]: makeWasteRow(item) };
      }
      const next = { ...current };
      delete next[item.product_id];
      return next;
    });
  };

  const selectVisible = () => {
    if (busy.current) return;
    const next = { ...rows };
    for (const item of visibleItems) {
      if (!next[item.product_id]) next[item.product_id] = makeWasteRow(item);
    }
    if (Object.keys(next).length > 50) {
      void odinaAlert('Bir martada 50 tagacha mahsulot turini tanlang. Qidiruv bilan ro‘yxatni qisqartiring.');
      return;
    }
    setRows(next);
  };

  const patchRow = (id, patch) => {
    if (busy.current) return;
    setRows((current) => {
      if (!current[id] || current[id].attempt) return current;
      return { ...current, [id]: { ...current[id], ...patch, error: '' } };
    });
  };

  const uploadPhoto = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file });
      setPhotoUrl(result.file_url || '');
    } catch (error) {
      void odinaAlert(wasteError(error));
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const startReview = () => {
    const error = validateWasteRows(selected);
    if (error) { void odinaAlert(error); return; }
    setReview(true);
  };

  const save = async () => {
    if (busy.current || uploading) return;
    const error = validateWasteRows(selected);
    if (error) { void odinaAlert(error); return; }
    busy.current = true;
    setSaving(true);
    const prepared = selected.map((row) => ({ ...row, attempt: wasteRequest(row, locationId, notes, photoUrl) }));
    setRows(Object.fromEntries(prepared.map((row) => [row.product_id, row])));
    setProgress({ done: 0, total: prepared.length });
    try {
      const results = await submitWasteRows(prepared,
        (body) => base44.functions.invoke('waste-ledger', body),
        (result, done) => {
          setProgress({ done, total: prepared.length });
          setRows((current) => {
            const next = { ...current };
            if (result.ok) delete next[result.product_id];
            else if (next[result.product_id]) next[result.product_id] = { ...next[result.product_id], error: result.error };
            return next;
          });
          if (result.ok) setSavedCount((count) => count + 1);
        });
      if (results.every((result) => result.ok)) {
        await onSaved();
      } else {
        setReview(false);
        await onUpdated();
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && !uploading && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">
            {review ? 'Hisobdan chiqarishni tasdiqlash' : 'Chiqit kiritish'}
          </DialogTitle>
          <DialogDescription>
            {locationName} · {review
              ? 'Tanlangan miqdorlar do‘kon qoldig‘idan kamayadi. Har bir yozuv tarixda saqlanadi.'
              : 'Mahsulotlarni belgilang, har biriga miqdor va sabab kiriting.'}
          </DialogDescription>
        </DialogHeader>

        {savedCount > 0 && (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            <p>{savedCount} ta mahsulot saqlandi. Qolgan yozuvlarni tekshiring. Saqlanganlar qayta chiqarilmaydi.</p>
          </div>
        )}

        {selected.some((row) => row.error) && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            Ayrim yozuvlar saqlangani tasdiqlanmadi. Qayta urinish avvalgi so‘rovni tekshiradi.
            Qoldiq o‘zgargan bo‘lsa, tarixni tekshirib, mahsulot belgisini olib qayta tanlang.
          </div>
        )}

        {review ? (
          <div className="space-y-2">
            {selected.map((row) => (
              <div key={row.product_id} className="rounded-xl border border-border bg-secondary/30 p-4">
                <div className="flex justify-between gap-3">
                  <span className="font-semibold">{row.product_name}</span>
                  <span className="font-bold shrink-0">{formatNum(row.quantity)} dona</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{WASTE_REASONS.find((reason) => reason.value === row.reason_code)?.label}</p>
                {row.error && <p role="alert" className="mt-2 text-sm text-red-700">{row.error}</p>}
              </div>
            ))}
            {notes && <p className="text-sm text-muted-foreground break-words">Izoh: {notes}</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-3.5 w-4 h-4 text-muted-foreground" />
              <Input aria-label="Mahsulot qidirish" placeholder="Mahsulot nomidan qidirish…" value={search}
                onChange={(event) => setSearch(event.target.value)} disabled={saving} className="h-11 pl-9" />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{selected.length} ta mahsulot tanlandi</span>
              <Button variant="outline" size="sm" className="min-h-11 rounded-xl"
                disabled={saving || !visibleItems.length} onClick={selectVisible}>Ro‘yxatdagilarni tanlash</Button>
            </div>

            <div className="max-h-[42dvh] overflow-y-auto overscroll-contain space-y-2 pr-1">
              {visibleItems.length === 0 && (
                <div className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">
                  <PackageX className="w-7 h-7 mx-auto mb-2" /> Mahsulot topilmadi.
                </div>
              )}
              {visibleItems.map((item) => {
                const row = rows[item.product_id];
                const locked = saving || Boolean(row?.attempt);
                return (
                  <div key={item.product_id} className={`rounded-xl border p-3 sm:p-4 ${row ? 'border-brand-olive/60 bg-brand-olive/5' : 'border-border bg-card'}`}>
                    <label className="flex min-h-11 items-center gap-3 cursor-pointer">
                      <Checkbox aria-label={item.product_name + 'ni tanlash'} checked={Boolean(row)}
                        onCheckedChange={(checked) => toggle(item, checked === true)} disabled={saving} className="h-5 w-5 shrink-0" />
                      {item.image_url && <img src={item.image_url} alt="" className="w-11 h-11 rounded-lg object-contain bg-secondary shrink-0" />}
                      <span className="min-w-0">
                        <span className="block font-semibold break-words">{item.product_name}</span>
                        <span className="block text-xs text-muted-foreground mt-0.5">
                          Qoldiq: {formatNum(item.quantity)} dona
                          {item.expired_quantity > 0 ? ` · 3 kundan oshgan: ${formatNum(item.expired_quantity)}` : ''}
                          {item.near_expiry_quantity > 0 ? ` · 24 soat ichida: ${formatNum(item.near_expiry_quantity)}` : ''}
                        </span>
                      </span>
                    </label>
                    {row && (
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-[130px_1fr] gap-3">
                        <div>
                          <Label htmlFor={'waste-qty-' + item.product_id} className="mb-1 block text-xs">Miqdor (dona)</Label>
                          <Input id={'waste-qty-' + item.product_id} aria-label={item.product_name + ' miqdori'} type="number" inputMode="numeric"
                            min="1" max={row.reason_code === 'expired' ? row.expired_quantity : row.expected_quantity}
                            step="1" value={row.quantity} disabled={locked} className="h-11"
                            onChange={(event) => patchRow(item.product_id, { quantity: event.target.value })} />
                        </div>
                        <div>
                          <Label htmlFor={'waste-reason-' + item.product_id} className="mb-1 block text-xs">Sabab</Label>
                          <OdinaSelect id={'waste-reason-' + item.product_id} aria-label={item.product_name + ' chiqit sababi'}
                            value={row.reason_code} disabled={locked}
                            onChange={(event) => patchRow(item.product_id, { reason_code: event.target.value })}>
                            {WASTE_REASONS.map((reason) => <option key={reason.value} value={reason.value}
                              disabled={reason.value === 'expired' && !row.expired_quantity}>{reason.label}</option>)}
                          </OdinaSelect>
                        </div>
                        {row.error && <p role="alert" className="sm:col-span-2 text-sm text-red-700">{row.error}</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div>
              <Label htmlFor="waste-notes" className="mb-1.5 block text-xs">Umumiy izoh (ixtiyoriy)</Label>
              <Textarea id="waste-notes" value={notes} disabled={saving} onChange={(event) => setNotes(event.target.value)}
                maxLength={2000} placeholder="Tanlangan mahsulotlar uchun izoh" className="min-h-20" />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm font-medium cursor-pointer hover:bg-secondary">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                {uploading ? 'Yuklanmoqda…' : 'Umumiy rasm (ixtiyoriy)'}
                <input type="file" accept="image/*" capture="environment" className="hidden"
                  onChange={uploadPhoto} disabled={saving || uploading} />
              </label>
              {photoUrl && (
                <div className="flex items-center gap-2">
                  <img src={photoUrl} alt="Chiqit rasmi" className="w-11 h-11 rounded-lg object-cover" />
                  <Button variant="ghost" disabled={saving} onClick={() => setPhotoUrl('')}>Rasmni olib tashlash</Button>
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="sticky bottom-0 -mx-1 border-t border-border bg-card px-1 pt-4">
          <div className="sm:mr-auto text-sm font-medium py-2" aria-live="polite">
            {saving ? `Saqlanmoqda: ${progress.done} / ${progress.total}` : `${selected.length} tur · ${formatNum(totalQuantity)} dona`}
          </div>
          <Button variant="outline" className="min-h-11" disabled={saving || uploading}
            onClick={() => review ? setReview(false) : onClose()}>{review ? 'Orqaga' : 'Yopish'}</Button>
          <Button disabled={saving || uploading || !selected.length} onClick={review ? save : startReview}
            className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong">
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
            {saving ? 'Saqlanmoqda…' : review ? 'Tasdiqlash va chiqarish' : 'Davom etish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
