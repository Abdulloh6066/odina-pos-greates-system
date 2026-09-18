import React, { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Armchair, Building2, Check, ChevronDown, Minus, Plus, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { odinaConfirm } from '@/lib/odina-dialog';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';

const MAX_TABLES = 30;
const QUICK_COUNTS = [5, 6, 8, 10];

export default function RestaurantTables() {
  const { user } = useOutletContext();
  const [shops, setShops] = useState([]);
  const [selectedShopId, setSelectedShopId] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [draftCount, setDraftCount] = useState('0');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', { action: 'status' });
      const result = response?.data || response;
      const available = result?.shops || [];
      setShops(available);
      setCanManage(result?.can_manage === true);
      setSelectedShopId((current) => available.some((shop) => shop.id === current)
        ? current : (available[0]?.id || ''));
    } catch (err) {
      setShops([]);
      setCanManage(false);
      setError(err?.response?.data?.error || err?.message || 'Stollarni yuklab bo‘lmadi.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const selectedShop = shops.find((shop) => shop.id === selectedShopId);
  useEffect(() => {
    setDraftCount(String(selectedShop?.table_count ?? 0));
    setNotice('');
  }, [selectedShopId, selectedShop?.table_count]);

  const count = Number(draftCount);
  const validCount = /^(0|[1-9]\d*)$/.test(draftCount) && Number.isInteger(count) && count <= MAX_TABLES;
  const hasChanges = Boolean(selectedShop) && validCount && count !== selectedShop.table_count;
  const adjustCount = (step) => setDraftCount((previous) =>
    String(Math.max(0, Math.min(MAX_TABLES, (Number(previous) || 0) + step))));

  const saveCount = async () => {
    if (!canManage || !selectedShop || !hasChanges || saving) return;
    if (count < selectedShop.table_count) {
      const confirmed = await odinaConfirm({
        title: 'Stollar sonini kamaytirish',
        description: `${selectedShop.name}: ${selectedShop.table_count} tadan ${count} taga kamaytirasiz. Yuqori raqamli stollar ro‘yxatdan yo‘qoladi. Tasdiqlaysizmi?`,
        confirmLabel: 'Kamaytirish',
        tone: 'warning',
      });
      if (!confirmed) return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'set_table_count',
        shop_id: selectedShop.id,
        table_count: count,
      });
      const result = response?.data || response;
      if (!result?.ok || result?.shop?.id !== selectedShop.id) throw new Error('Saqlash tasdiqlanmadi.');
      setShops((previous) => previous.map((shop) => shop.id === result.shop.id ? result.shop : shop));
      setNotice(`${result.shop.name}: ${result.shop.table_count} ta stol saqlandi.`);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Stollar sonini saqlab bo‘lmadi.');
    } finally {
      setSaving(false);
    }
  };

  const tableCount = selectedShop?.table_count || 0;
  const totalCount = shops.reduce((sum, shop) => sum + shop.table_count, 0);

  return (
    <div className="odina-page p-5 sm:p-8 max-w-7xl mx-auto">
      <PageHeader
        title="Stollar"
        subtitle="Har bir do‘kon stollari alohida. Buyurtma va band qilish keyingi bosqichda ulanadi."
        icon={Armchair}
        eyebrow="ODINA · RESTORAN"
        actions={<Button variant="outline" onClick={load} disabled={loading || saving} className="min-h-11 rounded-xl"><RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Yangilash</Button>}
      />

      {error && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 text-destructive px-4 py-3 text-sm mb-4">{error}</div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 px-4 py-3 text-sm mb-4 flex gap-2 items-center"><Check className="w-4 h-4" />{notice}</div>}

      {loading ? (
        <div className="space-y-4 animate-pulse"><div className="h-24 rounded-2xl bg-secondary" /><div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-40 rounded-2xl bg-secondary" />)}</div></div>
      ) : shops.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card premium-shadow p-10 text-center space-y-2">
          <Building2 className="w-9 h-9 mx-auto text-brand-olive" />
          <h2 className="font-semibold text-lg">Stollar uchun faol do‘kon topilmadi</h2>
          <p className="text-sm text-muted-foreground">Do‘kon biriktirilganini tekshiring yoki yangilash tugmasini bosing.</p>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="odina-panel bg-card border border-border rounded-2xl p-5 premium-shadow flex items-center gap-4">
              <span className="w-12 h-12 rounded-2xl bg-brand-olive/15 text-brand-ink flex items-center justify-center"><Building2 className="w-6 h-6" /></span>
              <div><div className="text-xs text-muted-foreground">{canManage ? 'Faol do‘konlar' : 'Biriktirilgan do‘kon'}</div><div className="text-2xl font-semibold">{shops.length}</div></div>
            </div>
            <div className="odina-panel bg-card border border-border rounded-2xl p-5 premium-shadow flex items-center gap-4">
              <span className="w-12 h-12 rounded-2xl bg-primary/20 text-brand-ink flex items-center justify-center"><Armchair className="w-6 h-6" /></span>
              <div><div className="text-xs text-muted-foreground">{canManage ? 'Jami sozlangan stollar' : 'Do‘kon stollari'}</div><div className="text-2xl font-semibold">{totalCount}</div></div>
            </div>
          </div>

          {canManage && shops.length > 1 && (
            <div aria-label="Do‘kon tanlash" className="flex gap-2 flex-wrap">
              {shops.map((shop) => <button key={shop.id} type="button" disabled={saving} onClick={() => setSelectedShopId(shop.id)} aria-pressed={shop.id === selectedShopId} className={`min-h-11 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors touch-manipulation ${shop.id === selectedShopId ? 'border-brand-olive bg-brand-olive/20 text-foreground' : 'border-border bg-card hover:bg-secondary'}`}>
                {shop.name} <span className="ml-1 text-xs opacity-70">· {shop.table_count} ta</span>
              </button>)}
            </div>
          )}

          {selectedShop && <>
            <div className="odina-panel border border-border rounded-2xl bg-card premium-shadow p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="space-y-1">
                  <div className="text-xs font-semibold tracking-wider text-brand-ink uppercase">Do‘kon stollari</div>
                  <h2 className="font-display text-xl sm:text-2xl font-semibold">{selectedShop.name}</h2>
                  <p className="text-sm text-muted-foreground">{tableCount ? `${tableCount} ta stol sozlangan` : 'Stollar soni hali belgilanmagan'}</p>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-olive/30 bg-brand-olive/10 px-3 py-1.5 text-xs font-medium text-brand-ink"><ShieldCheck className="w-4 h-4" /> {canManage ? 'Admin boshqaruvi' : 'Faqat o‘z do‘koningiz'}</span>
              </div>
              {canManage && (
                <div className="mt-5 pt-5 border-t border-border space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-end gap-3 sm:justify-between">
                    <div className="space-y-2">
                      <label htmlFor="odina-table-count" className="text-sm font-semibold">Stollar soni</label>
                      <div className="flex items-center gap-2">
                        <Button type="button" variant="outline" aria-label="Bitta stol kamaytirish" disabled={saving || !validCount || count <= 0} onClick={() => adjustCount(-1)} className="w-11 h-11 rounded-xl p-0"><Minus className="w-4 h-4" /></Button>
                        <input id="odina-table-count" type="number" inputMode="numeric" min="0" max={MAX_TABLES} step="1" value={draftCount} disabled={saving} onChange={(event) => setDraftCount(event.target.value)} className="w-20 h-11 rounded-xl border border-input bg-card text-center font-semibold text-lg" />
                        <Button type="button" variant="outline" aria-label="Bitta stol ko‘paytirish" disabled={saving || !validCount || count >= MAX_TABLES} onClick={() => adjustCount(1)} className="w-11 h-11 rounded-xl p-0"><Plus className="w-4 h-4" /></Button>
                      </div>
                    </div>
                    <Button type="button" onClick={saveCount} disabled={saving || !hasChanges} className="min-h-11 rounded-xl bg-primary hover:bg-primary-strong text-primary-foreground px-6">{saving ? 'Saqlanmoqda…' : 'Stollarni saqlash'}</Button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground mr-1">Tez tanlash:</span>
                    {QUICK_COUNTS.map((quickCount) => <button key={quickCount} type="button" disabled={saving} onClick={() => setDraftCount(String(quickCount))} className={`min-h-10 min-w-10 rounded-xl border px-3 text-sm font-medium transition-colors ${draftCount === String(quickCount) ? 'border-brand-olive bg-brand-olive/15' : 'border-border hover:bg-secondary'}`}>{quickCount} ta</button>)}
                  </div>
                  <p className="text-xs text-muted-foreground">0 — stollar ko‘rsatilmaydi. 1–30 oralig‘ida tanlang. O‘zgarish faqat «Stollarni saqlash» bosilganda bazaga yoziladi.</p>
                  {!validCount && <p role="alert" className="text-xs text-destructive">0–{MAX_TABLES} oralig‘ida butun son kiriting.</p>}
                </div>
              )}
            </div>

            {tableCount > 0 ? (
              <section aria-label={`${selectedShop.name} stollari`} className="space-y-4">
                <div className="flex items-center justify-between gap-3 flex-wrap"><h2 className="font-display text-xl font-semibold">Stollar rejasi</h2><span className="text-xs text-muted-foreground">{tableCount} ta stol · hozircha faqat ko‘rish</span></div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                  {Array.from({ length: tableCount }, (_, i) => i + 1).map((number) => (
                    <div key={`${selectedShop.id}-${number}`} className="group min-h-40 rounded-2xl border border-brand-sand/55 bg-card premium-shadow p-4 flex flex-col justify-between gap-4">
                      <div className="flex justify-between items-start gap-2"><span className="rounded-xl w-10 h-10 flex items-center justify-center bg-brand-olive/10 text-brand-ink"><Armchair className="w-5 h-5" /></span><span className="text-xs text-brand-ink/70 font-semibold">№ {String(number).padStart(2, '0')}</span></div>
                      <div><h3 className="font-display text-lg font-semibold">{number}-stol</h3><p className="text-xs text-muted-foreground mt-1">Buyurtma va band qilish keyingi bosqichda</p></div>
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <div className="rounded-2xl border border-dashed border-brand-olive/40 bg-card p-8 sm:p-12 text-center space-y-3"><span className="w-14 h-14 bg-brand-olive/10 rounded-2xl mx-auto flex items-center justify-center"><Sparkles className="w-7 h-7 text-brand-ink" /></span><h2 className="font-display text-xl font-semibold">Stollarni sozlashga tayyor</h2><p className="max-w-md mx-auto text-sm text-muted-foreground">{canManage ? 'Yuqorida stol sonini tanlab saqlang. Har bir do‘konga alohida son belgilanadi.' : 'Admin ushbu do‘kon uchun stollar sonini belgilagach shu yerda ko‘rinadi.'}</p></div>
            )}
          </>}
          <div className="rounded-xl border border-brand-olive/25 bg-brand-olive/5 p-4 flex items-start gap-3 text-sm text-muted-foreground"><ChevronDown className="w-4 h-4 shrink-0 mt-0.5 text-brand-ink" /><p><strong className="text-foreground">1-bosqich:</strong> do‘kon bo‘yicha stollarni sozlash va ko‘rish. Keyingi bosqichlarda ochiq buyurtma, to‘lov, stokdan aynan bir marta ayirish va vaqtli bron ulanadi. Hozir ushbu sahifa savdo yoki qoldiqni o‘zgartirmaydi.</p></div>
        </div>
      )}
    </div>
  );
}
