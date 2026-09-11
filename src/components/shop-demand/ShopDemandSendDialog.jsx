import React, { useMemo, useState } from 'react';
import { Minus, Plus, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { remainingForItem, unitLabel } from '@/lib/shop-demand';
import { formatNum } from '@/lib/pos';

export default function ShopDemandSendDialog({ open, onClose, request, onSend }) {
  const items = request?.items || [];
  const [qty, setQty] = useState({});
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (open) setQty({});
  }, [open, request?.id]);

  const rows = useMemo(() => items.map((it) => {
    const rem = remainingForItem(it);
    return { it, rem, chosen: Number(qty[it.id] || 0) };
  }), [items, qty]);

  const valid = rows.filter((r) => r.chosen > 0 && r.chosen <= r.rem);

  const submit = async () => {
    if (valid.length === 0) return;
    setSaving(true);
    try {
      await onSend(request.id, valid.map((r) => ({ request_item_id: r.it.id, quantity: r.chosen })));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Do'konga yuborish — {request?.request_number}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-1">
          {request?.shop_name_snapshot} · markaziy ombordan. Mahsulot markaziy ombordan ayriladi va mavjud transfer oqimi orqali yuboriladi.
        </p>
        <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
          {rows.map(({ it, rem, chosen }) => (
            <div key={it.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{it.product_name_snapshot}</p>
                  <p className="text-xs text-muted-foreground">
                    Talab {formatNum(it.requested_quantity)} {unitLabel(it.unit)} · yuborildi {formatNum(it.sent_quantity)} · qoldi <b className="text-rose-600">{formatNum(rem)}</b>
                  </p>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Button type="button" size="icon" variant="outline" onClick={() => setQty((q) => ({ ...q, [it.id]: Math.max(0, Number(q[it.id] || 0) - 1) }))} className="w-9 h-9 rounded-lg shrink-0">
                  <Minus className="w-3.5 h-3.5" />
                </Button>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={rem}
                  value={chosen || ''}
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(rem, Math.floor(Number(e.target.value) || 0)));
                    setQty((q) => ({ ...q, [it.id]: v }));
                  }}
                  className="h-9 rounded-lg text-center px-1 w-24"
                />
                <Button type="button" size="icon" variant="outline" onClick={() => setQty((q) => ({ ...q, [it.id]: Math.min(rem, Number(q[it.id] || 0) + 1) }))} disabled={chosen >= rem} className="w-9 h-9 rounded-lg shrink-0">
                  <Plus className="w-3.5 h-3.5" />
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setQty((q) => ({ ...q, [it.id]: rem }))} className="ml-auto h-9 rounded-lg touch-manipulation">
                  Hammasi ({formatNum(rem)})
                </Button>
              </div>
            </div>
          ))}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor</Button>
          <Button onClick={submit} disabled={saving || valid.length === 0} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            <Send className="w-4 h-4 mr-1.5" />
            {saving ? 'Yuborilmoqda…' : `${valid.length} tur yuborish`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}