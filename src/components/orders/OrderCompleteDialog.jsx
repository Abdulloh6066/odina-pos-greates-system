import React, { useRef, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { orderRequestScope, readOrderRequest, retainOrderRequest, clearOrderRequest, orderRequestDefinitelyRejected } from '@/lib/order-request-retry';
import OdinaSelect from '@/components/ui/odina-select';
import { base44 } from '@/api/base44Client';
import { formatUZS, PAYMENT_METHODS } from '@/lib/pos';
import { displayOrderNumber, buildIdempotencyKey } from '@/lib/orders';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose,
} from '@/components/ui/dialog';
import { Loader2, Truck, PackageCheck } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { startOrderActionTiming } from '@/lib/order-action-timing';

export default function OrderCompleteDialog({ open, onClose, order, onDone }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const requestScope = orderRequestScope(user?.id, 'complete_order', order?.id);
  const pendingRef = useRef(readOrderRequest(requestScope));
  const [pending, setPending] = useState(() => readOrderRequest(requestScope));
  React.useEffect(() => {
    pendingRef.current = readOrderRequest(requestScope);
    setPending(pendingRef.current);
  }, [requestScope]);
  const remaining = Number(order?.remaining_balance || 0);
  const needsPayment = remaining > 0;
  const [method, setMethod] = useState('cash');
  const [submitting, setSubmitting] = useState(false);

  React.useEffect(() => { if (open) setMethod(readOrderRequest(requestScope)?.method || 'cash'); }, [open, requestScope]);

  const handoffLabel = order?.fulfilment_type === 'delivery' ? 'Yuborildi' : 'Olib ketildi';

  const submit = async () => {
    if (!order || submitting) return;
    const checkingSavedRequest = Boolean(pendingRef.current);
    const elapsedSeconds = startOrderActionTiming();
    setSubmitting(true);
    try {
      let payload = pendingRef.current;
      if (!payload) {
        payload = {
          action: 'complete_order',
          order_id: order.id,
          idempotency_key: buildIdempotencyKey('complete'),
        };
        if (needsPayment) {
          payload.method = method;
          payload.amount = remaining;
        }
      }
      payload = retainOrderRequest(requestScope, payload);
      pendingRef.current = payload; setPending(payload);
      const res = await base44.functions.invoke('customer-orders', payload);
      const data = res?.data || res;
      if (data?.order) {
        const seconds = elapsedSeconds();
        clearOrderRequest(requestScope); pendingRef.current = null; setPending(null);
        toast({ title: data.already_completed ? 'Allaqachon yakunlangan' : handoffLabel, description: `${displayOrderNumber(data.order)} · ${checkingSavedRequest || data.already_completed ? 'Qayta tekshirish' : 'Yakunlash'}: ${seconds} soniya` });
        onDone(data);
      } else {
        throw Object.assign(new Error(data?.error || 'Amal bajarilmadi'), { data });
      }
    } catch (e) {
      if (orderRequestDefinitelyRejected(e)) { clearOrderRequest(requestScope); pendingRef.current = null; setPending(null); }
      toast({ title: 'Xatolik', description: e?.message || 'Amal bajarilmadi', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {order?.fulfilment_type === 'delivery'
              ? <Truck className="w-5 h-5 text-brand-olive" />
              : <PackageCheck className="w-5 h-5 text-brand-olive" />}
            {handoffLabel}
          </DialogTitle>
          <DialogDescription>
            {displayOrderNumber(order)} · {needsPayment
              ? `Qoldiq: ${formatUZS(remaining)} — qoldiq to‘lovni qabul qiling`
              : 'To‘liq to‘langan — buyurtmani yakunlang'}
          </DialogDescription>
        </DialogHeader>

        {needsPayment ? (
          <div className="space-y-3 mt-2">
            <div>
              <Label>To‘lov usuli</Label>
              <OdinaSelect
                disabled={submitting || Boolean(pending)}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm"
              >
                {PAYMENT_METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </OdinaSelect>
            </div>
            <div className="bg-secondary/50 rounded-xl p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Qoldiq summa</span>
                <span className="font-semibold text-rose-600">{formatUZS(remaining)}</span>
              </div>
              <p className="text-xs text-muted-foreground">Aniq qoldiq summasi avtomatik to‘lanadi va faqat shu kun smenasiga qo‘shiladi.</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Buyurtma to‘liq to‘langan. Yakunlash bilan mahsulotlar zaxiradan yechiriladi va buyurtma holati «Yakunlandi» bo‘ladi.
          </p>
        )}

        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button variant="outline">Bekor</Button>
          </DialogClose>
          <Button onClick={submit} disabled={submitting}>
            {submitting
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : order?.fulfilment_type === 'delivery'
                ? <Truck className="w-4 h-4" />
                : <PackageCheck className="w-4 h-4" />}
            {pending ? 'Qayta tekshirish' : handoffLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}