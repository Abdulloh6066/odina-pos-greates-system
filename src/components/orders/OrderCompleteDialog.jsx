import React, { useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { base44 } from '@/api/base44Client';
import { formatUZS, PAYMENT_METHODS } from '@/lib/pos';
import { buildIdempotencyKey } from '@/lib/orders';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose,
} from '@/components/ui/dialog';
import { Loader2, Truck, PackageCheck } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

export default function OrderCompleteDialog({ open, onClose, order, onDone }) {
  const { toast } = useToast();
  const remaining = Number(order?.remaining_balance || 0);
  const needsPayment = remaining > 0;
  const [method, setMethod] = useState('cash');
  const [submitting, setSubmitting] = useState(false);

  React.useEffect(() => { if (open) setMethod('cash'); }, [open]);

  const handoffLabel = order?.fulfilment_type === 'delivery' ? 'Yuborildi' : 'Olib ketildi';

  const submit = async () => {
    if (!order) return;
    setSubmitting(true);
    try {
      const payload = {
        action: 'complete_order',
        order_id: order.id,
        idempotency_key: buildIdempotencyKey('complete'),
      };
      if (needsPayment) {
        payload.method = method;
        payload.amount = remaining;
      }
      const res = await base44.functions.invoke('customer-orders', payload);
      const data = res?.data || res;
      if (data?.order) {
        toast({ title: data.already_completed ? 'Allaqachon yakunlangan' : handoffLabel, description: data.order.order_number });
        onDone(data);
      } else {
        throw new Error(data?.error || 'Amal bajarilmadi');
      }
    } catch (e) {
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
            {order?.order_number} · {needsPayment
              ? `Qoldiq: ${formatUZS(remaining)} — qoldiq to‘lovni qabul qiling`
              : 'To‘liq to‘langan — buyurtmani yakunlang'}
          </DialogDescription>
        </DialogHeader>

        {needsPayment ? (
          <div className="space-y-3 mt-2">
            <div>
              <Label>To‘lov usuli</Label>
              <OdinaSelect
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
            {handoffLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}