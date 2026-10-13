import '@/styles/operations-workbench.css';
import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';
import { Ticket, Plus, Pencil, Trash2 } from 'lucide-react';
import { logAction } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import OdinaSelect from '@/components/ui/odina-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

export default function DiscountCodes() {
  const { user } = useOutletContext();
  const canManage = ['admin', 'accountant'].includes(user?.role);
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const c = await base44.entities.DiscountCode.list();
    setCodes((c || []).filter((item) => (
      item.active !== false &&
      (item.single_use === false || Number(item.usage_count || 0) < 1)
    )));
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const remove = async (code) => {
    const accepted = await odinaConfirm(`“${code.code}” chegirma kodini o‘chirasizmi?`, {
      title: 'Chegirma kodini o‘chirish',
      tone: 'danger',
      confirmLabel: 'O‘chirish',
    });
    if (!accepted) return;
    await base44.entities.DiscountCode.delete(code.id);
    await logAction(user, 'discount_deleted', code.code);
    load();
  };

  return (
    <div className="odina-page odina-workbench odina-operations odina-discountcodes p-5 sm:p-8 max-w-4xl mx-auto animate-fade-in">
      <PageHeader
        title="Chegirma kodlari"
        eyebrow="SAVDO AKSIYALARI"
        subtitle={`${codes.length} ta kod · chegirma shartlari, muddati va foydalanish tartibi`}
        icon={Ticket}
        actions={canManage && (
          <Button onClick={() => { setEditing(null); setOpen(true); }} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            <Plus className="w-4 h-4 mr-1.5" /> Kod qo‘shish
          </Button>
        )}
      />
      {loading ? (
        <div className="grid sm:grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : codes.length === 0 ? (
        <p className="odina-operations-empty text-sm text-muted-foreground py-16 text-center">Hozircha chegirma kodi yo‘q.</p>
      ) : (
        <div className="odina-discount-grid grid sm:grid-cols-2 gap-4">
          {codes.map((c) => (
            <div key={c.id} className="odina-discount-card odina-panel flex items-center gap-3 rounded-2xl bg-card border border-border p-4">
              <div className="odina-discount-percent" aria-label={`${c.percentage}% chegirma`}>{c.percentage}<span>%</span></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold font-mono truncate">{c.code}</div>
                <div className="text-xs text-muted-foreground">{c.single_use === false ? 'Cheksiz foydalanish' : 'Bir martalik'}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {c.valid_until ? c.valid_until.split('-').reverse().join('.') + ' gacha' : 'Muddatsiz'}
                  {' · '}{c.valid_until && Date.now() > Date.parse(c.valid_until + 'T23:59:59.999+05:00') ? 'Muddati tugagan' : 'Faol'}
                </div>
              </div>
              {canManage && (
                <div className="flex gap-1">
                  <button aria-label={`${c.code} — tahrirlash`} onClick={() => { setEditing(c); setOpen(true); }} className="w-11 h-11 rounded-lg border border-border flex items-center justify-center hover:bg-secondary"><Pencil className="w-4 h-4" /></button>
                  <button aria-label={`${c.code} — o‘chirish`} onClick={() => remove(c)} className="w-11 h-11 rounded-lg border border-border flex items-center justify-center hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <CodeDialog open={open} code={editing} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); }} user={user} />
    </div>
  );
}

function CodeDialog({ open, code, onClose, onSaved, user }) {
  const [codeVal, setCodeVal] = useState('');
  const [pct, setPct] = useState('');
  const [active, setActive] = useState(true);
  const [usage, setUsage] = useState('once');
  const [validity, setValidity] = useState('forever');
  const [validUntil, setValidUntil] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setCodeVal(code?.code || '');
      setPct(code?.percentage ?? '');
      setActive(code?.active !== false);
      setUsage(code?.single_use === false ? 'unlimited' : 'once');
      setValidity(code?.valid_until ? 'date' : 'forever');
      setValidUntil(code?.valid_until || '');
      setNote(code?.note || '');
    }
  }, [open, code]);

  const save = async () => {
    const percentage = Number(pct);
    if (!codeVal.trim() || !Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      void odinaAlert('Kod va 1–100 oralig‘idagi chegirma foizini kiriting.');
      return;
    }
    if (validity === 'date') {
      const end = Date.parse(validUntil + 'T23:59:59.999+05:00');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || !Number.isFinite(end)
        || new Date(end + 5 * 60 * 60 * 1000).toISOString().slice(0, 10) !== validUntil
        || end < Date.now()) {
        void odinaAlert('Bugungi yoki kelajakdagi tugash sanasini tanlang.');
        return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        code: codeVal.trim().toUpperCase(),
        percentage,
        active,
        single_use: usage === 'once',
        valid_until: validity === 'date' ? validUntil : '',
        note: note || undefined,
      };
      if (code) { await base44.entities.DiscountCode.update(code.id, payload); await logAction(user, 'discount_updated', payload.code); }
      else { await base44.entities.DiscountCode.create({ ...payload, usage_count: 0 }); await logAction(user, 'discount_created', payload.code); }
      onSaved();
    } catch (e) { void odinaAlert('Saqlashda xato: ' + (e?.message || e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle className="font-display text-xl">{code ? 'Kodni tahrirlash' : 'Yangi chegirma kodi'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Kod</Label>
            <Input value={codeVal} onChange={(e) => setCodeVal(e.target.value.toUpperCase())} placeholder="SUMMER10" className="font-mono uppercase" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Chegirma foizi (%)</Label>
            <Input type="number" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="10" />
          </div>
          <div>
            <Label htmlFor="promo-usage" className="text-xs mb-1.5 block">Foydalanish</Label>
            <OdinaSelect id="promo-usage" value={usage} onChange={(e) => setUsage(e.target.value)} className="w-full">
              <option value="once">Bir martalik</option>
              <option value="unlimited">Cheksiz foydalanish</option>
            </OdinaSelect>
          </div>
          <div>
            <Label htmlFor="promo-validity" className="text-xs mb-1.5 block">Amal qilish muddati</Label>
            <OdinaSelect id="promo-validity" value={validity} onChange={(e) => setValidity(e.target.value)} className="w-full">
              <option value="forever">Muddatsiz</option>
              <option value="date">Belgilangan sanagacha</option>
            </OdinaSelect>
          </div>
          {validity === 'date' && (
            <div>
              <Label htmlFor="promo-end" className="text-xs mb-1.5 block">Oxirgi amal qilish kuni</Label>
              <Input id="promo-end" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1.5">Tanlangan kun oxirigacha amal qiladi.</p>
            </div>
          )}
          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Masalan: Yozgi aksiya" />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-primary" /> Faol
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">{saving ? 'Saqlanmoqda…' : 'Saqlash'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
