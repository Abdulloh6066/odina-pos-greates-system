import React, { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle2, PackageCheck, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUZS } from '@/lib/pos';

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
  const [cashLeft, setCashLeft] = useState(0);
  const [stockReport, setStockReport] = useState({ rows: [] });
  const [stockCounts, setStockCounts] = useState({});
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState('');
  const expected = shift?.expected_cash || 0;
  const countedCash = Number(actualCash) || 0;
  const leftForNextShift = Number(cashLeft) || 0;
  const budgetCashSubmitted = countedCash - leftForNextShift;
  const difference = countedCash - expected;
  const splitInvalid = countedCash < 0 || leftForNextShift < 0 || leftForNextShift > countedCash;
  const stockRows = stockReport?.rows || [];
  const isValidCount = (value) => (
    value !== '' && value !== null && value !== undefined
    && Number.isInteger(Number(value)) && Number(value) >= 0
  );
  const countedProductCount = stockRows.filter((row) => isValidCount(stockCounts[row.product_id])).length;
  const stockCountComplete = !stockLoading && !stockError && countedProductCount === stockRows.length;
  const differenceProductCount = stockRows.filter((row) => (
    isValidCount(stockCounts[row.product_id])
    && Number(stockCounts[row.product_id]) !== Number(row.expected_quantity || 0)
  )).length;

  const loadStockReport = async () => {
    if (!shift?.id) return;
    setStockLoading(true);
    setStockError('');
    setStockCounts({});
    try {
      const result = await base44.functions.invoke('complete-sale', {
        action: 'get_shift_stock_report',
        shift_id: shift.id,
      });
      const payload = result?.data || result;
      if (!payload?.stock_report) {
        throw new Error(payload?.error || 'Mahsulot qoldiqlarini yuklab bo‘lmadi.');
      }
      setStockReport(payload.stock_report);
    } catch (error) {
      setStockReport({ rows: [] });
      setStockError(shiftErrorText(error));
    } finally {
      setStockLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setActualCash(expected);
      setCashLeft(0);
      loadStockReport();
    } else {
      setStockReport({ rows: [] });
      setStockCounts({});
      setStockError('');
    }
  }, [open, shift?.id, expected]);

  const setProductCount = (productId, value) => {
    setStockCounts((current) => ({ ...current, [productId]: value }));
  };

  const submit = () => {
    if (splitInvalid || !stockCountComplete) return;
    onConfirm({
      actual_cash: countedCash,
      budget_cash_submitted: budgetCashSubmitted,
      cash_left_for_next_shift: leftForNextShift,
      stock_counts: stockRows.map((row) => ({
        product_id: row.product_id,
        counted_quantity: Number(stockCounts[row.product_id]),
      })),
    });
  };

  const closeDisabled = loading || splitInvalid || !stockCountComplete;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl max-h-[calc(100dvh-1rem)] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Smenani yopish</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 receipt-print">
          <div className="text-center font-mono">
            <div className="font-bold text-lg">ODINA SHOP</div>
            <div className="text-sm">SMENA HISOBOTI</div>
            <div className="text-xs">{shift?.shop_name} · {shift?.user_name}</div>
            <div className="text-xs">{new Date().toLocaleString('en-GB')}</div>
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

          <section className="space-y-3 border-t border-border pt-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
              <div>
                <h3 className="font-semibold flex items-center gap-2">
                  <PackageCheck className="w-5 h-5 text-brand-ink" />
                  Mahsulot qoldiqlarini sanash
                </h3>
                <p className="text-xs text-muted-foreground mt-1">Kassada qolgan har bir tortni sanab, “Haqiqiy” maydoniga kiriting.</p>
              </div>
              {!stockLoading && !stockError && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded-full bg-secondary px-2.5 py-1">{countedProductCount}/{stockRows.length} sanaldi</span>
                  <span className={`rounded-full px-2.5 py-1 ${differenceProductCount ? 'bg-red-50 text-destructive' : 'bg-emerald-50 text-emerald-700'}`}>{differenceProductCount} tur farqli</span>
                </div>
              )}
            </div>

            {stockLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-16 rounded-xl bg-secondary animate-pulse" />)}
              </div>
            ) : stockError ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-destructive">Qoldiq hisoboti yuklanmadi</p>
                    <p className="text-sm text-red-800/80 mt-1 break-words">{stockError}</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={loadStockReport}>
                    <RefreshCw className="w-4 h-4 mr-1.5" /> Qayta
                  </Button>
                </div>
              </div>
            ) : stockRows.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-7 px-4 text-center">
                <CheckCircle2 className="w-7 h-7 text-emerald-600 mx-auto mb-2" />
                <p className="text-sm font-medium">Bu do‘konda sanaladigan mahsulot qoldig‘i yo‘q.</p>
              </div>
            ) : (
              <>
                <div className="hidden lg:block rounded-2xl border border-border overflow-x-auto">
                  <table className="w-full min-w-[850px] text-sm">
                    <thead className="bg-secondary/70 text-xs text-muted-foreground">
                      <tr>
                        <th className="text-left font-medium px-3 py-2.5">Mahsulot</th>
                        <th className="text-right font-medium px-2 py-2.5">Boshida</th>
                        <th className="text-right font-medium px-2 py-2.5">Keldi</th>
                        <th className="text-right font-medium px-2 py-2.5">Sotildi</th>
                        <th className="text-right font-medium px-2 py-2.5">Chiqit</th>
                        <th className="text-right font-medium px-2 py-2.5">Kutilgan</th>
                        <th className="text-center font-medium px-2 py-2.5 w-28">Haqiqiy</th>
                        <th className="text-right font-medium px-3 py-2.5">Farq</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {stockRows.map((row) => {
                        const countValue = stockCounts[row.product_id] ?? '';
                        const rowDifference = isValidCount(countValue) ? Number(countValue) - Number(row.expected_quantity || 0) : null;
                        return (
                          <tr key={row.product_id} className="bg-card">
                            <td className="px-3 py-3">
                              <p className="font-medium">{row.product_name_snapshot}</p>
                              {(Number(row.returned_quantity || 0) !== 0 || Number(row.other_change_quantity || 0) !== 0) && (
                                <p className="text-[11px] text-muted-foreground mt-0.5">Qaytdi +{formatStock(row.returned_quantity)} · Boshqa {signedStock(row.other_change_quantity)}</p>
                              )}
                            </td>
                            <td className="text-right px-2 py-3">{formatStock(row.opening_quantity)}</td>
                            <td className="text-right px-2 py-3 text-emerald-700">+{formatStock(row.received_quantity)}</td>
                            <td className="text-right px-2 py-3">{formatStock(row.sold_quantity)}</td>
                            <td className="text-right px-2 py-3 text-amber-700">{formatStock(row.waste_quantity)}</td>
                            <td className="text-right px-2 py-3 font-semibold">{formatStock(row.expected_quantity)}</td>
                            <td className="px-2 py-2">
                              <Input
                                aria-label={`${row.product_name_snapshot} haqiqiy qoldig‘i`}
                                type="number"
                                inputMode="numeric"
                                min="0"
                                step="1"
                                value={countValue}
                                onChange={(e) => setProductCount(row.product_id, e.target.value)}
                                placeholder="0"
                                className="h-10 text-center font-semibold"
                              />
                            </td>
                            <td className={`text-right px-3 py-3 font-semibold ${rowDifference === null || rowDifference === 0 ? 'text-emerald-700' : 'text-destructive'}`}>{rowDifference === null ? '—' : signedStock(rowDifference)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="lg:hidden space-y-3">
                  {stockRows.map((row) => {
                    const countValue = stockCounts[row.product_id] ?? '';
                    const rowDifference = isValidCount(countValue) ? Number(countValue) - Number(row.expected_quantity || 0) : null;
                    return (
                      <div key={row.product_id} className="rounded-2xl border border-border p-3.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold truncate">{row.product_name_snapshot}</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Boshida {formatStock(row.opening_quantity)} · Keldi +{formatStock(row.received_quantity)}
                              <br />
                              Sotildi {formatStock(row.sold_quantity)} · Chiqit {formatStock(row.waste_quantity)}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-[11px] text-muted-foreground">Kutilgan</p>
                            <p className="font-bold">{formatStock(row.expected_quantity)} dona</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-[1fr_auto] items-end gap-3 mt-3">
                          <div>
                            <label className="text-xs font-medium mb-1 block">Haqiqiy qoldiq</label>
                            <Input
                              aria-label={`${row.product_name_snapshot} haqiqiy qoldig‘i`}
                              type="number"
                              inputMode="numeric"
                              min="0"
                              step="1"
                              value={countValue}
                              onChange={(e) => setProductCount(row.product_id, e.target.value)}
                              placeholder="Sanang"
                              className="h-11 font-semibold"
                            />
                          </div>
                          <div className={`min-w-20 rounded-xl px-3 py-2 text-center ${rowDifference === null || rowDifference === 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-destructive'}`}>
                            <p className="text-[10px] opacity-70">Farq</p>
                            <p className="font-bold">{rowDifference === null ? '—' : signedStock(rowDifference)}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          <div className="rounded-xl bg-secondary/60 px-3 py-2.5 text-xs text-muted-foreground">
            Uzcard, Humo, onlayn va bank tushumlari Budgetga qo‘shiladi. Mahsulot qoldiqlari esa yopilgan smenaga o‘zgarmaydigan tarix sifatida saqlanadi.
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={loading}>Bekor qilish</Button>
          <Button onClick={submit} disabled={closeDisabled} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {loading
              ? 'Yopilmoqda…'
              : stockLoading
                ? 'Qoldiqlar yuklanmoqda…'
                : !stockCountComplete
                  ? `Qoldiqni sanang (${countedProductCount}/${stockRows.length})`
                  : 'Smenani yopish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const shiftErrorText = (error) => (
  error?.response?.data?.error || error?.data?.error || error?.message || String(error || 'Noma’lum xato')
);

const formatStock = (value) => new Intl.NumberFormat('uz-UZ', {
  maximumFractionDigits: 3,
}).format(Number(value || 0));

const signedStock = (value) => {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${formatStock(number)}`;
};

function SummaryRow({ label, value, bold }) {
  return (
    <div className={`flex flex-col items-start gap-1 rounded-xl bg-secondary/60 px-3 py-2.5 ${bold ? 'font-semibold' : ''}`}>
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-semibold break-words">{typeof value === 'number' ? formatUZS(value) : value}</span>
    </div>
  );
}