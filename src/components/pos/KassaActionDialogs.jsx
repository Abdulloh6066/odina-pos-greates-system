import React, { useEffect, useState } from 'react';
import { ShieldCheck, Banknote, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatUZS } from '@/lib/pos';

export function OwnerPinDialog({ open, title = 'Egasi tasdig‘i', description, onClose, onConfirm, loading }) {
  const [pin, setPin] = useState('');
  useEffect(() => { if (open) setPin(''); }, [open]);

  const submit = () => {
    if (!/^\d{4,8}$/.test(pin)) return;
    onConfirm(pin);
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !loading && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="w-11 h-11 rounded-2xl bg-primary/15 text-primary-strong flex items-center justify-center mb-2">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <DialogTitle className="font-display text-xl">{title}</DialogTitle>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </DialogHeader>
        <div>
          <Label className="text-xs mb-1.5 block">Egasi PIN-kodi</Label>
          <Input
            autoFocus type="password" inputMode="numeric" autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="••••"
            className="h-12 text-center text-xl tracking-[0.45em]"
          />
          <p className="text-xs text-muted-foreground mt-1.5">PIN-kod bu oynada ko‘rsatilmaydi va saqlanmaydi.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Bekor qilish</Button>
          <Button onClick={submit} disabled={loading || !/^\d{4,8}$/.test(pin)} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {loading ? 'Tekshirilmoqda…' : 'Tasdiqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CashWithdrawalDialog({ open, shift, user, onClose, onConfirm, loading }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) { setAmount(''); setReason(''); }
  }, [open]);

  const valid = Number(amount) > 0 && reason.trim();
  const employeeName = user?.full_name || user?.email || 'Joriy Kassa xodimi';

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !loading && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="w-11 h-11 rounded-2xl bg-amber-50 text-amber-700 flex items-center justify-center mb-2">
            <Banknote className="w-5 h-5" />
          </div>
          <DialogTitle className="font-display text-xl">Kassadan pul olish</DialogTitle>
          <p className="text-sm text-muted-foreground">Kassadagi kutilayotgan pul: {formatUZS(shift?.expected_cash)}</p>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Miqdor</Label>
            <Input autoFocus type="number" min="1" max={shift?.expected_cash || undefined} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Sabab</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Pul nima sababdan olinmoqda?" rows={2} />
          </div>
          <div className="rounded-xl bg-muted/60 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">Avtomatik ravishda xodim nomiga yoziladi</p>
            <p className="text-sm font-medium mt-0.5">{employeeName}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Bekor qilish</Button>
          <Button onClick={() => valid && onConfirm({ amount: Number(amount), reason: reason.trim() })} disabled={loading || !valid} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {loading ? 'Saqlanmoqda…' : 'Pul olishni saqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RefundDialog({ open, sale, onClose, onConfirm, loading }) {
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');

  useEffect(() => {
    if (open) { setReason(''); setPin(''); }
  }, [open]);

  const valid = reason.trim() && /^\d{4,8}$/.test(pin);

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !loading && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="w-11 h-11 rounded-2xl bg-red-50 text-destructive flex items-center justify-center mb-2">
            <RotateCcw className="w-5 h-5" />
          </div>
          <DialogTitle className="font-display text-xl">Savdoni qaytarish</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {sale?.sale_number || 'Savdo'} · {formatUZS(sale?.total)} dastlabki to‘lov usullariga qaytariladi.
          </p>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Qaytarish sababi</Label>
            <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Nazorat tarixi uchun majburiy" rows={3} />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Egasi PIN-kodi</Label>
            <Input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="••••" className="h-11 text-center text-lg tracking-[0.4em]" />
          </div>
          <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-destructive">
            Bu amalni bekor qilib bo‘lmaydi. Asl savdo nazorat tarixi uchun saqlanadi.
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Bekor qilish</Button>
          <Button variant="destructive" onClick={() => valid && onConfirm({ reason: reason.trim(), owner_pin: pin })} disabled={loading || !valid}>
            {loading ? 'Qaytarilmoqda…' : 'Qaytarishni tasdiqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}