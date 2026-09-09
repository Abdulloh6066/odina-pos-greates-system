import React, { useEffect, useMemo, useState } from 'react';
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

export default function CashRecipients() {
  const { user } = useOutletContext();
  const canManage = user?.role === 'admin';
  const [recipients, setRecipients] = useState([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setRecipients(await base44.entities.CashRecipient.list('name', 500) || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const query = search.toLowerCase().trim();
    if (!query) return recipients;
    return recipients.filter((item) => [item.name, item.notes].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [recipients, search]);

  if (!['admin', 'manager'].includes(user?.role)) return <Navigate to="/" replace />;

  return (
    <div className="odina-page p-5 sm:p-8 max-w-5xl mx-auto animate-fade-in">
      <PageHeader
        title="Qabul qiluvchilar"
        subtitle="Tovarlarga pul beriladigan kompaniya va yetkazib beruvchilar"
        icon={Building2}
        actions={canManage && (
          <Button onClick={() => setEditing({})} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong">
            <Plus className="w-4 h-4 mr-1.5" /> Yangi qabul qiluvchi
          </Button>
        )}
      />

      <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4 mb-5">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Kompaniya yoki yetkazib beruvchini qidirish…" className="h-11 pl-10 rounded-xl" />
        </div>
      </div>

      {loading ? (
        <div className="grid sm:grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-28 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="odina-panel rounded-2xl border border-border bg-card py-16 text-center">
          <Building2 className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="font-medium">Qabul qiluvchi topilmadi</p>
          <p className="text-sm text-muted-foreground mt-1">“Yangi qabul qiluvchi” orqali birinchi kompaniyani kiriting.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {filtered.map((item) => (
            <article key={item.id} className={`odina-panel rounded-2xl border border-border bg-card premium-shadow p-4 ${item.active === false ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center shrink-0"><Building2 className="w-4.5 h-4.5" /></div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.recipient_type === 'company' ? 'Kompaniya' : 'Yetkazib beruvchi'} · {item.active === false ? 'Faol emas' : 'Faol'}</p>
                  {item.notes && <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{item.notes}</p>}
                </div>
                {canManage && (
                  <Button variant="outline" size="icon" onClick={() => setEditing(item)} className="h-10 w-10 rounded-xl shrink-0"><Pencil className="w-4 h-4" /></Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <RecipientDialog
        open={Boolean(editing)}
        recipient={editing}
        user={user}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
    </div>
  );
}

function RecipientDialog({ open, recipient, user, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('supplier');
  const [notes, setNotes] = useState('');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(recipient?.name || '');
    setType(recipient?.recipient_type || 'supplier');
    setNotes(recipient?.notes || '');
    setActive(recipient?.active !== false);
  }, [open, recipient]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const payload = { name: name.trim(), recipient_type: type, notes: notes.trim(), active };
      if (recipient?.id) await base44.entities.CashRecipient.update(recipient.id, payload);
      else await base44.entities.CashRecipient.create({ ...payload, created_by: user.id, created_by_name: user.full_name || user.email });
      onSaved();
    } catch (error) {
      alert('Qabul qiluvchini saqlab bo‘lmadi: ' + (error?.message || error));
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
