import React, { useRef, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { orderRequestScope, readOrderRequest, retainOrderRequest, clearOrderRequest, orderRequestDefinitelyRejected } from '@/lib/order-request-retry';
import OdinaSelect from '@/components/ui/odina-select';
import { base44 } from '@/api/base44Client';
import { formatUZS, PAYMENT_METHODS } from '@/lib/pos';
import { displayOrderNumber, buildIdempotencyKey } from '@/lib/orders';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function OrderPaymentDialog({ open, onClose, order, onDone }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const requestScope = orderRequestScope(user?.id, 'record_payment', order?.id);
  const pendingRef = useRef(readOrderRequest(requestScope));
  const [pending, setPending] = useState(() => readOrderRequest(requestScope));
  React.useEffect(() => {
    pendingRef.current = readOrderRequest(requestScope);
    setPending(pendingRef.current);
  }, [requestScope]);
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState(order?.remaining_balance || 0);
  const [kind, setKind] = useState('balance');
  const [submitting, setSubmitting] = useState(false);

  React.useEffect(() => {
    if (!open) return;
    const saved = readOrderRequest(requestScope);
    if (saved) { setAmount(saved.amount); setMethod(saved.method); setKind(saved.payment_kind); }
    else setAmount(order?.remaining_balance || 0);
  }, [open, order, requestScope]);

  const submit = async () => {
    if (!order || submitting) return;
    const amt = pendingRef.current?.amount ?? Math.round(Number(amount) || 0);
    if (amt <= 0) { toast({ title: 'Musbat summa kiriting', variant: 'destructive' }); return; }
    setSubmitting(true);
    try {
      const payload = retainOrderRequest(requestScope, pendingRef.current || {
        action: 'record_payment',
        order_id: order.id,
        method,
        amount: amt,
        payment_kind: kind,
        idempotency_key: buildIdempotencyKey('pay'),
      });
      pendingRef.current = payload;
      setPending(payload);
      const res = await base44.functions.invoke('customer-orders', payload);
      const data = res?.data || res;
      if (data?.payment) {
        clearOrderRequest(requestScope);
        pendingRef.current = null; setPending(null);
        toast({ title: 'To‘lov qabul qilindi', description: formatUZS(amt) });
        onDone();
      } else {
        throw Object.assign(new Error(data?.error || 'To‘lov amalga oshmadi'), { data });
      }
    } catch (e) {
      if (orderRequestDefinitelyRejected(e)) { clearOrderRequest(requestScope); pendingRef.current = null; setPending(null); }
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
          <DialogDescription>{displayOrderNumber(order)} · Qoldi: {formatUZS(order?.remaining_balance || 0)}</DialogDescription>
        </DialogHeader>
        <fieldset disabled={submitting || Boolean(pending)} className="space-y-3 mt-2">
          <div>
            <Label>To‘lov turi</Label>
            <OdinaSelect value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
              <option value="balance">Qoldiq to‘lov</option>
              <option value="advance">Avans</option>
              <option value="additional">Qo‘shimcha</option>
            </OdinaSelect>
          </div>
          <div>
            <Label>Usul</Label>
            <OdinaSelect value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
              {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </OdinaSelect>
          </div>
          <div>
            <Label>Summa (UZS)</Label>
            <Input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
          </div>
        </fieldset>
        {pending && <p className="mt-3 text-sm text-muted-foreground">Oldingi to‘lov natijasini shu ma’lumotlar bilan qayta tekshiring.</p>}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>Bekor</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null} {pending ? 'Qayta tekshirish' : 'Qabul qilish'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}