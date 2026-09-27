import React, { useEffect, useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { odinaAlert } from '@/lib/odina-dialog';
import { ClipboardCheck, Plus, Loader2, CheckCircle2, Clock, Send, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import OdinaSelect from '@/components/ui/odina-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import StockCountDraft from './StockCountDraft';

const STATUS_META = {
  draft: { label: 'Qoralama', icon: Clock, cls: 'bg-secondary text-muted-foreground' },
  submitted: { label: 'Tasdiqlashda', icon: Send, cls: 'bg-amber-100 text-amber-800' },
  approved: { label: 'Tasdiqlangan', icon: CheckCircle2, cls: 'bg-emerald-100 text-emerald-700' },
  cancelled: { label: 'Bekor qilingan', icon: XCircle, cls: 'bg-rose-100 text-rose-700' },
};

export default function StockCountPanel({ user, location, locations }) {
  const role = user?.role || 'cashier';
  const canCount = ['admin', 'manager', 'cashier', 'accountant'].includes(role);
  const [counts, setCounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newLoc, setNewLoc] = useState('');
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke('stock-count', { action: 'list_counts' });
      setCounts((res?.data || res)?.counts || []);
    } catch { setCounts([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCount = async (c) => {
    try {
      const res = await base44.functions.invoke('stock-count', { action: 'get_count', count_id: c.id });
      const data = res?.data || res;
      setActive({ count: data.count, items: data.items });
    } catch (e) { void odinaAlert("Sanog'ni ochib bo'lmadi: " + (e?.message || e)); }
  };

  const startNew = async () => {
    const locId = (role === 'admin')
      ? newLoc
      : (user?.shop_id || user?.data?.shop_id || '');
    if (!locId) { void odinaAlert("Do'konni tanlang."); return; }
    setStarting(true);
    try {
      const res = await base44.functions.invoke('stock-count', { action: 'start_count', location_id: locId });
      const data = res?.data || res;
      setShowNew(false); setNewLoc('');
      setActive({ count: data.count, items: data.items });
      load();
    } catch (e) { void odinaAlert("Sanog'ni boshlab bo'lmadi: " + (e?.message || e)); }
    finally { setStarting(false); }
  };

  const onSavedDraft = (count, items) => { setActive({ count, items }); load(); };
  const closeActive = () => { setActive(null); load(); };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Tayyor mahsulotlar, masalliqlar va qadoqlarni jismoniy sanash. Qoldiq faqat egasi tasdiqlagach o‘zgartiriladi.</p>
        {canCount && (
          <Button onClick={() => setShowNew(true)} className="bg-primary text-primary-foreground hover:bg-primary-strong shrink-0">
            <Plus className="w-4 h-4 mr-1.5" /> Yangi sanoq
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : counts.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-14 text-center text-sm text-muted-foreground">
          <ClipboardCheck className="w-9 h-9 mx-auto mb-2 opacity-40" /> Hozircha sanoqlar yo‘q.
        </div>
      ) : (
        <div className="space-y-2.5">
          {counts.map((c) => {
            const m = STATUS_META[c.status] || STATUS_META.draft;
            const Icon = m.icon;
            return (
              <button key={c.id} onClick={() => openCount(c)} className="w-full text-left rounded-2xl border border-border bg-card premium-shadow p-4 flex items-center gap-3 hover:bg-secondary/40 transition-colors touch-manipulation">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${m.cls}`}><Icon className="w-5 h-5" /></div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{c.count_number}</div>
                  <div className="text-xs text-muted-foreground">{c.location_name} · {c.counted_items || 0}/{c.total_items || 0} sanaldi · {c.difference_items || 0}ta farq</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-medium text-muted-foreground">{m.label}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Dialog open={showNew} onOpenChange={(o) => !o && !starting && setShowNew(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="font-display text-xl">Yangi ombor sanog‘i</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {(role === 'admin') ? (
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Do‘kon</label>
                <OdinaSelect value={newLoc} onChange={(e) => setNewLoc(e.target.value)} className="h-11 w-full">
                  <option value="">Tanlang…</option>
                  {(locations || []).filter((l) => l.active !== false).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </OdinaSelect>
              </div>
            ) : (
              <div className="rounded-xl bg-secondary/60 p-3 text-sm">Sanog‘ sizning do‘koningizda boshlanadi: <b>{location?.name || user?.shop_name || user?.data?.shop_name || '—'}</b></div>
            )}
            <p className="text-xs text-muted-foreground">Tizim tayyor mahsulot, masalliq va qadoqlarning hozirgi qoldig‘ini belgilaydi. Siz jismoniy sanalgan miqdorni kiritasiz. Qoralama egasi tasdiqlaguncha qoldiqni o‘zgartirmaydi.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNew(false)} disabled={starting}>Bekor</Button>
            <Button onClick={startNew} disabled={starting} className="bg-primary text-primary-foreground hover:bg-primary-strong">
              {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Boshlash'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {active && (
        <StockCountDraft user={user} data={active} onClose={closeActive} onSaved={onSavedDraft} />
      )}
    </div>
  );
}