import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { formatUZS, PAYMENT_METHODS } from '@/lib/pos';
import { buildIdempotencyKey } from '@/lib/orders';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function OrderPaymentDialog({ open, onClose, order, onDone }) {
  const { toast } = useToast();
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState(order?.remaining_balance || 0);
  const [kind, setKind] = useState('balance');
  const [submitting, setSubmitting] = useState(false);

  React.useEffect(() => { if (open) setAmount(order?.remaining_balance || 0); }, [open, order]);

  const submit = async () => {
    if (!order) return;
    const amt = Math.round(Number(amount) || 0);
    if (amt <= 0) { toast({ title: 'Musbat summa kiriting', variant: 'destructive' }); return; }
    setSubmitting(true);
    try {
      const res = await base44.functions.invoke('customer-orders', {
        action: 'record_payment',
        order_id: order.id,
        method,
        amount: amt,
        payment_kind: kind,
        idempotency_key: buildIdempotencyKey('pay'),
      });
      const data = res?.data || res;
      if (data?.payment) {
        toast({ title: 'To‘lov qabul qilindi', description: formatUZS(amt) });
        onDone();
      } else {
        throw new Error(data?.error || 'To‘lov amalga oshmadi');
      }
    } catch (e) {
      toast({ title: 'Xatolik', description: e?.message || 'To‘lov amalga oshmadi', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>To‘lov qo‘shish</DialogTitle>
          <DialogDescription>{order?.order_number} · Qoldi: {formatUZS(order?.remaining_balance || 0)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          <div>
            <Label>To‘lov turi</Label>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
              <option value="balance">Qoldiq to‘lov</option>
              <option value="advance">Avans</option>
              <option value="additional">Qo‘shimcha</option>
            </select>
          </div>
          <div>
            <Label>Usul</Label>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
              {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <Label>Summa (UZS)</Label>
            <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>Bekor</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Qabul qilish
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}