import React, { useEffect, useMemo, useState } from "react";
import { Navigate, useOutletContext } from "react-router-dom";
import {
  Activity,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CreditCard,
  Download,
  FileSpreadsheet,
  RefreshCw,
  ReceiptText,
  Search,
  ShieldCheck,
  Store,
  UserRound,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { odinaAlert } from "@/lib/odina-dialog";
import { formatNum, formatUZS } from "@/lib/pos";
import {
  AUDIT_CATEGORY_OPTIONS,
  AUDIT_CATEGORY_STYLES,
  AUDIT_ROLE_LABELS,
  auditRequestFilters,
  auditSourceLabel,
  auditStatusLabel,
  defaultAuditFilters,
  downloadAuditCsv,
  formatAuditDateTime,
} from "@/lib/audit-export";

const PAGE_SIZE = 50;

const CATEGORY_ICONS = {
  sale: ReceiptText,
  payment: CreditCard,
  shift: Clock3,
  stock: Boxes,
  action: Activity,
};

function payloadFrom(response) {
  return response?.data || response || {};
}

function errorMessage(error) {
  return error?.response?.data?.error
    || error?.data?.error
    || error?.message
    || "Nazorat ma’lumotlarini yuklab bo‘lmadi.";
}

function quantityText(row) {
  if (row.quantity == null) return "";
  const value = Number(row.quantity || 0);
  const sign = value > 0 ? "+" : "";
  return sign + value.toLocaleString("uz-UZ", { maximumFractionDigits: 3 }) + (row.unit ? " " + row.unit : "");
}

export default function AuditExport() {
  const { user } = useOutletContext();
  const [draft, setDraft] = useState(() => defaultAuditFilters());
  const [applied, setApplied] = useState(() => defaultAuditFilters());
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState({
    rows: [],
    total: 0,
    summary: {},
    users: [],
    shops: [],
    source_cap_reached: false,
  });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await base44.functions.invoke("audit-report", {
          action: "list",
          ...auditRequestFilters(applied),
          offset: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        const payload = payloadFrom(response);
        if (!Array.isArray(payload.rows)) {
          throw new Error(payload.error || "Nazorat ma’lumotlari noto‘g‘ri qaytdi.");
        }
        if (!cancelled) setData(payload);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [applied, page, reloadKey]);

  const totalPages = Math.max(1, Math.ceil(Number(data.total || 0) / PAGE_SIZE));
  const rangeStart = data.total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const rangeEnd = Math.min(page * PAGE_SIZE, Number(data.total || 0));
  const users = useMemo(
    () => [...(data.users || [])].sort((left, right) => left.name.localeCompare(right.name, "uz")),
    [data.users],
  );
  const shops = useMemo(
    () => [...(data.shops || [])].sort((left, right) => left.name.localeCompare(right.name, "uz")),
    [data.shops],
  );

  const changeDraft = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const applyFilters = (event) => {
    event.preventDefault();
    if (draft.date_from && draft.date_to && draft.date_from > draft.date_to) {
      void odinaAlert("Boshlanish sanasi tugash sanasidan keyin bo‘lmasligi kerak.");
      return;
    }
    setPage(1);
    setApplied({ ...draft, query: String(draft.query || "").trim() });
  };

  const resetFilters = () => {
    const next = defaultAuditFilters();
    setDraft(next);
    setPage(1);
    setApplied(next);
  };

  const exportRows = async () => {
    setExporting(true);
    try {
      const response = await base44.functions.invoke("audit-report", {
        action: "export",
        ...auditRequestFilters(applied),
        limit: 5000,
      });
      const payload = payloadFrom(response);
      if (!Array.isArray(payload.rows)) {
        throw new Error(payload.error || "Eksport ma’lumotlari qaytmadi.");
      }
      if (payload.rows.length === 0) {
        await odinaAlert("Eksport qilish uchun yozuv topilmadi.");
        return;
      }
      const filename = downloadAuditCsv(payload.rows, applied.date_from, applied.date_to);
      if (payload.truncated || payload.source_cap_reached) {
        await odinaAlert({
          title: "Eksport tayyor",
          description: filename + " yuklandi. Yozuvlar juda ko‘p bo‘lgani uchun aniqroq sana oralig‘ini tanlab qayta eksport qilish tavsiya etiladi.",
          tone: "warning",
        });
      }
    } catch (exportError) {
      void odinaAlert("Eksport xatosi: " + errorMessage(exportError));
    } finally {
      setExporting(false);
    }
  };

  if (user?.role !== "admin") return <Navigate to="/" replace />;

  const summary = data.summary || {};

  return (
    <div className="odina-page p-4 sm:p-6 lg:p-8 max-w-[1500px] mx-auto animate-fade-in">
      <PageHeader
        title="Nazorat va eksport"
        subtitle={formatNum(data.total || 0) + " ta yozuv · faqat Egasi / Admin"}
        icon={ShieldCheck}
        actions={(
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setReloadKey((value) => value + 1)}
              disabled={loading}
              className="min-h-11 rounded-xl"
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              <span className="hidden sm:inline">Yangilash</span>
            </Button>
            <Button
              type="button"
              onClick={exportRows}
              disabled={exporting || loading || !data.total}
              className="min-h-11 rounded-xl"
            >
              {exporting ? <RefreshCw className="animate-spin" /> : <FileSpreadsheet />}
              <span>{exporting ? "Tayyorlanmoqda…" : "Excel uchun CSV"}</span>
            </Button>
          </div>
        )}
      />

      <section aria-label="Qisqa xulosa" className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <SummaryCard
          icon={ReceiptText}
          label="Savdolar"
          value={formatUZS(summary.sales_total)}
          note={formatNum(summary.sale_count) + " ta yozuv"}
        />
        <SummaryCard
          icon={CreditCard}
          label="To‘lovlar"
          value={formatUZS(summary.payments_total)}
          note={formatNum(summary.payment_count) + " ta to‘lov"}
        />
        <SummaryCard
          icon={Download}
          label="Qaytarilgan"
          value={formatUZS(summary.refund_total)}
          note={"Kassa chiqimi: " + formatUZS(summary.cash_out_total)}
          danger={Number(summary.refund_total || 0) > 0}
        />
        <SummaryCard
          icon={Boxes}
          label="Ombor"
          value={formatNum(summary.stock_events) + " ta"}
          note="Qoldiq harakatlari"
        />
        <SummaryCard
          icon={Clock3}
          label="Smenalar"
          value={formatNum(summary.shift_events) + " ta"}
          note={formatNum(summary.action_events) + " ta jurnal amali"}
        />
      </section>

      <form
        onSubmit={applyFilters}
        className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-3 sm:p-4 mb-5"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-3">
          <FilterField label="Boshlanish sanasi">
            <Input
              type="date"
              value={draft.date_from}
              onChange={(event) => changeDraft("date_from", event.target.value)}
              className="h-11 rounded-xl"
            />
          </FilterField>
          <FilterField label="Tugash sanasi">
            <Input
              type="date"
              value={draft.date_to}
              onChange={(event) => changeDraft("date_to", event.target.value)}
              className="h-11 rounded-xl"
            />
          </FilterField>
          <FilterField label="Bo‘lim">
            <Select value={draft.category} onValueChange={(value) => changeDraft("category", value)}>
              <SelectTrigger className="h-11 rounded-xl bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIT_CATEGORY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField label="Xodim">
            <Select value={draft.user_id} onValueChange={(value) => changeDraft("user_id", value)}>
              <SelectTrigger className="h-11 rounded-xl bg-card">
                <SelectValue placeholder="Barcha xodimlar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Barcha xodimlar</SelectItem>
                {users.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name + " · " + (AUDIT_ROLE_LABELS[item.role] || item.role || "Xodim")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField label="Do‘kon / joy">
            <Select value={draft.shop_id} onValueChange={(value) => changeDraft("shop_id", value)}>
              <SelectTrigger className="h-11 rounded-xl bg-card">
                <SelectValue placeholder="Barcha joylar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Barcha joylar</SelectItem>
                {shops.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name + (item.active ? "" : " · faol emas")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField label="Qidirish">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={draft.query}
                onChange={(event) => changeDraft("query", event.target.value)}
                placeholder="Amal, hujjat…"
                maxLength={120}
                className="h-11 rounded-xl pl-9"
              />
            </div>
          </FilterField>
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-3">
          <Button type="button" variant="ghost" onClick={resetFilters} className="min-h-11 rounded-xl">
            Tozalash
          </Button>
          <Button type="submit" disabled={loading} className="min-h-11 rounded-xl px-6">
            <Search />
            Filtrlash
          </Button>
        </div>
      </form>

      {data.source_cap_reached && !loading && (
        <div className="mb-4 rounded-2xl border border-[#D0B17F]/45 bg-[#FECD7C]/15 px-4 py-3 text-sm text-amber-950">
          Yozuvlar ko‘p. To‘liq va tez natija uchun sana oralig‘ini toraytiring.
        </div>
      )}

      <section className="odina-panel rounded-2xl bg-card border border-border premium-shadow overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <div>
            <h2 className="font-display text-lg font-bold">Amallar tarixi</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {rangeStart + "–" + rangeEnd + " / " + formatNum(data.total || 0)}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">Vaqt: Asia/Tashkent</p>
        </div>

        {loading ? (
          <LoadingRows />
        ) : error ? (
          <div className="py-16 px-5 text-center">
            <ShieldCheck className="w-10 h-10 mx-auto text-destructive mb-3" />
            <p className="font-semibold">Ma’lumot yuklanmadi</p>
            <p className="text-sm text-muted-foreground mt-1">{error}</p>
            <Button type="button" variant="outline" onClick={() => setReloadKey((value) => value + 1)} className="mt-4 min-h-11 rounded-xl">
              Qayta urinish
            </Button>
          </div>
        ) : data.rows.length === 0 ? (
          <div className="py-16 px-5 text-center">
            <Activity className="w-10 h-10 mx-auto text-muted-foreground/60 mb-3" />
            <p className="font-semibold">Yozuv topilmadi</p>
            <p className="text-sm text-muted-foreground mt-1">Filtrlarni o‘zgartirib ko‘ring.</p>
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary/35 hover:bg-secondary/35">
                    <TableHead className="pl-5 min-w-36">Vaqt</TableHead>
                    <TableHead className="min-w-44">Amal</TableHead>
                    <TableHead className="min-w-40">Xodim</TableHead>
                    <TableHead className="min-w-36">Do‘kon</TableHead>
                    <TableHead className="min-w-60">Tafsilot</TableHead>
                    <TableHead className="pr-5 text-right min-w-32">Qiymat</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row) => <AuditTableRow key={row.id} row={row} />)}
                </TableBody>
              </Table>
            </div>
            <div className="md:hidden divide-y divide-border">
              {data.rows.map((row) => <AuditMobileRow key={row.id} row={row} />)}
            </div>
          </>
        )}

        {!loading && !error && data.total > PAGE_SIZE && (
          <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={page <= 1}
              className="min-h-11 rounded-xl"
            >
              <ChevronLeft />
              <span className="hidden sm:inline">Oldingi</span>
            </Button>
            <span className="text-sm font-medium">{page + " / " + totalPages}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              disabled={page >= totalPages}
              className="min-h-11 rounded-xl"
            >
              <span className="hidden sm:inline">Keyingi</span>
              <ChevronRight />
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function FilterField({ label, children }) {
  return (
    <label className="block min-w-0">
      <span className="text-xs font-semibold text-muted-foreground mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function SummaryCard({ icon: Icon, label, value, note, danger = false }) {
  return (
    <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-3 sm:p-4 min-w-0">
      <div className="flex items-start gap-3">
        <div className={"w-10 h-10 rounded-xl flex items-center justify-center shrink-0 " + (danger ? "bg-red-50 text-destructive" : "brand-surface text-brand-ink")}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="font-display text-base sm:text-lg font-bold truncate mt-0.5" title={value}>{value}</p>
          <p className="text-[11px] text-muted-foreground truncate mt-0.5" title={note}>{note}</p>
        </div>
      </div>
    </div>
  );
}

function AuditBadge({ row }) {
  return (
    <span className={"inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold " + (AUDIT_CATEGORY_STYLES[row.category] || AUDIT_CATEGORY_STYLES.action)}>
      {row.category_label}
    </span>
  );
}

function AuditIcon({ category }) {
  const Icon = CATEGORY_ICONS[category] || Activity;
  return (
    <div className="w-9 h-9 rounded-xl brand-surface text-brand-ink flex items-center justify-center shrink-0">
      <Icon className="w-4 h-4" />
    </div>
  );
}

function ValueCell({ row, mobile = false }) {
  const hasAmount = row.amount != null;
  const quantity = quantityText(row);
  if (!hasAmount && !quantity) return <span className="text-muted-foreground">—</span>;
  return (
    <div className={mobile ? "" : "text-right"}>
      {hasAmount && (
        <div className={"font-semibold " + (Number(row.amount) < 0 ? "text-destructive" : "")}>
          {formatUZS(row.amount)}
        </div>
      )}
      {quantity && (
        <div className={"text-xs font-medium " + (Number(row.quantity) < 0 ? "text-destructive" : "text-emerald-700")}>
          {quantity}
        </div>
      )}
      {row.amount_label && <div className="text-[11px] text-muted-foreground">{row.amount_label}</div>}
    </div>
  );
}

function AuditTableRow({ row }) {
  return (
    <TableRow>
      <TableCell className="pl-5 align-top">
        <div className="text-sm font-medium whitespace-nowrap">{formatAuditDateTime(row.event_time)}</div>
        <div className="text-[11px] text-muted-foreground mt-1">{row.business_date}</div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex gap-2.5">
          <AuditIcon category={row.category} />
          <div className="min-w-0">
            <div className="font-semibold">{row.action_label}</div>
            <div className="mt-1 flex flex-wrap gap-1.5 items-center">
              <AuditBadge row={row} />
              <span className="text-[11px] text-muted-foreground">{auditSourceLabel(row.source)}</span>
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-start gap-1.5">
          <UserRound className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
          <span className="text-sm">{row.user_name || "—"}</span>
        </div>
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-start gap-1.5">
          <Store className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
          <span className="text-sm">
            {row.shop_name || "—"}
            {row.shop_inferred && <span className="block text-[10px] text-muted-foreground">jurnaldan aniqlandi</span>}
          </span>
        </div>
      </TableCell>
      <TableCell className="align-top">
        {row.reference && <div className="text-xs font-semibold text-brand-ink mb-1">{row.reference}</div>}
        <p className="text-xs leading-5 text-muted-foreground break-words">{row.details || "—"}</p>
        {row.status && <p className="text-[11px] mt-1">{auditStatusLabel(row.status)}</p>}
      </TableCell>
      <TableCell className="pr-5 align-top">
        <ValueCell row={row} />
      </TableCell>
    </TableRow>
  );
}

function AuditMobileRow({ row }) {
  return (
    <article className="p-4">
      <div className="flex gap-3">
        <AuditIcon category={row.category} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold leading-snug">{row.action_label}</h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">{formatAuditDateTime(row.event_time)}</p>
            </div>
            <AuditBadge row={row} />
          </div>
          <div className="grid grid-cols-1 xs:grid-cols-2 gap-1.5 mt-3 text-xs">
            <span className="flex items-center gap-1.5"><UserRound className="w-3.5 h-3.5 text-muted-foreground" />{row.user_name || "—"}</span>
            <span className="flex items-center gap-1.5"><Store className="w-3.5 h-3.5 text-muted-foreground" />{row.shop_name || "—"}</span>
          </div>
          {row.reference && <div className="text-xs font-semibold text-brand-ink mt-3">{row.reference}</div>}
          <p className="text-xs leading-5 text-muted-foreground mt-1 break-words">{row.details || "—"}</p>
          <div className="mt-3 flex items-end justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">{auditSourceLabel(row.source)}</span>
            <ValueCell row={row} mobile />
          </div>
        </div>
      </div>
    </article>
  );
}

function LoadingRows() {
  return (
    <div className="p-4 space-y-3">
      {Array.from({ length: 7 }).map((_, index) => (
        <div key={index} className="h-16 rounded-xl bg-secondary/70 animate-pulse" />
      ))}
    </div>
  );
}
