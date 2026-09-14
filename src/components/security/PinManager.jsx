import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { odinaAlert } from '@/lib/odina-dialog';
import { KeyRound, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { logAction } from '@/lib/pos';

export default function PinManager({ user, onSaved }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!/^\d{4,8}$/.test(pin)) return void odinaAlert('PIN kod 4–8 ta raqamdan iborat bo‘lishi kerak.');
    if (pin !== confirm) return void odinaAlert('PIN kodlar bir xil emas.');
    setSaving(true);
    try {
      await base44.functions.invoke('set-owner-pin', { pin });
      await logAction(user, 'owner_pin_updated', 'PIN updated from Security page');
      setPin('');
      setConfirm('');
      void odinaAlert('Egasi tasdiqlash PIN kodi xavfsiz saqlandi.');
      onSaved?.();
    } catch (e) {
      void odinaAlert('PIN kodni saqlashda xato: ' + (e?.response?.data?.error || e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5 space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="w-5 h-5 text-brand-ink" />
        <h2 className="font-display text-lg font-bold">Egasi tasdiqlash PIN kodi</h2>
      </div>
      <p className="text-xs text-muted-foreground">Qaytarish va himoyalangan kassa amallarida ishlatiladi. PIN kodning o'zi saqlanmaydi — faqat PBKDF2 xeshi (210 000 iteratsiya).</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <Label className="text-xs mb-1.5 block">Yangi PIN (4–8 raqam)</Label>
          <Input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
        </div>
        <div>
          <Label className="text-xs mb-1.5 block">PIN kodni takrorlang</Label>
          <Input type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value.replace(/\D/g, '').slice(0, 8))} />
        </div>
      </div>
      <Button onClick={save} disabled={saving || !pin || !confirm} variant="outline" className="min-h-11 rounded-xl">
        <Save className="w-4 h-4 mr-1.5" /> {saving ? 'Xavfsiz saqlanmoqda…' : 'PIN kodni saqlash'}
      </Button>
    </section>
  );
}