import React, { useState, useEffect } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';

export function OpenShiftDialog({ open, shops, user, onClose, onConfirm, loading }) {
  const [shopId, setShopId] = useState('');
  const [startingCash, setStartingCash] = useState(0);
  const assignedShopId = String(user?.shop_id || user?.data?.shop_id || '');
  const assignedShopName = String(user?.shop_name || user?.data?.shop_name || 'Biriktirilgan do‘kon');
  const assignedShop = shops.find((shop) => shop.id === assignedShopId)
    || (assignedShopId ? { id: assignedShopId, name: assignedShopName } : null);

  useEffect(() => {
    if (open) {
      if (user?.role === 'cashier') {
        setShopId(assignedShopId);
      } else {
        const main = shops.find((s) => s.is_main);
        setShopId(main?.id || shops[0]?.id || '');
      }
      setStartingCash(0);
    }
  }, [open, shops, user, assignedShopId]);

  const submit = () => {
    const shop = shops.find((s) => s.id === shopId)
      || (shopId === assignedShopId ? assignedShop : null);
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
              <div className={`w-full min-h-10 rounded-lg border px-3 py-2 text-sm font-medium ${assignedShopId ? 'border-input bg-secondary/60' : 'border-destructive/40 bg-destructive/5 text-destructive'}`}>
                {assignedShopId
                  ? assignedShopName
                  : 'Egasi kassirni do‘konga biriktirishi kerak.'}
              </div>
            ) : (
              <OdinaSelect
                value={shopId}
                onChange={(e) => setShopId(e.target.value)}
                className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm font-medium"
              >
                {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </OdinaSelect>
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
  const [cashLeft, setCashLeft] = useState(0);
  const expected = shift?.expected_cash || 0;
  const countedCash = Number(actualCash) || 0;
  const leftForNextShift = Number(cashLeft) || 0;
  const budgetCashSubmitted = countedCash - leftForNextShift;
  const difference = countedCash - expected;
  const splitInvalid = countedCash < 0 || leftForNextShift < 0 || leftForNextShift > countedCash;

  useEffect(() => {
    if (open) {
      setActualCash(expected);
      setCashLeft(0);
    }
  }, [open, shift?.id, expected]);

  const submit = () => {
    if (splitInvalid) return;
    onConfirm({
      actual_cash: countedCash,
      budget_cash_submitted: budgetCashSubmitted,
      cash_left_for_next_shift: leftForNextShift,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[calc(100dvh-1rem)] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Smenani yopish</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 receipt-print">
          <div className="text-center font-mono">
            <div className="font-bold text-lg">ODINA SHOP</div>
            <div className="text-sm">SMENA HISOBOTI</div>
            <div className="text-xs">{shift?.shop_name} · {shift?.user_name}</div>
            <div className="text-xs">{formatUzbekistanDateTime(Date.now())}</div>
          </div>

          <section className="space-y-3">
            <h3 className="font-semibold">Pul hisoboti</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-sm">
              <SummaryRow label="Naqd savdo" value={formatUZS(shift?.cash_sales)} />
              <SummaryRow label="Uzcard savdosi" value={formatUZS(shift?.uzcard_sales)} />
              <SummaryRow label="Humo savdosi" value={formatUZS(shift?.humo_sales)} />
              <SummaryRow label="Onlayn savdo" value={formatUZS(shift?.online_sales)} />
              <SummaryRow label="Bank o‘tkazmalari" value={formatUZS(shift?.bank_transfer_sales)} />
              <SummaryRow label="Jami savdo" value={formatUZS(shift?.total_sales)} bold />
              <SummaryRow label="Boshlang‘ich naqd pul" value={formatUZS(shift?.starting_cash)} />
              <SummaryRow label="Kutilayotgan naqd pul" value={formatUZS(expected)} bold />
              <SummaryRow label="Buyurtmalar" value={`${shift?.order_count || 0} ta`} />
              <SummaryRow label="Kassadan olingan pul" value={formatUZS(shift?.cash_removed)} />
              <SummaryRow label="Qaytarishlar" value={formatUZS(shift?.refunds_total)} />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1.5 block">Sanab chiqilgan haqiqiy naqd pul</label>
                <Input type="number" min="0" value={actualCash} onChange={(e) => setActualCash(e.target.value)} className="h-11" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Keyingi smenaga kassada qoldiriladi</label>
                <Input type="number" min="0" max={countedCash} value={cashLeft} onChange={(e) => setCashLeft(e.target.value)} className="h-11" />
                <p className="text-xs text-muted-foreground mt-1">Qolgan naqd pul Budget hisobiga topshirilgan deb yoziladi.</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SummaryRow label="Budgetga naqd topshiriladi" value={formatUZS(Math.max(0, budgetCashSubmitted))} bold />
              <SummaryRow label="Kassada qoladi" value={formatUZS(leftForNextShift)} />
            </div>
            {splitInvalid && <div className="rounded-xl px-3 py-2.5 text-sm font-medium bg-red-50 text-destructive">Keyingi smenaga qoldiriladigan pul sanalgan naqd puldan oshmasligi kerak.</div>}
            <div className={`rounded-xl px-3 py-2.5 text-sm font-medium ${difference === 0 ? 'bg-emerald-50 text-emerald-700' : difference > 0 ? 'bg-primary/10 text-brand-ink' : 'bg-red-50 text-destructive'}`}>
              Pul farqi: {difference > 0 ? '+' : ''}{formatUZS(difference)}
            </div>
          </section>

          <div className="rounded-xl bg-secondary/60 px-3 py-2.5 text-xs text-muted-foreground">
            Uzcard, Humo, onlayn va bank tushumlari Budgetga qo‘shiladi. Mahsulotlarning tizimdagi qoldig‘i smena yopilgan paytda avtomatik tarixga saqlanadi.
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>Bekor qilish</Button>
          <Button onClick={submit} disabled={loading || splitInvalid} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {loading ? 'Yopilmoqda…' : 'Smenani yopish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({ label, value, bold }) {
  return (
    <div className={`flex flex-col items-start gap-1 rounded-xl bg-secondary/60 px-3 py-2.5 ${bold ? 'font-semibold' : ''}`}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-semibold break-words">{typeof value === 'number' ? formatUZS(value) : value}</span>
    </div>
  );
}
