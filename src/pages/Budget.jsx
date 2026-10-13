import '@/styles/operations-workbench.css';
import React, { useEffect, useMemo, useState } from "react";
import OdinaSelect from "@/components/ui/odina-select";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  CreditCard,
  Landmark,
  ArrowUpDown,
  Search,
  ShieldCheck,
  Smartphone,
  WalletCards,
} from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { odinaAlert } from "@/lib/odina-dialog";
import { formatUZS } from "@/lib/pos";
import { formatUzbekistanDateTime } from "@/lib/uzbekistan-time";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const ACCOUNTS = [
  { id: "cash", label: "Naqd pul", icon: Banknote, tone: "bg-secondary text-brand-ink" },
  { id: "uzcard", label: "Bank card", icon: CreditCard, tone: "bg-secondary text-brand-ink" },
  { id: "humo", label: "Humo", icon: WalletCards, tone: "bg-secondary text-brand-ink" },
  { id: "online", label: "Online", icon: Smartphone, tone: "bg-secondary text-brand-ink" },
  { id: "bank", label: "Bank", icon: Landmark, tone: "bg-secondary text-brand-ink" },
];

const TYPE_LABELS = {
  shift_deposit: "Smena topshirig‘i",
  supplier_payment: "Yetkazib beruvchi qarzi",
  manual_deposit: "Qo‘lda kirim",
  manual_withdrawal: "Qo‘lda chiqim",
};

const errorText = (error) =>
  error?.response?.data?.error || error?.data?.error || error?.message || String(error || "Noma’lum xato");

export default function Budget() {
  const { user } = useOutletContext();
  const [balances, setBalances] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [accountFilter, setAccountFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const result = await base44.functions.invoke("budget-ledger", { action: "summary" });
      const payload = result?.data || result;
      if (!payload?.balances || !payload?.transactions) {
        throw new Error(payload?.error || "Budget ma’lumotlarini yuklab bo‘lmadi.");
      }
      setBalances(payload.balances);
      setTransactions(payload.transactions);
    } catch (error) {
      void odinaAlert("Budget yuklanmadi: " + errorText(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const balanceMap = useMemo(
    () => Object.fromEntries(balances.map((row) => [row.account, Number(row.balance || 0)])),
    [balances],
  );
  const totalBalance = ACCOUNTS.reduce((sum, account) => sum + Number(balanceMap[account.id] || 0), 0);

  const visibleTransactions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return transactions.filter((transaction) => {
      if (accountFilter !== "all" && transaction.account !== accountFilter) return false;
      if (typeFilter !== "all" && transaction.type !== typeFilter) return false;
      if (!query) return true;
      return [
        transaction.transaction_number,
        transaction.shop_name,
        transaction.supplier_name,
        transaction.description,
        transaction.performed_by_name,
      ].filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }, [transactions, accountFilter, typeFilter, search]);

  if (user?.role !== "admin") return null;

  return (
    <div className="odina-page odina-workbench odina-operations odina-budget p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in">
      <PageHeader
        title="Budget"
        eyebrow="EGASI MOLIYASI"
        subtitle="Smenalardan tushgan mablag‘lar va egasi tasdiqlagan chiqimlar"
        icon={WalletCards}
        actions={(
          <Button
            type="button"
            onClick={() => setAdjustOpen(true)}
            className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation"
          >
            <ArrowUpDown className="w-4 h-4 mr-1.5" /> Mablag‘ kiritish / chiqarish
          </Button>
        )}
      />

      <div className="odina-operations-note rounded-2xl border border-primary/20 bg-primary/5 p-4 mb-5 flex gap-3">
        <ShieldCheck className="w-5 h-5 text-brand-ink shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-sm">Faqat egasi ko‘radi</p>
          <p className="text-xs text-muted-foreground mt-1">
            Smena yopilganda topshirilgan naqd pul va elektron tushumlar avtomatik qo‘shiladi.
            Eski mablag‘ni boshlang‘ich kirim sifatida bir marta kiritish mumkin.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-28 rounded-2xl bg-secondary animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <div className="odina-budget-balances grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            <div className="odina-budget-total odina-metric-accent col-span-2 lg:col-span-1 rounded-2xl border border-primary/25 bg-primary text-primary-foreground p-5 premium-shadow">
              <p className="text-xs opacity-80">Jami Budget</p>
              <p className="text-2xl sm:text-3xl font-semibold mt-2">{formatUZS(totalBalance)}</p>
              <p className="text-xs opacity-75 mt-2">Barcha pul manbalari yig‘indisi</p>
            </div>
            {ACCOUNTS.map(({ id, label, icon: Icon, tone }) => (
              <div key={id} className="odina-budget-account odina-panel rounded-2xl border border-border bg-card p-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tone}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <p className="text-xs text-muted-foreground mt-3">{label}</p>
                <p className="text-lg sm:text-xl font-semibold mt-1">{formatUZS(balanceMap[id] || 0)}</p>
              </div>
            ))}
          </div>

          <div className="odina-operations-toolbar odina-panel rounded-2xl border border-border bg-card p-4 sm:p-5 mt-6">
            <div className="flex flex-col lg:flex-row lg:items-end gap-3">
              <div className="flex-1">
                <h3 className="font-display text-lg font-semibold">Budget tarixi</h3>
                <p className="text-xs text-muted-foreground mt-1">Kim, qachon, qaysi hisobdan pul qo‘shgani yoki olgani.</p>
              </div>
              <label className="lg:w-44">
                <span className="text-xs text-muted-foreground block mb-1.5">Hisob</span>
                <OdinaSelect value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="all">Barcha hisoblar</option>
                  {ACCOUNTS.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
                </OdinaSelect>
              </label>
              <label className="lg:w-52">
                <span className="text-xs text-muted-foreground block mb-1.5">Amal turi</span>
                <OdinaSelect value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm">
                  <option value="all">Barcha amallar</option>
                  {Object.entries(TYPE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </OdinaSelect>
              </label>
              <label className="lg:w-64">
                <span className="text-xs text-muted-foreground block mb-1.5">Qidiruv</span>
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Do‘kon, xodim, hujjat…" className="h-10 pl-9" />
                </div>
              </label>
            </div>
          </div>

          <div className="odina-ledger space-y-3 mt-4">
            {visibleTransactions.length === 0 ? (
              <div className="odina-panel rounded-2xl border border-dashed border-border bg-card py-14 text-center text-sm text-muted-foreground">
                Hozircha Budget harakati yo‘q.
              </div>
            ) : visibleTransactions.map((transaction) => {
              const incoming = transaction.direction === "in";
              const account = ACCOUNTS.find((item) => item.id === transaction.account);
              const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
              return (
                <div key={transaction.id} className="odina-ledger-row odina-budget-row odina-panel rounded-2xl border border-border bg-card p-4 flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${incoming ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-destructive"}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold">{TYPE_LABELS[transaction.type] || transaction.type}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {account?.label || transaction.account} · {transaction.transaction_number}
                        </p>
                      </div>
                      <p className={`font-semibold whitespace-nowrap ${incoming ? "text-emerald-700" : "text-destructive"}`}>
                        {incoming ? "+" : "−"}{formatUZS(transaction.amount)}
                      </p>
                    </div>
                    <p className="text-sm mt-2">{transaction.description}</p>
                    <p className="text-xs text-muted-foreground mt-2">
                      {transaction.performed_by_name || "Noma’lum"} · {formatUzbekistanDateTime(transaction.created_at || transaction.created_date)}
                      {transaction.shop_name ? ` · ${transaction.shop_name}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Qoldiq: {formatUZS(transaction.balance_before)} → {formatUZS(transaction.balance_after)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <AdjustmentDialog
        open={adjustOpen}
        balances={balanceMap}
        onClose={() => setAdjustOpen(false)}
        onSaved={() => { setAdjustOpen(false); load(); }}
      />
    </div>
  );
}

function AdjustmentDialog({ open, balances, onClose, onSaved }) {
  const [direction, setDirection] = useState("in");
  const [account, setAccount] = useState("cash");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [ownerPin, setOwnerPin] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDirection("in");
      setAccount("cash");
      setAmount("");
      setDescription("");
      setOwnerPin("");
    }
  }, [open]);

  const value = Math.round(Number(amount) || 0);
  const available = Number(balances[account] || 0);
  const invalidWithdrawal = direction === "out" && value > available;

  const submit = async () => {
    if (value <= 0 || description.trim().length < 3 || !/^\d{4,8}$/.test(ownerPin) || invalidWithdrawal) return;
    setSaving(true);
    try {
      const result = await base44.functions.invoke("budget-ledger", {
        action: "manual_adjustment",
        direction,
        account,
        amount: value,
        description: description.trim(),
        owner_pin: ownerPin,
      });
      const payload = result?.data || result;
      if (!payload?.transaction) throw new Error(payload?.error || "Budget amali bajarilmadi.");
      onSaved();
    } catch (error) {
      void odinaAlert("Budget amali bajarilmadi: " + errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Budget mablag‘ini yangilash</DialogTitle>
          <p className="text-sm text-muted-foreground">Har bir qo‘lda o‘zgarish egasi va izohi bilan tarixda saqlanadi.</p>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant={direction === "in" ? "default" : "outline"} onClick={() => setDirection("in")} disabled={saving}>Kirim</Button>
          <Button type="button" variant={direction === "out" ? "destructive" : "outline"} onClick={() => setDirection("out")} disabled={saving}>Chiqim</Button>
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">Pul hisobi</Label>
          <OdinaSelect value={account} onChange={(event) => setAccount(event.target.value)} disabled={saving} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
            {ACCOUNTS.map((item) => (
              <option key={item.id} value={item.id}>{item.label} · {formatUZS(balances[item.id] || 0)}</option>
            ))}
          </OdinaSelect>
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">Summa</Label>
          <Input type="number" min="1" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0" disabled={saving} />
          {invalidWithdrawal && <p className="text-xs text-destructive mt-1">Tanlangan hisobda mablag‘ yetarli emas.</p>}
        </div>

        <div>
          <Label className="text-xs mb-1.5 block">Sabab / izoh</Label>
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Masalan: boshlang‘ich naqd mablag‘" rows={2} disabled={saving} />
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
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button type="button" onClick={submit} disabled={saving || value <= 0 || description.trim().length < 3 || !/^\d{4,8}$/.test(ownerPin) || invalidWithdrawal}>
            {saving ? "Saqlanmoqda…" : "Owner PIN bilan saqlash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

