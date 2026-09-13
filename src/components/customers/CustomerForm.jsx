import React, { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { normalizePhone } from '@/lib/customers';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, X } from 'lucide-react';

const LABELS = [
  { key: '', label: '—' },
  { key: 'vip', label: 'VIP' },
  { key: 'doimiy', label: 'Doimiy' },
  { key: 'korporativ', label: 'Korporativ' },
];

export default function CustomerForm({ open, onClose, onSaved, customer }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ first_name: '', last_name: '', phone: '', birth_date: '', label: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(customer?.id);

  useEffect(() => {
    if (!open) return;
    if (customer) {
      setForm({
        first_name: customer.first_name || '',
        last_name: customer.last_name || '',
        phone: customer.phone || '',
        birth_date: customer.birth_date || '',
        label: customer.label || '',
        notes: customer.notes || '',
      });
    } else {
      setForm({ first_name: '', last_name: '', phone: '', birth_date: '', label: '', notes: '' });
    }
  }, [open, customer]);

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

  const valid = form.first_name.trim() && form.phone.trim();

  const submit = async () => {
    if (!valid) {
      toast({ title: 'Ism va telefon majburiy', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        phone: form.phone.trim(),
        phone_normalized: normalizePhone(form.phone),
        birth_date: form.birth_date || '',
        label: form.label,
        notes: form.notes,
      };
      let saved;
      if (isEdit) {
        saved = await base44.entities.Customer.update(customer.id, payload);
      } else {
        saved = await base44.entities.Customer.create(payload);
      }
      toast({ title: isEdit ? 'Mijoz yangilandi' : 'Mijoz yaratildi' });
      onSaved?.(saved);
      onClose?.();
    } catch (e) {
      toast({ title: 'Xatolik', description: e?.message || 'Saqlanmadi', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Mijozni tahrirlash' : 'Yangi mijoz'}</DialogTitle>
          <DialogDescription>Mijoz ma’lumotlarini to‘ldiring.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Ism *</Label>
              <Input value={form.first_name} onChange={(e) => update({ first_name: e.target.value })} className="mt-1" />
            </div>
            <div>
              <Label>Familiya</Label>
              <Input value={form.last_name} onChange={(e) => update({ last_name: e.target.value })} className="mt-1" />
            </div>
          </div>
          <div>
            <Label>Telefon *</Label>
            <Input value={form.phone} onChange={(e) => update({ phone: e.target.value })} placeholder="+998..." className="mt-1" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tug‘ilgan sana</Label>
              <Input type="date" value={form.birth_date} onChange={(e) => update({ birth_date: e.target.value })} className="mt-1" />
            </div>
            <div>
              <Label>Teg</Label>
              <select
                value={form.label}
                onChange={(e) => update({ label: e.target.value })}
                className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm shadow-sm focus-visible:ring-2 focus-visible:ring-ring"
              >
                {LABELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <Label>Izoh</Label>
            <Input value={form.notes} onChange={(e) => update({ notes: e.target.value })} className="mt-1" />
          </div>
        </div>

        <DialogFooter className="mt-2 gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}><X className="w-4 h-4" /> Bekor</Button>
          <Button onClick={submit} disabled={!valid || saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Saqlash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}