import React, { useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { odinaConfirm } from '@/lib/odina-dialog';
import {
  isCakeSheetYieldProduct,
  savedCakeSheetYield,
  parseCakeSheetYield,
  saveCakeSheetYield,
} from '@/lib/cake-sheet-yield';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const changedDraft = (value, product) => {
  const saved = savedCakeSheetYield(product);
  const parsed = parseCakeSheetYield(value);
  return parsed === null ? String(value ?? '').trim() !== saved : String(parsed) !== saved;
};

export default function CakeSheetYieldDialog({ products = [], user, onClose, onProductUpdated }) {
  const [baselines, setBaselines] = useState(() => Object.fromEntries(
    products.filter(isCakeSheetYieldProduct).map((product) => [product.id, { ...product }]),
  ));
  const [drafts, setDrafts] = useState(() => Object.fromEntries(
    products.filter(isCakeSheetYieldProduct).map((product) => [product.id, savedCakeSheetYield(product)]),
  ));
  const [search, setSearch] = useState('');
  const [savingId, setSavingId] = useState('');
  const [notices, setNotices] = useState({});
  const busyRef = useRef(false);
  const closingRef = useRef(false);
  const canSave = ['admin', 'accountant'].includes(user?.role);
  const rows = useMemo(() => Object.values(baselines).sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'uz')), [baselines]);
  const visibleRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('uz');
    return rows.filter((product) => !query || String(product.name || '').toLocaleLowerCase('uz').includes(query));
  }, [rows, search]);
  const changedCount = rows.filter((product) => changedDraft(drafts[product.id], product)).length;

  const requestClose = async () => {
    if (busyRef.current || closingRef.current) return;
    closingRef.current = true;
    try {
      if (changedCount && !await odinaConfirm('Saqlanmagan bo‘lak sonlari bor. Ularni saqlamasdan yopasizmi?', {
        title: 'Saqlanmagan qiymatlar',
        tone: 'warning',
        confirmLabel: 'Saqlamasdan yopish',
        cancelLabel: 'Davom etish',
      })) return;
      onClose();
    } finally {
      closingRef.current = false;
    }
  };

  const saveRow = async (product) => {
    if (busyRef.current || !canSave || product.production_unit === 'sheet') return;
    busyRef.current = true;
    setSavingId(product.id);
    setNotices((current) => ({ ...current, [product.id]: null }));
    try {
      const updated = await saveCakeSheetYield({
        entity: base44.entities.Product,
        user,
        product,
        value: drafts[product.id],
      });
      setBaselines((current) => ({ ...current, [product.id]: updated }));
      setDrafts((current) => ({ ...current, [product.id]: savedCakeSheetYield(updated) }));
      setNotices((current) => ({ ...current, [product.id]: { type: 'success', text: 'Saqlandi.' } }));
      onProductUpdated?.(updated);
    } catch (error) {
      setNotices((current) => ({
        ...current,
        [product.id]: { type: 'error', text: error?.message || 'Bo‘lak soni saqlanmadi. Qayta urinib ko‘ring.' },
      }));
    } finally {
      busyRef.current = false;
      setSavingId('');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void requestClose(); }}>
      <DialogContent className="warehouse-dialog sm:max-w-4xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Tortlar: 1 listdan bo‘lak soni</DialogTitle>
          <DialogDescription>
            Har bir tort uchun 1 listdan nechta bo‘lak chiqishini kiriting va shu qatordagi tugma bilan saqlang.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-border bg-secondary/40 p-3 text-sm text-muted-foreground">
          Bu barcha do‘konlar uchun umumiy sozlama. Faqat bo‘lak soni saqlanadi. Ombor qoldig‘i o‘zgarmaydi. Dona hisobidagi mahsulotni listga o‘tkazish va shu qiymat bilan list transferi hali yoqilmagan.
        </div>
        {!canSave && <p className="text-sm text-muted-foreground">Bo‘lak sonini faqat admin yoki hisobchi saqlashi mumkin.</p>}

        <div className="space-y-2">
          <Label htmlFor="cake-sheet-yield-search">Tortni qidirish</Label>
          <div className="relative">
            <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input id="cake-sheet-yield-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tort nomi…" className="min-h-11 pl-10" />
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">Ko‘rsatilmoqda: {visibleRows.length} / {rows.length} ta tort</p>
        </div>

        {visibleRows.length ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {visibleRows.map((product) => {
              const saved = savedCakeSheetYield(product);
              const value = drafts[product.id] ?? '';
              const parsed = parseCakeSheetYield(value);
              const readOnly = product.production_unit === 'sheet';
              const dirty = changedDraft(value, product);
              const notice = notices[product.id];
              const inputId = `cake-sheet-yield-${product.id}`;
              return (
                <section key={product.id} className="min-w-0 rounded-xl border border-border bg-card p-4 space-y-3" aria-label={product.name}>
                  <div>
                    <h3 className="font-medium break-words">{product.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">Saqlangan qiymat: {saved ? `${saved} bo‘lak` : 'kiritilmagan'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={inputId} className="shrink-0 text-sm">1 list =</Label>
                    <Input
                      id={inputId}
                      type="number"
                      inputMode="numeric"
                      min="1"
                      step="1"
                      value={value}
                      disabled={Boolean(savingId) || readOnly || !canSave}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setDrafts((current) => ({ ...current, [product.id]: nextValue }));
                        setNotices((current) => ({ ...current, [product.id]: null }));
                      }}
                      aria-label={`${product.name}: 1 listdan bo‘lak soni`}
                      aria-describedby={`${inputId}-hint`}
                      aria-invalid={dirty && parsed === null}
                      className="min-h-11 min-w-0 flex-1"
                    />
                    <span className="shrink-0 text-sm">bo‘lak</span>
                  </div>
                  <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
                    {readOnly ? 'List hisobi mavjud — bo‘lak soni bu oynada faqat ko‘rsatiladi.' : 'Dona hisobi — listga o‘tish hali yoqilmagan.'}
                  </p>
                  {dirty && parsed === null && <p className="text-xs text-destructive">1 yoki undan katta butun son kiriting.</p>}
                  {!readOnly && <Button type="button" onClick={() => void saveRow(product)} disabled={Boolean(savingId) || !canSave || !dirty || parsed === null} className="min-h-11 w-full rounded-xl">
                    {savingId === product.id ? 'Saqlanmoqda…' : 'Bo‘lak sonini saqlash'}
                  </Button>}
                  {notice && <p role={notice.type === 'error' ? 'alert' : 'status'} className={`text-xs ${notice.type === 'error' ? 'text-destructive' : 'text-primary'}`}>{notice.text}</p>}
                </section>
              );
            })}
          </div>
        ) : <p className="rounded-xl border border-border p-6 text-center text-sm text-muted-foreground">{rows.length ? 'Qidiruvga mos tort topilmadi.' : 'Bo‘lak soni kiritiladigan faol tort topilmadi.'}</p>}

        <DialogFooter className="gap-2 sm:items-center">
          <p className="text-xs text-muted-foreground sm:mr-auto" aria-live="polite">{changedCount ? `Saqlanmagan: ${changedCount} ta` : 'Saqlanmagan qiymat yo‘q.'}</p>
          <Button type="button" variant="outline" disabled={Boolean(savingId)} onClick={() => void requestClose()} className="min-h-11 rounded-xl">Yopish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
