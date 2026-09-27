import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';
import { Loader2, Save, Send, CheckCircle2, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { formatNum } from '@/lib/pos';
import StockCountReviewDialog from './StockCountReviewDialog';

const UNIT = { g: 'g', ml: 'ml', piece: 'dona', sheet: 'list' };

export default function StockCountDraft({ user, data, onClose, onSaved }) {
  const role = user?.role || 'cashier';
  const isAdmin = role === 'admin' || role === 'manager';
  const { count, items } = data;
  const isDraft = count.status === 'draft';
  const isSubmitted = count.status === 'submitted';
  const isApproved = count.status === 'approved';
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [review, setReview] = useState(null);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    setRows((items || []).map((it) => ({
      id: it.id,
      item_kind: it.item_kind === 'ingredient' ? 'ingredient' : 'product',
      item_id: it.item_id || it.product_id,
      name: it.item_name_snapshot || it.product_name_snapshot,
      unit: it.unit,
      system: Number(it.system_quantity || 0),
      counted: it.was_counted ? String(it.counted_quantity) : '',
      reason: it.reason || '', was_counted: !!it.was_counted, applied: !!it.applied, stale: !!it.stale,
    })));
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const setRow = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const computeDiff = (r) => {
    if (r.counted === '' || r.counted === null) return null;
    const c = Number(r.counted);
    return Number.isFinite(c) ? Math.round((c - r.system) * 1000) / 1000 : null;
  };

  const buildPayload = () => rows.map((r) => ({
    item_id: r.id,
    counted_quantity: r.counted === '' ? null : Number(r.counted),
    reason: r.reason,
  }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await base44.functions.invoke('stock-count', { action: 'save_items', count_id: count.id, items: buildPayload() });
      const d = res?.data || res;
      void odinaAlert('Qoralama saqlandi.');
      onSaved(d.count, d.items);
    } catch (e) { void odinaAlert('Saqlash amalga oshmadi: ' + (e?.response?.data?.error || e?.message || e)); }
    finally { setSaving(false); }
  };

  const submit = async () => {
    for (const r of rows) {
      const d = computeDiff(r);
      if (d !== null && d !== 0 && !r.reason.trim()) { void odinaAlert(`"${r.name}" uchun farq sababini kiriting.`); return; }
    }
    const ok = await odinaConfirm("Sanog'ni tasdiqlashga yuborasizmi? Qoldiq hali o'zgarmaydi — egasi tasdiqlaydi.", { title: 'Tasdiqlashga yuborish', confirmLabel: 'Yuborish' });
    if (!ok) return;
    setSubmitting(true);
    try {
      const savedResponse = await base44.functions.invoke('stock-count', { action: 'save_items', count_id: count.id, items: buildPayload() });
      const saved = savedResponse?.data || savedResponse;
      const res = await base44.functions.invoke('stock-count', { action: 'submit_count', count_id: count.id });
      const d = res?.data || res;
      onSaved(d.count, saved.items || items);
      void odinaAlert('Tasdiqlashga yuborildi.');
    } catch (e) { void odinaAlert('Yuborish amalga oshmadi: ' + (e?.response?.data?.error || e?.message || e)); }
    finally { setSubmitting(false); }
  };

  const openReview = () => {
    const changes = rows
      .map((r) => ({ ...r, diff: computeDiff(r) }))
      .filter((r) => r.diff !== null && r.diff !== 0);
    setReview(changes);
  };

  const approve = async () => {
    setReview(null);
    setApproving(true);
    const requestId = `${count.id}-${Date.now()}`;
    try {
      const res = await base44.functions.invoke('stock-count', { action: 'approve_count', count_id: count.id, approval_request_id: requestId });
      const d = res?.data || res;
      if (d.count?.status === 'approved') {
        void odinaAlert("Sanog' tasdiqlandi. Qoldiqlar tuzatildi.");
        onSaved(d.count, d.items);
      } else {
        onSaved(d.count, d.items);
        if (d.stale > 0) void odinaAlert(`${d.stale} ta qoldiq sanog'dan keyin o'zgargan. "Yangilash" tugmasini bosing va qayta sanang.`);
        else void odinaAlert('Ayrim tuzatishlar qo\'llanmadi. Qayta tasdiqlang.');
      }
    } catch (e) { void odinaAlert('Tasdiqlash amalga oshmadi: ' + (e?.response?.data?.error || e?.message || e)); }
    finally { setApproving(false); }
  };

  const refreshStale = async () => {
    const ok = await odinaConfirm("Eski qoldiqqa qaytib, o'zgargan qoldiqlarni qayta sanashga tayyormisiz? Sanoq qoralamaga qaytadi.", { title: 'Yangilash', confirmLabel: 'Yangilash' });
    if (!ok) return;
    try {
      const res = await base44.functions.invoke('stock-count', { action: 'refresh_stale_items', count_id: count.id });
      const d = res?.data || res;
      onSaved(d.count, d.items);
      void odinaAlert('Yangilandi. Belgilangan qoldiqlarni qayta sanang, so‘ng yana yuboring.');
    } catch (e) { void odinaAlert('Yangilash amalga oshmadi: ' + (e?.message || e)); }
  };

  const cancel = async () => {
    const ok = await odinaConfirm("Sanog'ni bekor qilasizmi?", { title: 'Bekor qilish', tone: 'danger', confirmLabel: 'Bekor' });
    if (!ok) return;
    try {
      await base44.functions.invoke('stock-count', { action: 'cancel_count', count_id: count.id });
      void odinaAlert('Bekor qilindi.');
      onClose();
    } catch (e) { void odinaAlert("Bekor qilib bo'lmadi: " + (e?.message || e)); }
  };

  const summary = useMemo(() => {
    let counted = 0, diffs = 0;
    for (const r of rows) {
      const d = computeDiff(r);
      if (d !== null) { counted++; if (d !== 0) diffs++; }
    }
    return { counted, diffs };
  }, [rows]);

  const statusText = isDraft ? 'Qoralama — qoldiqlarni sanang.' : isSubmitted ? 'Tasdiqlashga yuborilgan.' : isApproved ? "Tasdiqlangan — o'zgartirib bo'lmaydi." : 'Bekor qilingan.';
  const canCancel = (isDraft || isSubmitted) && (isAdmin || role === 'manager' || count.counted_by_id === user?.id);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl flex items-center gap-2">
            {count.count_number}
            <span className="text-sm font-normal text-muted-foreground">· {count.location_name}</span>
          </DialogTitle>
          <p className="text-sm text-muted-foreground">{statusText}</p>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mahsulot yoki masalliq qidirish…" className="h-11 pl-10 rounded-xl" />
          </div>
          <div className="text-xs text-muted-foreground">Sanaldi: <b>{summary.counted}</b>/{rows.length} · Farqli pozitsiya: <b>{summary.diffs}</b></div>
        </div>

        <div className="rounded-2xl border border-border overflow-hidden">
          <div className="overflow-x-auto max-h-[48dvh] overflow-y-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-xs uppercase tracking-wide text-muted-foreground sticky top-0">
                <tr>
                  <th className="text-left font-semibold px-3 py-2.5">Nomi</th>
                  <th className="text-center font-semibold px-2 py-2.5">Birlik</th>
                  <th className="text-right font-semibold px-3 py-2.5">Tizimdagi qoldiq</th>
                  <th className="text-right font-semibold px-3 py-2.5">Amalda sanaldi</th>
                  <th className="text-right font-semibold px-3 py-2.5">Farq</th>
                  <th className="text-left font-semibold px-3 py-2.5 min-w-[160px]">Sabab</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const d = computeDiff(r);
                  return (
                    <tr key={r.id} className={`border-t border-border ${r.stale ? 'bg-amber-50' : ''}`}>
                      <td className="px-3 py-2 font-medium">
                        {r.name}
                        <div className="text-[11px] font-normal text-muted-foreground">{r.item_kind === 'ingredient' ? 'Masalliq / qadoq' : 'Tayyor mahsulot'}</div>
                        {r.stale && <span className="ml-1 text-amber-600" title="Qoldiq sanog‘dan keyin o‘zgargan">⚠</span>}
                        {r.applied && <span className="ml-1 text-emerald-600" title="Tuzatildi">✓</span>}
                      </td>
                      <td className="px-2 py-2 text-center text-muted-foreground">{UNIT[r.unit] || r.unit}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{formatNum(r.system)}</td>
                      <td className="px-3 py-2 text-right">
                        {isDraft ? (
                          <Input
                            type="number"
                            inputMode={['piece', 'sheet'].includes(r.unit) ? 'numeric' : 'decimal'}
                            min="0"
                            step={['piece', 'sheet'].includes(r.unit) ? '1' : '0.001'}
                            value={r.counted}
                            onChange={(e) => setRow(r.id, { counted: e.target.value })}
                            placeholder="—"
                            className="h-10 w-24 text-right rounded-lg ml-auto"
                          />
                        ) : (
                          <span className="font-medium">{r.was_counted ? formatNum(Number(r.counted)) : '—'}</span>
                        )}
                      </td>
                      <td className={`px-3 py-2 text-right font-semibold ${d === null ? 'text-muted-foreground' : d > 0 ? 'text-emerald-600' : d < 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>
                        {d === null ? '—' : (d > 0 ? '+' : '') + formatNum(d)}
                      </td>
                      <td className="px-3 py-2">
                        {isDraft ? (
                          <Input value={r.reason} onChange={(e) => setRow(r.id, { reason: e.target.value })}
                            placeholder={d !== null && d !== 0 ? 'Sabab majburiy' : 'Farq 0 — kerak emas'}
                            className={`h-10 rounded-lg text-sm ${d !== null && d !== 0 && !r.reason.trim() ? 'border-amber-300' : ''}`} />
                        ) : (
                          <span className="text-muted-foreground text-xs">{r.reason || '—'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {isApproved && (
          <div className="rounded-xl bg-secondary/50 p-3 text-sm flex justify-between">
            <span>Yakunlangan sanoq</span><b>{count.difference_items || 0} ta farqli pozitsiya</b>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2 flex-wrap">
            {canCancel && <Button variant="outline" onClick={cancel} className="text-destructive hover:text-destructive">Bekor qilish</Button>}
            {isSubmitted && isAdmin && <Button variant="outline" onClick={refreshStale}><RefreshCw className="w-4 h-4 mr-1.5" />Eskilarni yangilash</Button>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Yopish</Button>
            {isSubmitted && isAdmin && (
              <Button onClick={openReview} disabled={approving} className="bg-primary text-primary-foreground hover:bg-primary-strong">
                <CheckCircle2 className="w-4 h-4 mr-1.5" /> Tasdiqlash
              </Button>
            )}
            {isDraft && (
              <>
                <Button variant="outline" onClick={save} disabled={saving}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />} Saqlash
                </Button>
                <Button onClick={submit} disabled={submitting} className="bg-primary text-primary-foreground hover:bg-primary-strong">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4 mr-1.5" />} Tasdiqlashga yuborish
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>

      {review && <StockCountReviewDialog changes={review} onConfirm={approve} onClose={() => setReview(null)} approving={approving} />}
    </Dialog>
  );
}