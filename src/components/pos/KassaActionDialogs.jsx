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
          <div className="w-11 h-11 rounded-2xl bg-primary/15 text-brand-ink flex items-center justify-center mb-2">
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

export function CashWithdrawalDialog({ open, shift, user, recipients = [], supplierDebts = {}, onClose, onConfirm, loading }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [expenseCategory, setExpenseCategory] = useState('shop_expense');
  const [recipientId, setRecipientId] = useState('');
  const [ownerChoice, setOwnerChoice] = useState('Abdulloh');
  const [otherOwner, setOtherOwner] = useState('');
  const [ownerPin, setOwnerPin] = useState('');

  useEffect(() => {
    if (open) {
      setAmount('');
      setReason('');
      setExpenseCategory('shop_expense');
      setRecipientId('');
      setOwnerChoice('Abdulloh');
      setOtherOwner('');
      setOwnerPin('');
    }
  }, [open]);

  const recipientRequired = expenseCategory === 'goods_payment';
  const debtRecipients = recipients.filter((recipient) => Number(supplierDebts[recipient.id] || 0) > 0);
  const selectedDebt = Number(supplierDebts[recipientId] || 0);
  const ownerPinRequired = recipientRequired && user?.role === 'cashier';
  const ownerName = ownerChoice === 'other' ? otherOwner.trim() : 'Abdulloh';
  const ownerRequired = expenseCategory === 'owner_withdrawal';
  const valid = Number(amount) > 0
    && Number(amount) <= Number(shift?.expected_cash || 0)
    && reason.trim()
    && (!recipientRequired || (recipientId && Number(amount) <= selectedDebt))
    && (!ownerPinRequired || /^\d{4,8}$/.test(ownerPin))
    && (!ownerRequired || ownerName);
  const employeeName = user?.full_name || user?.email || 'Joriy Kassa xodimi';

  const submit = () => {
    if (!valid) return;
    onConfirm({
      amount: Number(amount),
      reason: reason.trim(),
      expense_category: expenseCategory,
      recipient_id: recipientRequired ? recipientId : undefined,
      recipient_name: ownerRequired ? ownerName : undefined,
      owner_pin: ownerPinRequired ? ownerPin : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !loading && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <div className="w-11 h-11 rounded-2xl bg-amber-50 text-amber-700 flex items-center justify-center mb-2">
            <Banknote className="w-5 h-5" />
          </div>
          <DialogTitle className="font-display text-xl">Kassadan pul olish</DialogTitle>
          <p className="text-sm text-muted-foreground">Kassadagi kutilayotgan pul: {formatUZS(shift?.expected_cash)}</p>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Chiqim turi</Label>
            <select
              value={expenseCategory}
              onChange={(event) => {
                setExpenseCategory(event.target.value);
                setRecipientId('');
              }}
              className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm"
            >
              <option value="shop_expense">Do‘kon xarajati</option>
              <option value="goods_payment">Tovarlarga pul</option>
              <option value="owner_withdrawal">Egasi olgan pul</option>
              <option value="other_expense">Boshqa chiqim</option>
            </select>
          </div>

          {recipientRequired && (
            <div>
              <Label className="text-xs mb-1.5 block">Kompaniya / yetkazib beruvchi</Label>
              <select value={recipientId} onChange={(event) => setRecipientId(event.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
                <option value="">Ro‘yxatdan tanlang</option>
                {debtRecipients.map((recipient) => <option key={recipient.id} value={recipient.id}>{recipient.name} · qarz {formatUZS(supplierDebts[recipient.id])}</option>)}
              </select>
              {debtRecipients.length === 0 && <p className="text-xs text-amber-700 mt-1.5">Hozir to‘lanadigan yetkazib beruvchi qarzi yo‘q.</p>}
              {recipientId && <p className="text-xs text-muted-foreground mt-1.5">Qolgan umumiy qarz: <span className="font-semibold text-foreground">{formatUZS(selectedDebt)}</span></p>}
            </div>
          )}

          {ownerPinRequired && (
            <div>
              <Label className="text-xs mb-1.5 block">Egasi PIN-kodi</Label>
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={ownerPin}
                onChange={(event) => setOwnerPin(event.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="••••"
                className="h-11 rounded-xl text-center text-lg tracking-[0.4em]"
              />
              <p className="text-xs text-muted-foreground mt-1.5">Yetkazib beruvchi qarzini kassadan to‘lash owner tasdig‘i bilan amalga oshadi.</p>
            </div>
          )}

          {ownerRequired && (
            <div className="space-y-2">
              <Label className="text-xs block">Pulni olgan shaxs</Label>
              <select value={ownerChoice} onChange={(event) => setOwnerChoice(event.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
                <option value="Abdulloh">Abdulloh</option>
                <option value="other">Boshqa shaxs</option>
              </select>
              {ownerChoice === 'other' && (
                <Input value={otherOwner} onChange={(event) => setOtherOwner(event.target.value)} placeholder="Shaxs ismini yozing" className="h-11 rounded-xl" />
              )}
            </div>
          )}

          <div>
            <Label className="text-xs mb-1.5 block">Miqdor</Label>
            <Input autoFocus type="number" min="1" max={recipientRequired ? Math.min(Number(shift?.expected_cash || 0), selectedDebt || Infinity) : (shift?.expected_cash || undefined)} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0" className="h-11 rounded-xl" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Izoh / sabab</Label>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Pul nima uchun berildi?" rows={2} />
          </div>
          <div className="rounded-xl bg-muted/60 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">Operatsiyani bajarayotgan xodim</p>
            <p className="text-sm font-medium mt-0.5">{employeeName}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Bekor qilish</Button>
          <Button onClick={submit} disabled={loading || !valid} className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-strong">
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