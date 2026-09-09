import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert } from '@/lib/odina-dialog';
import { Ticket, Plus, Pencil, Trash2 } from 'lucide-react';
import { formatNum, logAction } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    setCodes(c || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const remove = async (code) => {
    if (!confirm(`Delete code "${code.code}"?`)) return;
    await base44.entities.DiscountCode.delete(code.id);
    await logAction(user, 'discount_deleted', code.code);
    load();
  };

  return (
    <div className="odina-page p-5 sm:p-8 max-w-4xl mx-auto animate-fade-in">
      <PageHeader
        title="Discount Codes"
        subtitle={`${codes.length} codes`}
        icon={Ticket}
        actions={canManage && (
          <Button onClick={() => { setEditing(null); setOpen(true); }} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            <Plus className="w-4 h-4 mr-1.5" /> Add code
          </Button>
        )}
      />
      {loading ? (
        <div className="grid sm:grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : codes.length === 0 ? (
        <p className="text-sm text-muted-foreground py-16 text-center">No discount codes yet.</p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {codes.map((c) => (
            <div key={c.id} className="odina-panel flex items-center gap-3 rounded-2xl bg-card border border-border premium-shadow p-4">
              <div className="w-11 h-11 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center"><Ticket className="w-5 h-5" /></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold font-mono truncate">{c.code}</div>
                <div className="text-xs text-muted-foreground">{c.percentage}% off · used {formatNum(c.usage_count || 0)}× · {c.active ? 'Active' : 'Inactive'}</div>
              </div>
              {canManage && (
                <div className="flex gap-1">
                  <button onClick={() => { setEditing(c); setOpen(true); }} className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:bg-secondary"><Pencil className="w-4 h-4" /></button>
                  <button onClick={() => remove(c)} className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
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
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setCodeVal(code?.code || '');
      setPct(code?.percentage ?? '');
      setActive(code?.active !== false);
      setNote(code?.note || '');
    }
  }, [open, code]);

  const save = async () => {
    if (!codeVal.trim() || !pct) { void odinaAlert('Code and percentage are required.'); return; }
    setSaving(true);
    try {
      const payload = { code: codeVal.trim().toUpperCase(), percentage: Number(pct), active, note: note || undefined };
      if (code) { await base44.entities.DiscountCode.update(code.id, payload); await logAction(user, 'discount_updated', payload.code); }
      else { await base44.entities.DiscountCode.create({ ...payload, usage_count: 0 }); await logAction(user, 'discount_created', payload.code); }
      onSaved();
    } catch (e) { void odinaAlert('Save failed: ' + (e?.message || e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle className="font-display text-xl">{code ? 'Edit code' : 'New discount code'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Code</Label>
            <Input value={codeVal} onChange={(e) => setCodeVal(e.target.value.toUpperCase())} placeholder="SUMMER10" className="font-mono uppercase" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Percentage (%)</Label>
            <Input type="number" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="10" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Note (optional)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Summer promo" />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-primary" /> Active
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}