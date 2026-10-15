import React, { useEffect, useMemo, useState, useRef } from "react";
import OdinaSelect from "@/components/ui/odina-select";
import { orderRequestScope, readOrderRequest, retainOrderRequest, clearOrderRequest } from "@/lib/order-request-retry";
import {
  Ban,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Eye,
  PackagePlus,
  Plus,
  ReceiptText,
  Scale,
  Trash2,
  WalletCards,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { odinaAlert } from "@/lib/odina-dialog";
import { formatNum, formatUZS } from "@/lib/pos";
import { formatUzbekistanDateTime, uzbekistanDateKey, uzbekistanMonthStartKey } from "@/lib/uzbekistan-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const UNIT_LABELS = { kg: "kg", l: "litr", g: "g", ml: "ml", piece: "dona" };
const STATUS_LABELS = {
  unpaid: "To‘lanmagan",
  partial: "Qisman to‘langan",
  paid: "To‘langan",
  cancelling: "Bekor qilinmoqda",
  cancelled: "Bekor qilingan",
};
const STATUS_STYLES = {
  unpaid: "bg-amber-50 text-amber-700",
  partial: "bg-orange-50 text-orange-700",
  paid: "bg-emerald-50 text-emerald-700",
  cancelling: "bg-red-50 text-destructive",
  cancelled: "bg-red-50 text-destructive",
};

const errorText = (error) => (
  error?.response?.data?.error || error?.data?.error || error?.message || String(error || "Noma’lum xato")
);

const isCancelled = (receipt) => ["cancelled", "cancelling"].includes(receipt?.status);
const receiptPaid = (receipt) => {
  if (isCancelled(receipt)) return 0;
  return Math.max(
    0,
    Number(receipt?.paid_at_receipt || 0)
      + Number(receipt?.debt_amount || 0)
      - Number(receipt?.remaining_debt || 0),
  );
};

export default function SupplierLedgerPanel({
  modernView = false,
  user,
  location,
  ingredients,
  recipients,
  search = "",
}) {
  const [receipts, setReceipts] = useState([]);
  const [receiptItems, setReceiptItems] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState(uzbekistanMonthStartKey);
  const [dateTo, setDateTo] = useState(() => uzbekistanDateKey());
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [cancelTarget, setCancelTarget] = useState(null);
  const [budgetPaymentTarget, setBudgetPaymentTarget] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [receiptList, itemList, paymentList] = await Promise.all([
        base44.entities.SupplierReceipt.list("-received_at", 500),
        base44.entities.SupplierReceiptItem.list("-created_date", 500),
        base44.entities.SupplierPayment.list("-paid_at", 500),
      ]);
      setReceipts(receiptList || []);
      setReceiptItems(itemList || []);
      setPayments(paymentList || []);
    } catch (error) {
      void odinaAlert("Kirim va qarzlarni yuklab bo‘lmadi: " + errorText(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const locationReceipts = useMemo(() => (
    receipts.filter((receipt) => {
      if (user?.role !== "admin" && receipt.location_id !== location?.id) return false;
      if (user?.role === "admin" && location?.id && receipt.location_id !== location.id) return false;
      return true;
    })
  ), [receipts, user?.role, location?.id]);

  const supplierOptions = useMemo(() => {
    const names = new Map();
    for (const recipient of recipients) {
      if (["supplier", "company"].includes(recipient.recipient_type)) {
        names.set(recipient.id, recipient.name);
      }
    }
    for (const receipt of locationReceipts) {
      if (!names.has(receipt.supplier_id)) {
        names.set(receipt.supplier_id, receipt.supplier_name_snapshot || "Noma’lum yetkazib beruvchi");
      }
    }
    return Array.from(names, ([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "uz"));
  }, [recipients, locationReceipts]);

  const visible = useMemo(() => {
    const query = search.toLowerCase().trim();
    return locationReceipts.filter((receipt) => {
      const date = uzbekistanDateKey(receipt.received_at || receipt.created_date);
      if (supplierFilter !== "all" && receipt.supplier_id !== supplierFilter) return false;
      if (dateFrom && date < dateFrom) return false;
      if (dateTo && date > dateTo) return false;
      if (statusFilter === "debt" && (isCancelled(receipt) || Number(receipt.remaining_debt || 0) <= 0)) return false;
      if (statusFilter === "paid" && receipt.status !== "paid") return false;
      if (statusFilter === "cancelled" && !isCancelled(receipt)) return false;
      if (statusFilter === "active" && isCancelled(receipt)) return false;
      if (!query) return true;
      return [
        receipt.receipt_number,
        receipt.supplier_name_snapshot,
        receipt.location_name_snapshot,
        receipt.invoice_reference,
        receipt.notes,
        receipt.created_by_name,
      ].filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }, [locationReceipts, supplierFilter, statusFilter, dateFrom, dateTo, search]);

  const visibleReceiptIds = useMemo(() => new Set(visible.map((receipt) => receipt.id)), [visible]);
  const visiblePayments = useMemo(
    () => payments.filter((payment) => visibleReceiptIds.has(payment.receipt_id)),
    [payments, visibleReceiptIds],
  );

  const activeReceipts = visible.filter((receipt) => !isCancelled(receipt));
  const totalPurchases = activeReceipts.reduce((sum, receipt) => sum + Number(receipt.total_amount || 0), 0);
  const outstanding = activeReceipts.reduce((sum, receipt) => sum + Number(receipt.remaining_debt || 0), 0);
  const paidTotal = activeReceipts.reduce((sum, receipt) => sum + receiptPaid(receipt), 0);
  const cancelledTotal = visible
    .filter((receipt) => isCancelled(receipt))
    .reduce((sum, receipt) => sum + Number(receipt.total_amount || 0), 0);
  const canReceive = ["admin", "manager", "warehouse"].includes(user?.role);

  const supplierRows = useMemo(() => {
    const grouped = new Map();
    for (const receipt of visible) {
      const key = receipt.supplier_id;
      const row = grouped.get(key) || {
        id: key,
        name: receipt.supplier_name_snapshot || "Noma’lum yetkazib beruvchi",
        purchases: 0,
        paid: 0,
        debt: 0,
        cancelled: 0,
        receiptCount: 0,
      };
      row.receiptCount += 1;
      if (isCancelled(receipt)) {
        row.cancelled += Number(receipt.total_amount || 0);
      } else {
        row.purchases += Number(receipt.total_amount || 0);
        row.paid += receiptPaid(receipt);
        row.debt += Number(receipt.remaining_debt || 0);
      }
      grouped.set(key, row);
    }
    return Array.from(grouped.values()).sort((a, b) => b.debt - a.debt || b.purchases - a.purchases);
  }, [visible]);

  const selectedSupplier = useMemo(() => {
    if (!selectedSupplierId) return null;
    const supplierReceipts = locationReceipts.filter((receipt) => receipt.supplier_id === selectedSupplierId);
    if (!supplierReceipts.length) return null;
    const receiptIds = new Set(supplierReceipts.map((receipt) => receipt.id));
    return {
      id: selectedSupplierId,
      name: supplierReceipts[0].supplier_name_snapshot || "Yetkazib beruvchi",
      receipts: supplierReceipts,
      payments: payments.filter((payment) => receiptIds.has(payment.receipt_id)),
      items: receiptItems.filter((item) => receiptIds.has(item.receipt_id)),
    };
  }, [selectedSupplierId, locationReceipts, payments, receiptItems]);

  const showThisMonth = () => {
    setDateFrom(uzbekistanMonthStartKey());
    setDateTo(uzbekistanDateKey());
  };

  const showAll = () => {
    setDateFrom("");
    setDateTo("");
  };

  if (loading) {
    return (
      <div className="grid sm:grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-36 rounded-2xl bg-secondary animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="odina-panel rounded-2xl border border-border bg-card p-4 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex-1">
          <p className="font-semibold">Yetkazib beruvchilar kirimi va qarzi</p>
          <p className="text-sm text-muted-foreground mt-1">
            Kirim, to‘lov, qolgan qarz va bekor qilingan hujjatlar bitta joyda.
          </p>
        </div>
        {canReceive && (
          <Button
            onClick={() => setDialogOpen(true)}
            disabled={!location}
            className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong"
          >
            <PackagePlus className="w-4 h-4 mr-1.5" /> Yangi kirim
          </Button>
        )}
      </div>

      <div className="odina-panel rounded-2xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={showThisMonth} className="min-h-10 rounded-xl">
            Shu oy
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={showAll} className="min-h-10 rounded-xl">
            Barcha vaqt
          </Button>
          <span className="text-xs text-muted-foreground ml-auto">
            <CalendarDays className="w-3.5 h-3.5 inline mr-1" /> Kirim sanasi bo‘yicha
          </span>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Boshlanish sanasi</span>
            <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="h-11 rounded-xl" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Tugash sanasi</span>
            <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="h-11 rounded-xl" />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Yetkazib beruvchi</span>
            <OdinaSelect
              value={supplierFilter}
              onChange={(event) => setSupplierFilter(event.target.value)}
              className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm"
            >
              <option value="all">Barcha yetkazib beruvchilar</option>
              {supplierOptions.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
              ))}
            </OdinaSelect>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Holati</span>
            <OdinaSelect
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm"
            >
              <option value="all">Barcha holatlar</option>
              <option value="active">Faol kirimlar</option>
              <option value="debt">Qarzi bor</option>
              <option value="paid">To‘langan</option>
              <option value="cancelled">Bekor qilingan</option>
            </OdinaSelect>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Summary icon={ReceiptText} label="Jami faol kirim" value={formatUZS(totalPurchases)} />
        <Summary icon={CheckCircle2} label="To‘langan" value={formatUZS(paidTotal)} />
        <Summary icon={Scale} label="Qolgan qarz" value={formatUZS(outstanding)} warning={outstanding > 0} />
        <Summary icon={Ban} label="Bekor qilingan" value={formatUZS(cancelledTotal)} danger={cancelledTotal > 0} />
      </div>

      {supplierRows.length > 0 && (
        <section>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="font-semibold">Yetkazib beruvchilar</h3>
              <p className="text-xs text-muted-foreground">Ustiga bosib to‘liq kirim va to‘lov tarixini ko‘ring.</p>
            </div>
            <span className="text-xs text-muted-foreground">{formatNum(supplierRows.length)} ta</span>
          </div>

          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {supplierRows.map((supplier) => (
              <button
                key={supplier.id}
                type="button"
                onClick={() => setSelectedSupplierId(supplier.id)}
                className="odina-panel text-left rounded-2xl border border-border bg-card premium-shadow p-4 transition-all hover:-translate-y-0.5 hover:premium-shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{supplier.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">{formatNum(supplier.receiptCount)} ta kirim</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </div>
                <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                  <MiniCell label="Kirim" value={formatUZS(supplier.purchases)} />
                  <MiniCell label="To‘langan" value={formatUZS(supplier.paid)} />
                </div>
                <div className={"mt-2 rounded-xl px-3 py-2 " + (
                  supplier.debt > 0 ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700"
                )}>
                  <p className="text-[11px] opacity-75">Qolgan qarz</p>
                  <p className="font-semibold mt-0.5">{formatUZS(supplier.debt)}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="font-semibold">Kirim hujjatlari</h3>
            <p className="text-xs text-muted-foreground">Tanlangan sana, yetkazib beruvchi va holat bo‘yicha.</p>
          </div>
          <span className="text-xs text-muted-foreground">{formatNum(visible.length)} ta</span>
        </div>

        {visible.length === 0 ? (
          <div className="odina-panel rounded-2xl border border-border bg-card py-14 text-center">
            <ClipboardList className="w-9 h-9 mx-auto text-muted-foreground/40 mb-3" />
            <p className="font-medium">Kirim topilmadi</p>
            <p className="text-sm text-muted-foreground mt-1">Filtrlarni o‘zgartiring yoki yangi kirim yarating.</p>
          </div>
        ) : (
          modernView ? <div className="warehouse-table-wrap"><table className="warehouse-table"><caption className="sr-only">Kirim hujjatlari</caption><thead><tr><th scope="col">Hujjat / yetkazib beruvchi</th><th scope="col">Sana</th><th scope="col">Kirim summasi</th><th scope="col">Qolgan qarz</th><th scope="col">Holati</th><th scope="col">Amal</th></tr></thead><tbody>
            {visible.map((receipt) => <tr key={receipt.id}>
              <td data-label="Hujjat"><strong>{receipt.supplier_name_snapshot}</strong><span className="warehouse-cell-note">{receipt.receipt_number} · {receipt.location_name_snapshot}</span></td>
              <td data-label="Sana">{formatUzbekistanDateTime(receipt.received_at || receipt.created_date)}</td>
              <td data-label="Kirim summasi" className="warehouse-number">{formatUZS(receipt.total_amount)}</td>
              <td data-label="Qolgan qarz" className="warehouse-number">{formatUZS(Number(receipt.remaining_debt || 0))}</td>
              <td data-label="Holati"><span className={'warehouse-status ' + (STATUS_STYLES[receipt.status] || 'bg-secondary text-muted-foreground')}>{STATUS_LABELS[receipt.status] || receipt.status}</span></td>
              <td data-label="Amal"><Button type="button" variant="outline" onClick={() => setSelectedReceipt(receipt)} aria-label={receipt.receipt_number + ' — tafsilotlar'}>Tafsilotlar<ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" /></Button></td>
            </tr>)}
          </tbody></table></div> : <div className="space-y-3">
            {visible.map((receipt) => {
              const items = receiptItems.filter((item) => item.receipt_id === receipt.id);
              const receiptPayments = payments.filter((payment) => payment.receipt_id === receipt.id);
              return (
                <ReceiptCard
                  key={receipt.id}
                  receipt={receipt}
                  items={items}
                  payments={receiptPayments}
                  onView={() => setSelectedReceipt(receipt)}
                />
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="font-semibold">To‘lovlar tarixi</h3>
            <p className="text-xs text-muted-foreground">Qaysi do‘kon va kassir qarzni to‘lagani.</p>
          </div>
          <span className="text-xs text-muted-foreground">{formatNum(visiblePayments.length)} ta</span>
        </div>

        {visiblePayments.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 px-4 text-center text-sm text-muted-foreground">
            Tanlangan kirimlar bo‘yicha to‘lov topilmadi.
          </div>
        ) : (
          <div className="space-y-2.5">
            {visiblePayments.map((payment) => (
              <PaymentCard key={payment.id} payment={payment} />
            ))}
          </div>
        )}
      </section>

      <ReceiptDialog
        open={dialogOpen}
        location={location}
        ingredients={ingredients}
        recipients={recipients}
        onClose={() => setDialogOpen(false)}
        onSaved={() => { setDialogOpen(false); load(); }}
      />

      <ReceiptDetailDialog
        receipt={selectedReceipt}
        items={selectedReceipt ? receiptItems.filter((item) => item.receipt_id === selectedReceipt.id) : []}
        payments={selectedReceipt ? payments.filter((payment) => payment.receipt_id === selectedReceipt.id) : []}
        canCancel={canReceive}
        onCancel={(receipt) => { setSelectedReceipt(null); setCancelTarget(receipt); }}
        onClose={() => setSelectedReceipt(null)}
      />

      <SupplierDetailDialog
        supplier={selectedSupplier}
        canPayBudget={user?.role === "admin"}
        onPayBudget={(supplier) => { setSelectedSupplierId(""); setBudgetPaymentTarget(supplier); }}
        onReceipt={(receipt) => { setSelectedSupplierId(""); setSelectedReceipt(receipt); }}
        onClose={() => setSelectedSupplierId("")}
      />

      <BudgetSupplierPaymentDialog
        actorId={user?.id}
        supplier={budgetPaymentTarget}
        onClose={() => setBudgetPaymentTarget(null)}
        onPaid={() => { setBudgetPaymentTarget(null); load(); }}
      />

      <CancelReceiptDialog
        receipt={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onCancelled={() => { setCancelTarget(null); load(); }}
      />
    </div>
  );
}

function ReceiptCard({ receipt, items, payments, onView }) {
  const debt = Number(receipt.remaining_debt || 0);
  const cancelled = isCancelled(receipt);

  return (
    <div className={"odina-panel rounded-2xl border bg-card premium-shadow p-4 sm:p-5 " + (
      cancelled ? "border-red-200 opacity-80" : "border-border"
    )}>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className={"font-semibold " + (cancelled ? "line-through text-muted-foreground" : "")}>
              {receipt.supplier_name_snapshot}
            </p>
            <span className={"rounded-full px-2.5 py-1 text-xs font-medium " + (
              STATUS_STYLES[receipt.status] || "bg-secondary text-muted-foreground"
            )}>
              {STATUS_LABELS[receipt.status] || receipt.status}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {receipt.receipt_number} · {receipt.location_name_snapshot} · {formatUzbekistanDateTime(
              receipt.received_at || receipt.created_date,
            )}
          </p>
          {items.length > 0 && (
            <p className="text-sm mt-3 line-clamp-2">
              {items.map((item) => (
                item.ingredient_name_snapshot + ": " + formatNum(item.purchase_quantity) + " "
                  + (UNIT_LABELS[item.purchase_unit] || item.purchase_unit)
              )).join(" · ")}
            </p>
          )}
          {payments.length > 0 && (
            <p className="text-xs text-emerald-700 mt-2">
              {formatNum(payments.length)} ta to‘lov · {formatUZS(
                payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
              )}
            </p>
          )}
          {receipt.cancellation_reason && (
            <p className="text-xs text-destructive mt-2">
              Bekor qilish sababi: {receipt.cancellation_reason}
            </p>
          )}
        </div>

        <div className="sm:text-right shrink-0">
          <p className="text-xs text-muted-foreground">Kirim summasi</p>
          <p className={"font-semibold " + (cancelled ? "line-through text-muted-foreground" : "")}>
            {formatUZS(receipt.total_amount)}
          </p>
          <p className="text-xs text-muted-foreground mt-2">Qolgan qarz</p>
          <p className={"text-lg font-semibold " + (
            debt > 0 && !cancelled ? "text-amber-700" : cancelled ? "text-muted-foreground" : "text-emerald-700"
          )}>
            {formatUZS(debt)}
          </p>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-border flex justify-end">
        <Button type="button" variant="outline" onClick={onView} className="min-h-10 rounded-xl">
          <Eye className="w-4 h-4 mr-1.5" /> Batafsil
        </Button>
      </div>
    </div>
  );
}

function PaymentCard({ payment }) {
  return (
    <div className="odina-panel rounded-2xl border border-border bg-card p-3.5 sm:p-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="font-medium">{payment.supplier_name_snapshot}</p>
        <p className="text-xs text-muted-foreground mt-1">
          {payment.payment_number} · {payment.receipt_number_snapshot}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {payment.shop_name_snapshot} · {payment.user_name} · {formatUzbekistanDateTime(
            payment.paid_at || payment.created_date,
          )}
        </p>
        {payment.notes && <p className="text-xs mt-1.5">{payment.notes}</p>}
      </div>
      <p className="font-semibold text-emerald-700 whitespace-nowrap">{formatUZS(payment.amount)}</p>
    </div>
  );
}

function ReceiptDetailDialog({ receipt, items, payments, canCancel, onCancel, onClose }) {
  if (!receipt) return null;
  const cancelled = isCancelled(receipt);
  const hasPayment = payments.length > 0
    || Number(receipt.paid_at_receipt || 0) > 0
    || Number(receipt.remaining_debt || 0) !== Number(receipt.debt_amount || 0);
  const cancellable = canCancel && receipt.status === "unpaid" && !hasPayment;

  return (
    <Dialog open={!!receipt} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="warehouse-dialog sm:max-w-2xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Kirim tafsilotlari</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {receipt.receipt_number} · {receipt.supplier_name_snapshot}
          </p>
        </DialogHeader>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <MiniSummary label="Jami" value={formatUZS(receipt.total_amount)} />
          <MiniSummary label="To‘langan" value={formatUZS(receiptPaid(receipt))} />
          <MiniSummary label="Qolgan qarz" value={formatUZS(receipt.remaining_debt)} warning />
          <MiniSummary label="Holati" value={STATUS_LABELS[receipt.status] || receipt.status} />
        </div>

        <div className="rounded-2xl border border-border divide-y divide-border overflow-hidden">
          <DetailRow label="Ombor" value={receipt.location_name_snapshot} />
          <DetailRow label="Kirim sanasi" value={formatUzbekistanDateTime(receipt.received_at || receipt.created_date)} />
          <DetailRow label="Kirim qilgan xodim" value={receipt.created_by_name || "—"} />
          <DetailRow label="Hisob-faktura" value={receipt.invoice_reference || "—"} />
          <DetailRow label="Izoh" value={receipt.notes || "—"} />
        </div>

        <div>
          <h4 className="font-semibold mb-2">Masalliqlar va narxlar</h4>
          <div className="rounded-2xl border border-border divide-y divide-border overflow-hidden">
            {items.map((item) => (
              <div key={item.id} className="p-3.5 flex items-start justify-between gap-3 text-sm">
                <div>
                  <p className="font-medium">{item.ingredient_name_snapshot}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatNum(item.purchase_quantity)} {UNIT_LABELS[item.purchase_unit] || item.purchase_unit}
                    {" × "}{formatUZS(item.unit_price)}
                  </p>
                </div>
                <p className="font-semibold whitespace-nowrap">{formatUZS(item.line_total)}</p>
              </div>
            ))}
            {items.length === 0 && <p className="p-4 text-sm text-muted-foreground">Tarkib topilmadi.</p>}
          </div>
        </div>

        <div>
          <h4 className="font-semibold mb-2">Shu kirimga qilingan to‘lovlar</h4>
          {payments.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border py-7 text-center text-sm text-muted-foreground">
              Hali to‘lov qilinmagan.
            </div>
          ) : (
            <div className="space-y-2">
              {payments.map((payment) => <PaymentCard key={payment.id} payment={payment} />)}
            </div>
          )}
        </div>

        {cancelled && (
          <div className="rounded-2xl bg-red-50 border border-red-200 p-4 text-sm text-destructive">
            <p className="font-semibold">Kirim bekor qilingan</p>
            <p className="mt-1">{receipt.cancellation_reason || "Sabab ko‘rsatilmagan"}</p>
            {receipt.cancelled_by_name && (
              <p className="text-xs mt-1.5">
                {receipt.cancelled_by_name} · {receipt.cancelled_at ? formatUzbekistanDateTime(receipt.cancelled_at) : ""}
              </p>
            )}
          </div>
        )}

        {!cancelled && hasPayment && canCancel && (
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
            Bu kirim bo‘yicha pul to‘langan. Kassa va qarz tarixini saqlash uchun avtomatik bekor qilish yopilgan.
          </div>
        )}

        <DialogFooter>
          {cancellable && (
            <Button type="button" variant="destructive" onClick={() => onCancel(receipt)}>
              <Ban className="w-4 h-4 mr-1.5" /> Kirimni bekor qilish
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>Yopish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SupplierDetailDialog({ supplier, canPayBudget, onPayBudget, onReceipt, onClose }) {
  if (!supplier) return null;
  const active = supplier.receipts.filter((receipt) => !isCancelled(receipt));
  const purchases = active.reduce((sum, receipt) => sum + Number(receipt.total_amount || 0), 0);
  const paid = active.reduce((sum, receipt) => sum + receiptPaid(receipt), 0);
  const debt = active.reduce((sum, receipt) => sum + Number(receipt.remaining_debt || 0), 0);

  return (
    <Dialog open={!!supplier} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="warehouse-dialog sm:max-w-3xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{supplier.name}</DialogTitle>
          <p className="text-sm text-muted-foreground">Yetkazib beruvchining to‘liq tarixi</p>
        </DialogHeader>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <MiniSummary label="Jami kirim" value={formatUZS(purchases)} />
          <MiniSummary label="To‘langan" value={formatUZS(paid)} />
          <MiniSummary label="Qolgan qarz" value={formatUZS(debt)} warning={debt > 0} />
          <MiniSummary label="Kirimlar" value={formatNum(supplier.receipts.length)} />
        </div>

        {canPayBudget && debt > 0 && (
          <Button
            type="button"
            onClick={() => onPayBudget(supplier)}
            className="w-full min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong"
          >
            <WalletCards className="w-4 h-4 mr-1.5" /> Budgetdan qarzni to‘lash
          </Button>
        )}

        <div>
          <h4 className="font-semibold mb-2">Barcha kirimlar</h4>
          <div className="space-y-2">
            {supplier.receipts.map((receipt) => (
              <button
                key={receipt.id}
                type="button"
                onClick={() => onReceipt(receipt)}
                className="w-full text-left rounded-2xl border border-border p-3.5 flex items-center justify-between gap-3 hover:bg-secondary/40 transition-colors"
              >
                <div className="min-w-0">
                  <p className={"font-medium " + (isCancelled(receipt) ? "line-through text-muted-foreground" : "")}>
                    {receipt.receipt_number}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatUzbekistanDateTime(receipt.received_at || receipt.created_date)}
                    {" · "}{STATUS_LABELS[receipt.status] || receipt.status}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-semibold">{formatUZS(receipt.total_amount)}</p>
                  <p className="text-xs text-amber-700 mt-1">Qarz: {formatUZS(receipt.remaining_debt)}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <h4 className="font-semibold mb-2">Barcha to‘lovlar</h4>
          {supplier.payments.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border py-7 text-center text-sm text-muted-foreground">
              Hali to‘lov qilinmagan.
            </div>
          ) : (
            <div className="space-y-2">
              {supplier.payments.map((payment) => <PaymentCard key={payment.id} payment={payment} />)}
            </div>
          )}
        </div>

        <Button type="button" variant="outline" onClick={onClose}>Yopish</Button>
      </DialogContent>
    </Dialog>
  );
}

function BudgetSupplierPaymentDialog({ actorId, supplier, onClose, onPaid }) {
  const [balances, setBalances] = useState({});
  const [account, setAccount] = useState("cash");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [ownerPin, setOwnerPin] = useState("");
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestScope = orderRequestScope(actorId, "pay_supplier");
  const [retryPending, setRetryPending] = useState(() => Boolean(readOrderRequest(requestScope)));
  const requestRef = useRef(readOrderRequest(requestScope));
  const pendingSupplierRef = useRef(requestRef.current?._supplier_label || null);
  const pendingSupplierChanged = retryPending && requestRef.current?.supplier_id !== supplier?.id;

  const debt = supplier
    ? supplier.receipts
      .filter((receipt) => !isCancelled(receipt))
      .reduce((sum, receipt) => sum + Number(receipt.remaining_debt || 0), 0)
    : 0;
  const value = Math.round(Number(amount) || 0);
  const available = Number(balances[account] || 0);
  const invalidAmount = value <= 0 || value > debt || value > available;

  useEffect(() => {
    if (!supplier) return undefined;
    const saved = readOrderRequest(requestScope);
    requestRef.current = saved;
    pendingSupplierRef.current = saved?._supplier_label || null;
    setRetryPending(Boolean(saved));
    let active = true;
    setAccount(saved?.account || "cash");
    setAmount(saved ? String(saved.amount) : String(debt));
    setNotes(saved?.notes || "");
    setOwnerPin("");
    setLoadingBalances(true);
    base44.functions.invoke("budget-ledger", { action: "summary" })
      .then((result) => {
        if (!active) return;
        const payload = result?.data || result;
        if (!payload?.balances) throw new Error(payload?.error || "Budget balansi yuklanmadi.");
        setBalances(Object.fromEntries(
          payload.balances.map((row) => [row.account, Number(row.balance || 0)]),
        ));
      })
      .catch((error) => {
        if (active) void odinaAlert("Budget balansi yuklanmadi: " + errorText(error));
      })
      .finally(() => {
        if (active) setLoadingBalances(false);
      });
    return () => { active = false; };
  }, [supplier, debt, requestScope]);

  const submit = async () => {
    if (pendingSupplierChanged) return;
    if (!supplier || !/^\d{4,8}$/.test(ownerPin) || (!retryPending && invalidAmount)) return;
    if (saving) return;
    const hadPending = retryPending;
    setSaving(true);
    try {
      requestRef.current = retainOrderRequest(requestScope, requestRef.current || {
        action: "pay_supplier", supplier_id: supplier.id, account, amount: value,
        notes: notes.trim(), idempotency_key: crypto.randomUUID(), _supplier_label: supplier.name,
      });
      pendingSupplierRef.current = requestRef.current._supplier_label;
      setRetryPending(true);
      const { _supplier_label: _label, ...submitted } = requestRef.current;
      const result = await base44.functions.invoke("budget-ledger", { ...submitted, owner_pin: ownerPin });
      const payload = result?.data || result;
      if (!payload?.paid) throw Object.assign(new Error(payload?.error || "Qarz to‘lovi bajarilmadi."), { data: payload });
      clearOrderRequest(requestScope);
      requestRef.current = null;
      pendingSupplierRef.current = null;
      setRetryPending(false);
      onPaid();
    } catch (error) {
      const failure = error?.response?.data || error?.data || {};
      const status = Number(error?.response?.status || error?.status || 0);
      if (failure.operation_reversed || (!hadPending && status >= 400 && status < 500 && !failure.operation_pending)) {
        clearOrderRequest(requestScope);
        requestRef.current = null;
        pendingSupplierRef.current = null;
        setRetryPending(false);
      }
      void odinaAlert("Qarz to‘lanmadi: " + errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!supplier} onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="warehouse-dialog sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Budgetdan qarzni to‘lash</DialogTitle>
          <p className="text-sm text-muted-foreground">{supplier?.name} · Qarz {formatUZS(debt)}</p>
        </DialogHeader>

        <div className="rounded-xl bg-primary/5 border border-primary/20 p-3 text-xs text-muted-foreground">
          To‘lov eng eski kirim qarzidan boshlab avtomatik taqsimlanadi. Amal qilgan admin va pul hisobi tarixda saqlanadi.
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">Qaysi Budget hisobidan</Label>
          <OdinaSelect
            value={account}
            onChange={(event) => setAccount(event.target.value)}
            disabled={saving || loadingBalances || retryPending}
            className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm"
          >
            <option value="cash">Naqd pul · {formatUZS(balances.cash || 0)}</option>
            <option value="uzcard">Bank card · {formatUZS(balances.uzcard || 0)}</option>
            <option value="humo">Humo · {formatUZS(balances.humo || 0)}</option>
            <option value="online">Online · {formatUZS(balances.online || 0)}</option>
            <option value="bank">Bank · {formatUZS(balances.bank || 0)}</option>
          </OdinaSelect>
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">To‘lov summasi</Label>
          <Input
            type="number"
            min="1"
            max={Math.min(debt, available)}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0"
            disabled={saving || loadingBalances || retryPending}
            className="h-11 rounded-xl"
          />
          {value > debt && <p className="text-xs text-destructive mt-1">To‘lov qolgan qarzdan oshmasligi kerak.</p>}
          {value > available && <p className="text-xs text-destructive mt-1">Tanlangan Budget hisobida pul yetarli emas.</p>}
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Masalan: sentabr kirimlari uchun"
            rows={2}
            disabled={saving || retryPending}
          />
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">Owner PIN</Label>
          <Input
            type="password"
            inputMode="numeric"
            maxLength={8}
            value={ownerPin}
            onChange={(event) => setOwnerPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
            placeholder="4–8 xonali PIN"
            disabled={saving}
            className="h-11 rounded-xl"
          />
        </div>

        {retryPending && <p className="text-xs text-muted-foreground">Avvalgi {pendingSupplierRef.current} to‘lovi saqlandi. {pendingSupplierChanged ? "Natijani tekshirish uchun shu yetkazib beruvchining oynasini oching." : "Qayta tekshirish aynan shu summa va izoh bilan amalga oshadi."}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>{retryPending ? "Yopish" : "Bekor qilish"}</Button>
          <Button
            type="button"
            onClick={submit}
            disabled={saving || loadingBalances || pendingSupplierChanged || (!retryPending && invalidAmount) || !/^\d{4,8}$/.test(ownerPin)}
            className="bg-primary text-primary-foreground hover:bg-primary-strong"
          >
            {saving ? "To‘lanmoqda…" : retryPending ? "Avvalgi to‘lovni tekshirish" : "Owner PIN bilan to‘lash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelReceiptDialog({ receipt, onClose, onCancelled }) {
  const [reason, setReason] = useState("");
  const [ownerPin, setOwnerPin] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (receipt) {
      setReason("");
      setOwnerPin("");
    }
  }, [receipt]);

  const submit = async () => {
    if (!receipt || reason.trim().length < 3 || !/^\d{4,8}$/.test(ownerPin)) return;
    setSaving(true);
    try {
      const result = await base44.functions.invoke("supplier-ledger", {
        action: "cancel_receipt",
        receipt_id: receipt.id,
        reason: reason.trim(),
        owner_pin: ownerPin,
      });
      const payload = result?.data || result;
      if (!payload?.receipt || payload.receipt.status !== "cancelled") {
        throw new Error(payload?.error || "Kirimni bekor qilib bo‘lmadi.");
      }
      onCancelled();
    } catch (error) {
      void odinaAlert("Kirim bekor qilinmadi: " + errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!receipt} onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="warehouse-dialog sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Kirimni bekor qilish</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {receipt?.receipt_number} · {receipt?.supplier_name_snapshot}
          </p>
        </DialogHeader>

        <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-destructive">
          Bu amal qarzni bekor qiladi va kirimdagi masalliqlarni ombor qoldig‘idan ayiradi. Yozuv tarixdan o‘chmaydi.
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">Bekor qilish sababi</Label>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Masalan: miqdor noto‘g‘ri kiritilgan"
            rows={3}
            disabled={saving}
          />
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">Owner PIN</Label>
          <Input
            type="password"
            inputMode="numeric"
            maxLength={8}
            value={ownerPin}
            onChange={(event) => setOwnerPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
            placeholder="4–8 xonali PIN"
            disabled={saving}
            className="h-11 rounded-xl"
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Ortga</Button>
          <Button
            type="button"
            variant="destructive"
            onClick={submit}
            disabled={saving || reason.trim().length < 3 || !/^\d{4,8}$/.test(ownerPin)}
          >
            {saving ? "Bekor qilinmoqda…" : "Tasdiqlab bekor qilish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Summary({ icon: Icon, label, value, warning, danger }) {
  return (
    <div className={"odina-panel rounded-2xl border bg-card p-4 " + (danger ? "border-red-200" : "border-border")}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="w-4 h-4" />{label}
      </div>
      <p className={"text-lg sm:text-xl font-semibold mt-2 " + (
        danger ? "text-destructive" : warning ? "text-amber-700" : ""
      )}>{value}</p>
    </div>
  );
}

function MiniCell({ label, value }) {
  return (
    <div className="rounded-lg bg-secondary/60 px-2.5 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="font-medium mt-0.5">{value}</p>
    </div>
  );
}

function MiniSummary({ label, value, warning }) {
  return (
    <div className={"rounded-xl p-3 " + (warning ? "bg-amber-50 text-amber-800" : "bg-secondary/60")}>
      <p className="text-[11px] opacity-75">{label}</p>
      <p className="font-semibold mt-1">{value}</p>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3.5 py-2.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right break-words">{value}</span>
    </div>
  );
}

function ReceiptDialog({ open, location, ingredients, recipients, onClose, onSaved }) {
  const [supplierId, setSupplierId] = useState("");
  const [invoiceReference, setInvoiceReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ ingredient_id: "", purchase_quantity: "", unit_price: "" }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSupplierId("");
      setInvoiceReference("");
      setNotes("");
      setLines([{ ingredient_id: "", purchase_quantity: "", unit_price: "" }]);
    }
  }, [open]);

  const supplierList = recipients.filter(
    (recipient) => recipient.active !== false && ["supplier", "company"].includes(recipient.recipient_type),
  );
  const lineTotal = (line) => Number(line.purchase_quantity || 0) * Number(line.unit_price || 0);
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const valid = supplierId && location?.id && lines.length > 0 && lines.every((line) =>
    line.ingredient_id && Number(line.purchase_quantity) > 0 && Number(line.unit_price) >= 0
  ) && total > 0 && new Set(lines.map((line) => line.ingredient_id)).size === lines.length;

  const updateLine = (index, key, value) => {
    setLines((current) => current.map(
      (line, lineIndex) => lineIndex === index ? { ...line, [key]: value } : line,
    ));
  };

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const result = await base44.functions.invoke("supplier-ledger", {
        action: "create_receipt",
        supplier_id: supplierId,
        location_id: location.id,
        invoice_reference: invoiceReference.trim() || undefined,
        notes: notes.trim() || undefined,
        items: lines.map((line) => ({
          ingredient_id: line.ingredient_id,
          purchase_quantity: Number(line.purchase_quantity),
          unit_price: Number(line.unit_price),
        })),
      });
      const payload = result?.data || result;
      if (!payload?.receipt) throw new Error(payload?.error || "Kirimni saqlab bo‘lmadi.");
      onSaved();
    } catch (error) {
      void odinaAlert("Kirim amalga oshmadi: " + errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="warehouse-dialog warehouse-receipt-drawer sm:max-w-2xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Yetkazib beruvchidan yangi kirim</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {location?.name} · jami summa avtomatik qarzga yoziladi
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs mb-1.5 block">Yetkazib beruvchi</Label>
              <OdinaSelect
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
                className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm"
              >
                <option value="">Ro‘yxatdan tanlang</option>
                {supplierList.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
              </OdinaSelect>
              {supplierList.length === 0 && (
                <p className="text-xs text-amber-700 mt-1.5">
                  Owner avval Kassa → Qabul qiluvchilar bo‘limida yetkazib beruvchi yaratishi kerak.
                </p>
              )}
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Hisob-faktura raqami (ixtiyoriy)</Label>
              <Input
                value={invoiceReference}
                onChange={(event) => setInvoiceReference(event.target.value)}
                placeholder="Masalan: 154-A"
                className="h-11 rounded-xl"
              />
            </div>
          </div>

          <div className="space-y-3">
            {lines.map((line, index) => {
              const ingredient = ingredients.find((item) => item.id === line.ingredient_id);
              return (
                <div key={index} className="rounded-2xl border border-border bg-secondary/30 p-3">
                  <div className="warehouse-receipt-line grid sm:grid-cols-[1fr_130px_160px_auto] gap-2 items-end">
                    <div>
                      <Label className="text-xs mb-1.5 block">Masalliq yoki qadoq</Label>
                      <OdinaSelect
                        value={line.ingredient_id}
                        onChange={(event) => updateLine(index, "ingredient_id", event.target.value)}
                        className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm"
                      >
                        <option value="">Tanlang</option>
                        {ingredients.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </OdinaSelect>
                    </div>
                    <div>
                      <Label className="text-xs mb-1.5 block">
                        Miqdor ({UNIT_LABELS[ingredient?.purchase_unit] || "birlik"})
                      </Label>
                      <Input
                        type="number"
                        min="0.001"
                        step="0.001"
                        value={line.purchase_quantity}
                        onChange={(event) => updateLine(index, "purchase_quantity", event.target.value)}
                        placeholder="0"
                        className="h-11 rounded-xl"
                      />
                    </div>
                    <div>
                      <Label className="text-xs mb-1.5 block">1 birlik narxi</Label>
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={line.unit_price}
                        onChange={(event) => updateLine(index, "unit_price", event.target.value)}
                        placeholder="0 UZS"
                        className="h-11 rounded-xl"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={lines.length === 1}
                      onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}
                      className="h-11 w-11 text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 text-right">
                    Qator jami: <span className="font-medium text-foreground">{formatUZS(lineTotal(line))}</span>
                  </p>
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              onClick={() => setLines((current) => [
                ...current,
                { ingredient_id: "", purchase_quantity: "", unit_price: "" },
              ])}
              className="min-h-11 rounded-xl"
            >
              <Plus className="w-4 h-4 mr-1.5" /> Yana masalliq
            </Button>
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Yetkazib berish haqida izoh"
              rows={2}
            />
          </div>

          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-amber-800">Avtomatik yaratiladigan qarz</p>
              <p className="text-xs text-amber-700 mt-1">
                To‘lov keyin istalgan do‘kon kassasidan owner PIN bilan qilinadi.
              </p>
            </div>
            <p className="text-xl font-semibold text-amber-800 whitespace-nowrap">{formatUZS(total)}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button
            onClick={save}
            disabled={saving || !valid}
            className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong"
          >
            {saving ? "Saqlanmoqda…" : "Kirim va qarzni yaratish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}