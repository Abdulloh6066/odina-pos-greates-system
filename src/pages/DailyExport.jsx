import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import PageHeader from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/use-toast';
import {
  Download, Send, FileSpreadsheet, Mail, RefreshCw, ExternalLink, ShieldAlert,
} from 'lucide-react';
import { formatNum, tashkentDateKey } from '@/lib/pos';

const CSV_HEADERS = [
  "Sana", "Do'kon", "Tushum (UZS)", "Tannarx (UZS)", "Real foyda (UZS)",
  "Sotuv soni", "Qaytar soni", "Naqd", "Uzcard", "Humo", "Online", "Bank",
  "Yuborildi", "Yuborilgan vaqt",
];

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function reportsToCsv(reports) {
  const lines = [CSV_HEADERS, ...reports.map((r) => [
    r.business_date, r.shop_name,
    Math.round(r.total_revenue || 0), Math.round(r.total_cost || 0), Math.round(r.real_profit || 0),
    r.sale_count || 0, r.refund_count || 0,
    Math.round(r.cash_total || 0), Math.round(r.uzcard_total || 0), Math.round(r.humo_total || 0),
    Math.round(r.online_total || 0), Math.round(r.bank_transfer_total || 0),
    r.email_sent ? 'ha' : 'yoq', r.sent_at || '',
  ])];
  return lines.map((cols) => cols.map(csvCell).join(',')).join('\n');
}

function downloadCsv(filename, reports) {
  const csv = '\uFEFF' + reportsToCsv(reports);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const COLS = [
  { key: 'shop_name', label: "Do'kon" },
  { key: 'total_revenue', label: 'Tushum', num: true },
  { key: 'total_cost', label: 'Tannarx', num: true },
  { key: 'real_profit', label: 'Real foyda', num: true, profit: true },
  { key: 'sale_count', label: 'Sotuv', num: true },
  { key: 'refund_count', label: 'Qaytar', num: true },
  { key: 'cash_total', label: 'Naqd', num: true },
  { key: 'uzcard_total', label: 'Uzcard', num: true },
  { key: 'humo_total', label: 'Humo', num: true },
  { key: 'online_total', label: 'Online', num: true },
  { key: 'bank_transfer_total', label: 'Bank', num: true },
];

export default function DailyExport() {
  const { user } = useAuth();
  const role = user?.role || 'cashier';
  const isAdmin = role === 'admin';
  const { toast } = useToast();

  const [businessDate, setBusinessDate] = useState(tashkentDateKey());
  const [reports, setReports] = useState([]);
  const [config, setConfig] = useState(null);
  const [sheetsConnected, setSheetsConnected] = useState(false);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [emailDraft, setEmailDraft] = useState('');
  const [autoSend, setAutoSend] = useState(true);
  const [reminder, setReminder] = useState(true);

  const loadConfig = async () => {
    try {
      const res = await base44.functions.invoke('daily-sales-export', { action: 'getConfig' });
      const cfg = res.data?.config;
      setConfig(cfg);
      setSheetsConnected(Boolean(res.data?.sheets_connected));
      if (cfg) {
        setEmailDraft(cfg.recipient_email || '');
        setAutoSend(cfg.auto_send_enabled !== false);
        setReminder(cfg.reminder_enabled !== false);
      }
    } catch (e) {
      // ignore — may be missing permissions
    }
  };

  const loadPreview = async (date) => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke('daily-sales-export', {
        action: 'preview',
        business_date: date,
      });
      setReports(res.data?.reports || []);
    } catch (e) {
      toast({ title: 'Hisobni yuklab bo‘lmadi', description: e?.message, variant: 'destructive' });
      setReports([]);
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async () => {
    try {
      const rows = await base44.entities.DailyShopReport.list('-business_date', 100);
      setHistory(rows || []);
    } catch {
      setHistory([]);
    }
  };

  useEffect(() => {
    loadConfig();
    loadPreview(tashkentDateKey());
    loadHistory();
  }, []);

  const totals = useMemo(() => {
    return reports.reduce(
      (acc, r) => {
        acc.revenue += Number(r.total_revenue || 0);
        acc.cost += Number(r.total_cost || 0);
        acc.profit += Number(r.real_profit || 0);
        acc.sales += Number(r.sale_count || 0);
        acc.refunds += Number(r.refund_count || 0);
        return acc;
      },
      { revenue: 0, cost: 0, profit: 0, sales: 0, refunds: 0 },
    );
  }, [reports]);

  const handleSend = async () => {
    if (!isAdmin) return;
    setSending(true);
    try {
      const res = await base44.functions.invoke('daily-sales-export', {
        action: 'send',
        business_date: businessDate,
      });
      const d = res.data || {};
      toast({
        title: d.sent ? `Yuborildi: ${d.sent} do‘kon` : 'Yuborilmadi',
        description: [
          d.sheet_ok ? 'Google Sheet ✅' : `Sheet: ${d.sheet_error || 'xato'}`,
          d.email_ok ? 'Email ✅' : `Email: ${d.email_error || 'yoq'}`,
        ].join(' · '),
        variant: d.sheet_ok && d.email_ok ? 'default' : 'destructive',
      });
      loadConfig();
      loadHistory();
    } catch (e) {
      toast({ title: 'Yuborishda xato', description: e?.message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!isAdmin) return;
    setSaving(true);
    try {
      await base44.functions.invoke('daily-sales-export', {
        action: 'saveConfig',
        recipient_email: emailDraft,
        auto_send_enabled: autoSend,
        reminder_enabled: reminder,
      });
      toast({ title: 'Sozlamalar saqlandi' });
      loadConfig();
    } catch (e) {
      toast({ title: 'Saqlashda xato', description: e?.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const historyByDate = useMemo(() => {
    const map = new Map();
    for (const r of history) {
      if (!map.has(r.business_date)) map.set(r.business_date, []);
      map.get(r.business_date).push(r);
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [history]);

  return (
    <div className="space-y-6">
      <PageHeader title="Kunlik eksport" subtitle="Har do‘kon uchun tushum, tannarx va real foyda — Google Sheet, email va CSV" />

      {/* Config */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="w-5 h-5 text-brand-olive" /> Sozlamalar
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email manzil (kunlik hisobot shu yerga yuboriladi)</Label>
                <Input id="email" type="email" value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} placeholder="owner@odina.uz" />
              </div>
              <div className="space-y-1.5">
                <Label>Google Sheets ulanishi</Label>
                <div className="flex items-center gap-2 h-11 px-3 rounded-xl border border-border bg-secondary/40 text-sm">
                  {sheetsConnected ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-foreground">Ulangan</span>
                    </>
                  ) : (
                    <>
                      <ShieldAlert className="w-4 h-4 text-destructive" />
                      <span className="text-destructive">Ulanmagan — admin Google hisobni ulashi kerak</span>
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-6 pt-1">
              <label className="flex items-center gap-3 text-sm">
                <Switch checked={autoSend} onCheckedChange={setAutoSend} />
                <span>Avtomatik yuborish (smena yopilganda, 23:00+)</span>
              </label>
              <label className="flex items-center gap-3 text-sm">
                <Switch checked={reminder} onCheckedChange={setReminder} />
                <span>Smena yopilmasa — Telegram eslatma</span>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button onClick={handleSaveConfig} disabled={saving}>
                {saving ? 'Saqlanmoqda…' : 'Sozlamalarni saqlash'}
              </Button>
              {config?.google_sheet_url && (
                <a href={config.google_sheet_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-brand-ink hover:underline">
                  <ExternalLink className="w-4 h-4" /> Google Sheetni ochish
                </a>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Preview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
            <span>Kunlik hisobot</span>
            <div className="flex flex-wrap items-center gap-2">
              <Input type="date" value={businessDate} max={tashkentDateKey()} onChange={(e) => setBusinessDate(e.target.value)} className="w-44 h-10" />
              <Button variant="outline" size="sm" onClick={() => loadPreview(businessDate)} disabled={loading}>
                <RefreshCw className="w-4 h-4" /> Yangilash
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadCsv(`odina-hisobot-${businessDate}.csv`, reports)}>
                <Download className="w-4 h-4" /> CSV
              </Button>
              {isAdmin && (
                <Button size="sm" onClick={handleSend} disabled={sending}>
                  <Send className="w-4 h-4" /> {sending ? 'Yuborilmoqda…' : 'Sheet + Email ga yuborish'}
                </Button>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Hisoblanmoqda…</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    {COLS.map((c) => (
                      <th key={c.key} className="py-2 pr-3 font-medium whitespace-nowrap">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.shop_id} className="border-b border-border/60 hover:bg-secondary/40">
                      {COLS.map((c) => (
                        <td key={c.key} className={`py-2.5 pr-3 whitespace-nowrap ${c.profit ? (Number(r.real_profit) < 0 ? 'text-destructive' : 'text-emerald-600') : ''} ${c.num ? 'tabular-nums' : 'font-medium'}`}>
                          {c.num ? formatNum(r[c.key]) : r[c.key]}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {!reports.length && (
                    <tr><td colSpan={COLS.length} className="py-8 text-center text-muted-foreground">Bu sana uchun savdo topilmadi.</td></tr>
                  )}
                </tbody>
                {reports.length > 0 && (
                  <tfoot>
                    <tr className="font-semibold bg-secondary/40">
                      <td className="py-2.5 pr-3">JAMI</td>
                      <td className="py-2.5 pr-3 tabular-nums">{formatNum(totals.revenue)}</td>
                      <td className="py-2.5 pr-3 tabular-nums">{formatNum(totals.cost)}</td>
                      <td className="py-2.5 pr-3 tabular-nums text-emerald-600">{formatNum(totals.profit)}</td>
                      <td className="py-2.5 pr-3 tabular-nums">{totals.sales}</td>
                      <td className="py-2.5 pr-3 tabular-nums">{totals.refunds}</td>
                      <td colSpan={5} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="w-5 h-5 text-brand-olive" /> Yuborilgan hisobotlar tarixi
          </CardTitle>
        </CardHeader>
        <CardContent>
          {historyByDate.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Hali yuborilgan hisobot yo‘q.</div>
          ) : (
            <div className="space-y-3">
              {historyByDate.map(([date, rows]) => (
                <div key={date} className="rounded-xl border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-3">
                      <span className="font-display font-semibold">{date}</span>
                      <span className="text-xs text-muted-foreground">{rows.length} do‘kon</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => downloadCsv(`odina-hisobot-${date}.csv`, rows)}>
                        <Download className="w-4 h-4" /> CSV
                      </Button>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-muted-foreground border-b border-border">
                          <th className="py-1.5 pr-3 font-medium">Do‘kon</th>
                          <th className="py-1.5 pr-3 font-medium">Tushum</th>
                          <th className="py-1.5 pr-3 font-medium">Tannarx</th>
                          <th className="py-1.5 pr-3 font-medium">Foyda</th>
                          <th className="py-1.5 pr-3 font-medium">Sotuv</th>
                          <th className="py-1.5 pr-3 font-medium">Holat</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.id} className="border-b border-border/40">
                            <td className="py-1.5 pr-3 font-medium">{r.shop_name}</td>
                            <td className="py-1.5 pr-3 tabular-nums">{formatNum(r.total_revenue)}</td>
                            <td className="py-1.5 pr-3 tabular-nums">{formatNum(r.total_cost)}</td>
                            <td className={`py-1.5 pr-3 tabular-nums ${Number(r.real_profit) < 0 ? 'text-destructive' : 'text-emerald-600'}`}>{formatNum(r.real_profit)}</td>
                            <td className="py-1.5 pr-3 tabular-nums">{r.sale_count}</td>
                            <td className="py-1.5 pr-3">
                              {r.email_sent ? (
                                <span className="inline-flex items-center gap-1 text-emerald-600"><Mail className="w-3 h-3" /> yuborildi</span>
                              ) : (
                                <span className="text-muted-foreground">CSV</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}