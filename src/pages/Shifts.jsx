import React, { useEffect, useState, useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import {
  Banknote,
  CheckCircle2,
  ChevronRight,
  Clock,
  Package,
  PackageCheck,
  PlayCircle,
  ReceiptText,
  RotateCcw,
  WalletCards,
} from "lucide-react";
import { formatUZS, formatNum, saleOccurredAt } from "@/lib/pos";
import PageHeader from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const PAYMENT_LABELS = {
  cash: "Naqd pul",
  uzcard: "Uzcard",
  humo: "Humo",
  click: "Click",
  payme: "Payme",
  bank_transfer: "Bank o‘tkazmasi",
  other: "Boshqa onlayn",
};

const EXPENSE_LABELS = {
  shop_expense: "Do‘kon xarajati",
  goods_payment: "Tovarlarga pul",
  owner_withdrawal: "Egasi olgan pul",
  other_expense: "Boshqa chiqim",
};

const EMPTY_DETAIL = {
  sales: [],
  saleItems: [],
  movements: [],
  refunds: [],
  stockSnapshots: [],
  canViewMovements: true,
  partial: false,
};

const dateTime = (value) => {
  if (!value) return "—";
  return new Date(value).toLocaleString("uz-UZ", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tashkent",
  });
};

const errorText = (error) => (
  error?.response?.data?.error || error?.data?.error || error?.message || String(error || "Noma’lum xato")
);

export default function Shifts() {
  const { user } = useOutletContext();
  const role = user?.role || "cashier";
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedShift, setSelectedShift] = useState(null);
  const [detail, setDetail] = useState(EMPTY_DETAIL);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const all = await base44.entities.Shift.list("-opened_at", 200);
      setShifts(all || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    if (role === "cashier") return shifts.filter((shift) => shift.user_id === user?.id);
    return shifts;
  }, [shifts, role, user]);

  const open = visible.filter((shift) => shift.status === "open");
  const closed = visible.filter((shift) => shift.status === "closed");

  const openDetails = async (shift) => {
    setSelectedShift(shift);
    setDetail(EMPTY_DETAIL);
    setDetailError("");
    setDetailLoading(true);

    const canViewMovements = role === "admin" || role === "cashier";
    const requests = [
      base44.entities.Sale.filter({ shift_id: shift.id }, "-created_date", 500),
      base44.entities.SaleItem.filter({ shift_id: shift.id }, "-created_at", 500),
      canViewMovements
        ? base44.entities.CashMovement.filter({ shift_id: shift.id }, "-created_at", 500)
        : Promise.resolve([]),
      base44.entities.Refund.filter({ shift_id: shift.id }, "-created_at", 500),
      base44.entities.ShiftProductSnapshot.filter({ shift_id: shift.id }, "product_name_snapshot", 500),
    ];

    try {
      const results = await Promise.allSettled(requests);
      if (results[0].status === "rejected") throw results[0].reason;

      setDetail({
        sales: results[0].value || [],
        saleItems: results[1].status === "fulfilled" ? results[1].value || [] : [],
        movements: results[2].status === "fulfilled" ? results[2].value || [] : [],
        refunds: results[3].status === "fulfilled" ? results[3].value || [] : [],
        stockSnapshots: results[4].status === "fulfilled" ? results[4].value || [] : [],
        canViewMovements,
        partial: results.slice(1).some((result) => result.status === "rejected"),
      });
    } catch (error) {
      setDetailError(errorText(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetails = () => {
    setSelectedShift(null);
    setDetail(EMPTY_DETAIL);
    setDetailError("");
  };

  return (
    <div className="odina-page p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader
        title="Smenalar"
        subtitle={role === "cashier" ? "Sizning smenalar tarixingiz" : "Barcha do‘kon smenalari"}
        icon={Clock}
      />

      {loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-44 rounded-2xl bg-secondary animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <PlayCircle className="w-4 h-4 text-emerald-600" /> Hozir ochiq
              </h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {open.map((shift) => (
                  <ShiftCard key={shift.id} shift={shift} onOpen={() => openDetails(shift)} />
                ))}
              </div>
            </div>
          )}

          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" /> Yopilgan
          </h2>
          {closed.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center">Hali yopilgan smena yo‘q.</p>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {closed.map((shift) => (
                <ShiftCard key={shift.id} shift={shift} onOpen={() => openDetails(shift)} />
              ))}
            </div>
          )}
        </>
      )}

      <ShiftDetailDialog
        shift={selectedShift}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onClose={closeDetails}
      />
    </div>
  );
}

function ShiftCard({ shift, onOpen }) {
  const opened = new Date(shift.opened_at || shift.created_date);
  const diff = Number(shift.difference || 0);
  const plastic = Number(shift.uzcard_sales || 0) + Number(shift.humo_sales || 0);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="odina-panel w-full text-left rounded-2xl bg-card border border-border premium-shadow p-4 sm:p-5 transition-all hover:-translate-y-0.5 hover:premium-shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="font-semibold truncate">{shift.shop_name}</div>
          <div className="text-xs text-muted-foreground">{shift.user_name}</div>
        </div>
        <span className={"text-[11px] px-2 py-0.5 rounded-full font-medium " + (
          shift.status === "open"
            ? "bg-emerald-50 text-emerald-700"
            : "bg-secondary text-muted-foreground"
        )}>
          {shift.status === "open" ? "Ochiq" : "Yopilgan"}
        </span>
      </div>

      <div className="text-xs text-muted-foreground mb-3">
        {opened.toLocaleString("uz-UZ", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
        {shift.closed_at ? " → " + new Date(shift.closed_at).toLocaleString("uz-UZ", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }) : ""}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Cell label="Jami" value={formatUZS(shift.total_sales)} bold />
        <Cell label="Buyurtmalar" value={formatNum(shift.order_count)} />
        <Cell label="Naqd pul" value={formatUZS(shift.cash_sales)} />
        <Cell label="Plastik" value={formatUZS(plastic)} />
        <Cell label="Uzcard" value={formatUZS(shift.uzcard_sales)} />
        <Cell label="Humo" value={formatUZS(shift.humo_sales)} />
      </div>

      {shift.status === "closed" && (
        <div className={"mt-3 text-sm font-medium px-3 py-2 rounded-xl " + (
          diff === 0
            ? "bg-emerald-50 text-emerald-700"
            : diff > 0
              ? "bg-primary/10 text-brand-ink"
              : "bg-red-50 text-destructive"
        )}>
          Naqd pul farqi: {diff > 0 ? "+" : ""}{formatUZS(diff)}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-border flex items-center justify-end gap-1 text-xs font-medium text-brand-ink">
        Batafsil ko‘rish <ChevronRight className="w-4 h-4" />
      </div>
    </button>
  );
}

function ShiftDetailDialog({ shift, detail, loading, error, onClose }) {
  const saleItemsBySale = useMemo(() => {
    const grouped = new Map();
    for (const item of detail.saleItems || []) {
      const list = grouped.get(item.sale_id) || [];
      list.push(item);
      grouped.set(item.sale_id, list);
    }
    return grouped;
  }, [detail.saleItems]);

  const products = useMemo(() => {
    const grouped = new Map();

    for (const sale of detail.sales || []) {
      const recorded = saleItemsBySale.get(sale.id);
      const items = recorded?.length ? recorded : sale.items || [];

      for (const item of items) {
        const productId = item.product_id || "";
        const name = item.product_name_snapshot || item.product_name || "Noma’lum mahsulot";
        const key = productId || name;
        const quantity = Number(item.quantity || 0);
        const amount = Number(
          item.line_total ?? item.subtotal ?? Number(item.unit_price || item.price || 0) * quantity,
        );
        const current = grouped.get(key) || { key, name, quantity: 0, amount: 0 };
        current.quantity += quantity;
        current.amount += amount;
        grouped.set(key, current);
      }
    }

    return Array.from(grouped.values()).sort((a, b) => b.quantity - a.quantity);
  }, [detail.sales, saleItemsBySale]);

  if (!shift) return null;

  const plastic = Number(shift.uzcard_sales || 0) + Number(shift.humo_sales || 0);
  const online = Number(shift.online_sales || 0) + Number(shift.bank_transfer_sales || 0);
  const movementsTotal = (detail.movements || []).reduce(
    (sum, movement) => sum + Number(movement.amount || 0),
    0,
  );
  const refundsTotal = (detail.refunds || []).reduce(
    (sum, refund) => sum + Number(refund.amount || 0),
    0,
  );
  const diff = Number(shift.difference || 0);

  return (
    <Dialog open={!!shift} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[92dvh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Smena tafsilotlari</DialogTitle>
        </DialogHeader>

        <div className="text-xs text-muted-foreground -mt-1">
          {shift.shop_name} · Kassir: {shift.user_name}
          <br />
          {dateTime(shift.opened_at || shift.created_date)}
          {shift.closed_at ? " → " + dateTime(shift.closed_at) : ""}
        </div>

        {loading ? (
          <div className="space-y-3 py-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-20 rounded-xl bg-secondary animate-pulse" />
              ))}
            </div>
            <div className="h-44 rounded-2xl bg-secondary animate-pulse" />
            <div className="h-44 rounded-2xl bg-secondary animate-pulse" />
          </div>
        ) : error ? (
          <div className="rounded-xl bg-red-50 text-destructive p-4 text-sm">
            Smena ma’lumotlarini yuklab bo‘lmadi: {error}
          </div>
        ) : (
          <div className="space-y-5">
            {detail.partial && (
              <div className="rounded-xl bg-amber-50 text-amber-800 p-3 text-xs">
                Ayrim eski qo‘shimcha yozuvlar yuklanmadi. Asosiy smena va savdo ma’lumotlari ko‘rsatilmoqda.
              </div>
            )}

            <section>
              <SectionTitle icon={WalletCards} title="Smena hisoboti" />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                <SummaryCard label="Jami savdo" value={formatUZS(shift.total_sales)} />
                <SummaryCard label="Naqd savdo" value={formatUZS(shift.cash_sales)} />
                <SummaryCard label="Plastik" value={formatUZS(plastic)} />
                <SummaryCard label="Onlayn / bank" value={formatUZS(online)} />
                <SummaryCard label="Kassadan berildi" value={formatUZS(shift.cash_removed || movementsTotal)} warn />
                <SummaryCard label="Qaytarishlar" value={formatUZS(shift.refunds_total || refundsTotal)} danger />
              </div>

              <div className="mt-3 rounded-2xl border border-border overflow-hidden">
                <CashRow label="Boshlang‘ich naqd pul" value={formatUZS(shift.starting_cash)} />
                <CashRow label="Kutilgan naqd pul" value={formatUZS(shift.expected_cash)} />
                {shift.status === "closed" && (
                  <>
                    <CashRow label="Sanalgan naqd pul" value={formatUZS(shift.actual_cash)} />
                    {shift.budget_settled && (
                      <>
                        <CashRow label="Budgetga topshirilgan naqd" value={formatUZS(shift.budget_cash_submitted)} />
                        <CashRow label="Keyingi smenaga qoldirilgan" value={formatUZS(shift.cash_left_for_next_shift)} />
                      </>
                    )}
                    <CashRow
                      label="Farq"
                      value={(diff > 0 ? "+" : "") + formatUZS(diff)}
                      valueClass={diff === 0 ? "text-emerald-700" : diff > 0 ? "text-brand-ink" : "text-destructive"}
                      bold
                    />
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-xs">
                <Cell label="Uzcard" value={formatUZS(shift.uzcard_sales)} />
                <Cell label="Humo" value={formatUZS(shift.humo_sales)} />
                <Cell label="Onlayn" value={formatUZS(shift.online_sales)} />
                <Cell label="Bank" value={formatUZS(shift.bank_transfer_sales)} />
              </div>
            </section>

            {shift.status === "closed" && (
              <StockSnapshotSection
                snapshots={detail.stockSnapshots}
                recorded={shift.stock_count_completed === true}
              />
            )}

            <section>
              <SectionTitle
                icon={Package}
                title={"Sotilgan mahsulotlar · " + formatNum(products.reduce((sum, item) => sum + item.quantity, 0)) + " dona"}
              />
              {products.length === 0 ? (
                <EmptyText text="Bu smenada mahsulot savdosi topilmadi." />
              ) : (
                <div className="rounded-2xl border border-border divide-y divide-border overflow-hidden">
                  {products.map((product) => (
                    <div key={product.key} className="flex items-center justify-between gap-3 px-3.5 py-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{product.name}</p>
                        <p className="text-xs text-muted-foreground">{formatNum(product.quantity)} dona</p>
                      </div>
                      <p className="font-semibold whitespace-nowrap">{formatUZS(product.amount)}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <SectionTitle
                icon={ReceiptText}
                title={"Barcha savdolar · " + formatNum(detail.sales.length)}
              />
              {detail.sales.length === 0 ? (
                <EmptyText text="Bu smenada savdo topilmadi." />
              ) : (
                <div className="space-y-3">
                  {detail.sales.map((sale) => {
                    const recordedItems = saleItemsBySale.get(sale.id);
                    const items = recordedItems?.length ? recordedItems : sale.items || [];

                    return (
                      <div key={sale.id} className="rounded-2xl border border-border p-3.5">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold">{sale.sale_number || "Savdo"}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{dateTime(saleOccurredAt(sale))}</p>
                          </div>
                          <div className="text-right">
                            <p className={"font-semibold " + (sale.status === "refunded" ? "line-through text-muted-foreground" : "")}>
                              {formatUZS(sale.total)}
                            </p>
                            {sale.status === "refunded" && (
                              <span className="text-[11px] text-destructive">Qaytarilgan</span>
                            )}
                          </div>
                        </div>

                        <div className="mt-3 pt-3 border-t border-dashed border-border space-y-1.5">
                          {items.map((item, index) => {
                            const name = item.product_name_snapshot || item.product_name || "Mahsulot";
                            const quantity = Number(item.quantity || 0);
                            const amount = Number(
                              item.line_total ?? item.subtotal ?? Number(item.unit_price || item.price || 0) * quantity,
                            );
                            return (
                              <div key={item.id || index} className="flex justify-between gap-3 text-sm">
                                <span className="min-w-0">{formatNum(quantity)}× {name}</span>
                                <span className="font-medium whitespace-nowrap">{formatUZS(amount)}</span>
                              </div>
                            );
                          })}
                        </div>

                        {Number(sale.discount_amount || 0) > 0 && (
                          <div className="flex justify-between text-xs text-brand-ink mt-2">
                            <span>Chegirma{sale.discount_code ? " · " + sale.discount_code : ""}</span>
                            <span>−{formatUZS(sale.discount_amount)}</span>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-1.5 mt-3">
                          {(sale.payments || []).map((payment, index) => (
                            <span key={index} className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium">
                              {PAYMENT_LABELS[payment.method] || payment.method}: {formatUZS(payment.amount)}
                            </span>
                          ))}
                          {(!sale.payments || sale.payments.length === 0) && sale.payment_methods_summary && (
                            <span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium">
                              {sale.payment_methods_summary}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <SectionTitle
                icon={Banknote}
                title={"Kassadan berilgan pullar · " + formatUZS(movementsTotal)}
              />
              {!detail.canViewMovements ? (
                <EmptyText text="Bu ma’lumotni ko‘rish huquqi sizning rolingizga berilmagan." />
              ) : detail.movements.length === 0 ? (
                <EmptyText text="Bu smenada kassadan pul berilmagan." />
              ) : (
                <div className="space-y-2.5">
                  {detail.movements.map((movement) => (
                    <div key={movement.id} className="rounded-2xl border border-border p-3.5 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="font-medium break-words">{movement.reason || "Kassadan pul berildi"}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {EXPENSE_LABELS[movement.expense_category] || "Boshqa chiqim"}
                          {movement.recipient_name_snapshot ? " · Kimga: " + movement.recipient_name_snapshot : ""}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {dateTime(movement.created_at || movement.created_date)}
                          {movement.employee_name ? " · " + movement.employee_name : ""}
                        </p>
                      </div>
                      <p className="font-semibold text-amber-700 whitespace-nowrap">−{formatUZS(movement.amount)}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {(detail.refunds.length > 0 || Number(shift.refunds_total || 0) > 0) && (
              <section>
                <SectionTitle icon={RotateCcw} title={"Qaytarishlar · " + formatUZS(refundsTotal || shift.refunds_total)} />
                {detail.refunds.length === 0 ? (
                  <EmptyText text="Qaytarish summasi smenada saqlangan, lekin eski batafsil yozuv topilmadi." />
                ) : (
                  <div className="space-y-2.5">
                    {detail.refunds.map((refund) => (
                      <div key={refund.id} className="rounded-2xl border border-red-100 bg-red-50/60 p-3.5">
                        <div className="flex justify-between gap-3">
                          <div>
                            <p className="font-medium">{refund.sale_number || refund.refund_number || "Qaytarish"}</p>
                            <p className="text-xs text-muted-foreground mt-1">{refund.reason || "Sabab ko‘rsatilmagan"}</p>
                            <p className="text-xs text-muted-foreground mt-1">{dateTime(refund.created_at || refund.created_date)}</p>
                          </div>
                          <p className="font-semibold text-destructive whitespace-nowrap">−{formatUZS(refund.amount)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        <Button type="button" variant="outline" onClick={onClose} className="w-full min-h-11 rounded-xl">
          Yopish
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function StockSnapshotSection({ snapshots, recorded }) {
  const rows = snapshots || [];
  const openingTotal = rows.reduce((sum, row) => sum + Number(row.opening_quantity || 0), 0);
  const receivedTotal = rows.reduce((sum, row) => sum + Number(row.received_quantity || 0), 0);
  const remainingTotal = rows.reduce((sum, row) => sum + Number(row.expected_quantity || 0), 0);

  return (
    <section>
      <SectionTitle icon={PackageCheck} title={"Yopilishdagi tizim qoldig‘i · " + formatNum(rows.length) + " tur"} />

      {rows.length === 0 ? (
        <EmptyText
          text={recorded
            ? "Bu smena yopilganda do‘konda mahsulot qoldig‘i bo‘lmagan."
            : "Bu eski smena uchun yopilishdagi qoldiq saqlanmagan."}
        />
      ) : (
        <div className="space-y-3">
          <p className="rounded-xl bg-secondary/60 px-3 py-2.5 text-xs text-muted-foreground">
            Bu miqdorlar kassir tomonidan sanalmagan — tizim smena yopilgan paytda ularni avtomatik saqlagan.
          </p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Cell label="Smena boshida" value={formatNum(openingTotal)} bold />
            <Cell label="Transfer keldi" value={formatNum(receivedTotal)} bold />
            <Cell label="Yopilganda qoldi" value={formatNum(remainingTotal)} bold />
          </div>

          <div className="hidden sm:block rounded-2xl border border-border overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-secondary/70 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2.5">Mahsulot</th>
                  <th className="text-right font-medium px-2 py-2.5">Boshida</th>
                  <th className="text-right font-medium px-2 py-2.5">Keldi</th>
                  <th className="text-right font-medium px-2 py-2.5">Sotildi</th>
                  <th className="text-right font-medium px-2 py-2.5">Chiqit</th>
                  <th className="text-right font-medium px-3 py-2.5">Qoldi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id || row.product_id}>
                    <td className="px-3 py-3">
                      <p className="font-medium">{row.product_name_snapshot}</p>
                      {(Number(row.returned_quantity || 0) !== 0 || Number(row.other_change_quantity || 0) !== 0) && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          Qaytdi +{formatNum(row.returned_quantity)} · Boshqa {signedQuantity(row.other_change_quantity)}
                        </p>
                      )}
                    </td>
                    <td className="text-right px-2 py-3">{formatNum(row.opening_quantity)}</td>
                    <td className="text-right px-2 py-3 text-emerald-700">+{formatNum(row.received_quantity)}</td>
                    <td className="text-right px-2 py-3">{formatNum(row.sold_quantity)}</td>
                    <td className="text-right px-2 py-3 text-amber-700">{formatNum(row.waste_quantity)}</td>
                    <td className="text-right px-3 py-3 font-bold">{formatNum(row.expected_quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="sm:hidden space-y-2.5">
            {rows.map((row) => (
              <div key={row.id || row.product_id} className="rounded-2xl border border-border p-3.5">
                <div className="flex justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{row.product_name_snapshot}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Boshida {formatNum(row.opening_quantity)} · Keldi +{formatNum(row.received_quantity)}
                      <br />
                      Sotildi {formatNum(row.sold_quantity)} · Chiqit {formatNum(row.waste_quantity)}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground">Yopilganda qoldi</p>
                    <p className="font-bold">{formatNum(row.expected_quantity)} dona</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const signedQuantity = (value) => {
  const number = Number(value || 0);
  return (number > 0 ? "+" : "") + formatNum(number);
};

function SectionTitle({ icon: Icon, title }) {
  return (
    <h3 className="font-semibold mb-2.5 flex items-center gap-2">
      <span className="w-8 h-8 rounded-lg bg-primary/10 text-brand-ink flex items-center justify-center">
        <Icon className="w-4 h-4" />
      </span>
      {title}
    </h3>
  );
}

function SummaryCard({ label, value, warn, danger }) {
  const color = danger
    ? "bg-red-50 text-destructive"
    : warn
      ? "bg-amber-50 text-amber-800"
      : "bg-secondary/60";

  return (
    <div className={"rounded-xl p-3 " + color}>
      <p className="text-[11px] opacity-75">{label}</p>
      <p className="font-semibold mt-1">{value}</p>
    </div>
  );
}

function CashRow({ label, value, valueClass = "", bold }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm border-b border-border last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={(bold ? "font-bold " : "font-medium ") + valueClass}>{value}</span>
    </div>
  );
}

function EmptyText({ text }) {
  return (
    <div className="rounded-2xl border border-dashed border-border py-8 px-4 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function Cell({ label, value, bold }) {
  return (
    <div className="flex items-center justify-between bg-secondary/50 rounded-lg px-2.5 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? "font-semibold" : "font-medium"}>{value}</span>
    </div>
  );
}
