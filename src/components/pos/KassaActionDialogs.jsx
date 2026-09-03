import React, { useEffect, useState } from 'react';
import { ShieldCheck, Banknote, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatUZS } from '@/lib/pos';

export function OwnerPinDialog({ open, title = 'Owner approval', description, onClose, onConfirm, loading }) {
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
          <Label className="text-xs mb-1.5 block">Owner PIN</Label>
          <Input
            autoFocus type="password" inputMode="numeric" autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="••••"
            className="h-12 text-center text-xl tracking-[0.45em]"
          />
          <p className="text-xs text-muted-foreground mt-1.5">The PIN is never displayed or saved in this form.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={submit} disabled={loading || !/^\d{4,8}$/.test(pin)} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {loading ? 'Checking…' : 'Approve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CashWithdrawalDialog({ open, shift, onClose, onConfirm, loading }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [employeeName, setEmployeeName] = useState('');

  useEffect(() => {
    if (open) { setAmount(''); setReason(''); setEmployeeName(''); }
  }, [open]);

  const valid = Number(amount) > 0 && reason.trim() && employeeName.trim();

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !loading && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="w-11 h-11 rounded-2xl bg-amber-50 text-amber-700 flex items-center justify-center mb-2">
            <Banknote className="w-5 h-5" />
          </div>
          <DialogTitle className="font-display text-xl">Remove cash from drawer</DialogTitle>
          <p className="text-sm text-muted-foreground">Expected drawer cash: {formatUZS(shift?.expected_cash)}</p>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Amount</Label>
            <Input autoFocus type="number" min="1" max={shift?.expected_cash || undefined} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Reason</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is cash being removed?" rows={2} />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Employee name</Label>
            <Input value={employeeName} onChange={(e) => setEmployeeName(e.target.value)} placeholder="Who received or removed the cash?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button onClick={() => valid && onConfirm({ amount: Number(amount), reason: reason.trim(), employee_name: employeeName.trim() })} disabled={loading || !valid} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {loading ? 'Recording…' : 'Record cash out'}
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
          <DialogTitle className="font-display text-xl">Refund sale</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {sale?.sale_number || 'Sale'} · {formatUZS(sale?.total)} will be refunded to the original payment methods.
          </p>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Refund reason</Label>
            <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required for the audit history" rows={3} />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Owner PIN</Label>
            <Input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="••••" className="h-11 text-center text-lg tracking-[0.4em]" />
          </div>
          <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-destructive">
            This cannot be undone. The original sale remains preserved for audit history.
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant="destructive" onClick={() => valid && onConfirm({ reason: reason.trim(), owner_pin: pin })} disabled={loading || !valid}>
            {loading ? 'Refunding…' : 'Confirm refund'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
