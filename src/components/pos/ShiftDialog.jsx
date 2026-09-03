import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUZS } from '@/lib/pos';

export function OpenShiftDialog({ open, shops, user, onClose, onConfirm, loading }) {
  const [shopId, setShopId] = useState('');
  const [startingCash, setStartingCash] = useState(0);

  useEffect(() => {
    if (open) {
      if (user?.role === 'cashier') {
        setShopId(user.shop_id || '');
      } else {
        const main = shops.find((s) => s.is_main);
        setShopId(main?.id || shops[0]?.id || '');
      }
      setStartingCash(0);
    }
  }, [open, shops, user]);

  const submit = () => {
    const shop = shops.find((s) => s.id === shopId);
    onConfirm({ shop, starting_cash: Number(startingCash) || 0 });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Smenani ochish</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Do‘kon</label>
            {user?.role === 'cashier' ? (
              <div className={`w-full min-h-10 rounded-lg border px-3 py-2 text-sm font-medium ${user.shop_id ? 'border-input bg-secondary/60' : 'border-destructive/40 bg-destructive/5 text-destructive'}`}>
                {user.shop_id
                  ? (shops.find((s) => s.id === user.shop_id)?.name || 'Biriktirilgan do‘kon topilmadi')
                  : 'Egasi kassirni do‘konga biriktirishi kerak.'}
              </div>
            ) : (
              <select
                value={shopId}
                onChange={(e) => setShopId(e.target.value)}
                className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm font-medium"
              >
                {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">Boshlang‘ich naqd pul</label>
            <Input
              type="number"
              value={startingCash}
              onChange={(e) => setStartingCash(e.target.value)}
              placeholder="0"
              className="h-10"
            />
            <p className="text-xs text-muted-foreground mt-1">0 UZS bilan boshlash mumkin.</p>
          </div>
        </div>
        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>Bekor qilish</Button>
          <Button onClick={submit} disabled={loading || !shopId} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {loading ? 'Ochilmoqda…' : 'Smenani ochish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CloseShiftDialog({ open, shift, onClose, onConfirm, loading }) {
  const [actualCash, setActualCash] = useState(0);
  const expected = shift?.expected_cash || 0;
  const difference = (Number(actualCash) || 0) - expected;

  useEffect(() => { if (open) setActualCash(expected); }, [open, expected]);

  const submit = () => onConfirm({ actual_cash: Number(actualCash) || 0 });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Smenani yopish</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 receipt-print">
          <div className="text-center font-mono mb-3">
            <div className="font-bold text-lg">ODINA SHOP</div>
            <div className="text-sm">SMENA HISOBOTI</div>
            <div className="text-xs">{shift?.shop_name} · {shift?.user_name}</div>
            <div className="text-xs">{new Date().toLocaleString('en-GB')}</div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <SummaryRow label="Naqd savdo" value={formatUZS(shift?.cash_sales)} />
            <SummaryRow label="Uzcard savdosi" value={formatUZS(shift?.uzcard_sales)} />
            <SummaryRow label="Humo savdosi" value={formatUZS(shift?.humo_sales)} />
            <SummaryRow label="Onlayn savdo" value={formatUZS(shift?.online_sales)} />
            <SummaryRow label="Bank o‘tkazmalari" value={formatUZS(shift?.bank_transfer_sales)} />
            <SummaryRow label="Jami savdo" value={formatUZS(shift?.total_sales)} bold />
            <SummaryRow label="Boshlang‘ich naqd pul" value={formatUZS(shift?.starting_cash)} />
            <SummaryRow label="Kutilayotgan naqd pul" value={formatUZS(expected)} bold />
            <SummaryRow label="Buyurtmalar" value={shift?.order_count || 0} />
            <SummaryRow label="Kassadan olingan pul" value={formatUZS(shift?.cash_removed)} />
            <SummaryRow label="Qaytarishlar" value={formatUZS(shift?.refunds_total)} />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">Sanab chiqilgan haqiqiy naqd pul</label>
            <Input type="number" value={actualCash} onChange={(e) => setActualCash(e.target.value)} className="h-10" />
          </div>
          <div className={`rounded-xl px-3 py-2.5 text-sm font-medium ${difference === 0 ? 'bg-emerald-50 text-emerald-700' : difference > 0 ? 'bg-primary/10 text-primary-strong' : 'bg-red-50 text-destructive'}`}>
            Difference: {difference > 0 ? '+' : ''}{formatUZS(difference)}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Bekor qilish</Button>
          <Button onClick={submit} disabled={loading} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {loading ? 'Yopilmoqda…' : 'Smenani yopish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({ label, value, bold }) {
  return (
    <div className={`flex items-center justify-between rounded-lg bg-secondary/60 px-3 py-2 ${bold ? 'font-semibold' : ''}`}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span>{typeof value === 'number' ? formatUZS(value) : value}</span>
    </div>
  );
}