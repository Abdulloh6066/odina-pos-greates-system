import '@/styles/operations-workbench.css';
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
import { odinaConfirm } from '@/lib/odina-dialog';
import { reportsToCsv } from '../../base44/shared/daily-report-logic';

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
  { key: 'total_revenue', label: 'Kassa sof savdo', num: true },
  { key: 'total_cost', label: 'Tannarx', num: true },
  { key: 'real_profit', label: 'Kassa yalpi foyda', num: true, profit: true },
  { key: 'sale_count', label: 'Sotuv', num: true },
  { key: 'refund_count', label: 'Qaytar', num: true },
  { key: 'cash_total', label: 'Naqd', num: true },
  { key: 'uzcard_total', label: 'Bank card / Uzcard', num: true },
  { key: 'humo_total', label: 'Humo (old)', num: true },
  { key: 'online_total', label: 'Online', num: true },
  { key: 'bank_transfer_total', label: 'Bank', num: true },
  { key: 'order_payment_total', label: 'Buyurtma to‘lovlari', num: true },
  { key: 'collections_total', label: 'Jami olingan pul', num: true },
  { key: 'expenses_total', label: 'Xarajatlar', num: true },
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

  const totals = useMemo(() => Object.fromEntries(COLS.filter(c => c.num).map(c => [
    c.key, reports.reduce((sum, row) => sum + Number(row[c.key] || 0), 0),
  ])), [reports]);

  const handleSend = async () => {
    if (!isAdmin || sending) return;
    const uncertain = history.some(row => row.business_date === businessDate
      && ['sending', 'uncertain'].includes(row.email_delivery_state));
    let retryUncertain = false;
    if (uncertain) {
      retryUncertain = await odinaConfirm('Oldingi email yetib borganligi noaniq. Avval pochtangizni tekshiring. Qayta yuborish takroriy email keltirishi mumkin.', {
        title: 'Emailni qayta yuborish', confirmLabel: 'Tekshirdim, qayta yuborish', tone: 'warning',
      });
      if (!retryUncertain) return;
    }
    setSending(true);
    try {
      const res = await base44.functions.invoke('daily-sales-export', {
        action: 'send',
        business_date: businessDate,
        retry_uncertain_email: retryUncertain,
      });
      const d = res.data || {};
      toast({
        title: d.sent ? `Yuborildi: ${d.sent} do‘kon` : 'Yuborilmadi',
        description: [
          d.sheet_ok ? 'Google Sheet ✅' : `Sheet: ${d.sheet_error || 'xato'}`,
          d.email_skipped ? 'Email sozlanmagan' : d.email_ok ? 'Email ✅' : `Email: ${d.email_error || 'yoq'}`,
        ].join(' · '),
        variant: d.sheet_ok && (d.email_ok || d.email_skipped) ? 'default' : 'destructive',
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
    <div className="odina-page odina-workbench odina-operations odina-daily-export p-5 sm:p-8 max-w-[1500px] mx-auto space-y-6">
      <PageHeader title="Kunlik eksport" eyebrow="HISOBOTLARNI YETKAZISH" icon={FileSpreadsheet} subtitle="Kassa savdosi, buyurtma to‘lovlari va olingan pul — Google Sheets, email va CSV" />

      {/* Config */}
      {isAdmin && (
        <Card className="odina-export-config odina-operations-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="w-5 h-5 text-brand-olive" /> Avtomatik yetkazish
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">Email, ulanish va eslatmalarni bir joyda sozlang.</p>
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
            <div className="odina-export-switches flex flex-wrap gap-6 pt-1">
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
      <Card className="odina-export-preview odina-operations-card">
        <CardHeader className="odina-export-preview-heading">
          <div><CardTitle className="text-base">Kunlik hisobot</CardTitle><p className="text-xs text-muted-foreground mt-1">Sanani tanlang, tekshiring va eksport qiling.</p></div>
            <div className="odina-export-actions flex flex-wrap items-center gap-2">
              <Input aria-label="Kunlik hisobot sanasi" type="date" value={businessDate} max={tashkentDateKey()} onChange={(e) => setBusinessDate(e.target.value)} className="w-44 h-10" />
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
        </CardHeader>
        <CardContent>
          <p className="odina-operations-note mb-3 text-xs text-muted-foreground leading-relaxed">Buyurtma avansi va qoldig‘i pul olingan kuni hisoblanadi, Kassa foydasiga qo‘shilmaydi. Kassa yalpi foydasidan do‘kon xarajatlari ayrilmagan.
            {reports.some(row => row.unknown_cost_count > 0) && ' Ayrim tannarxlar noma’lum yoki taxminiy; foyda to‘liq emas.'}
          </p>
          {loading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Hisoblanmoqda…</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="odina-operations-table w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    {COLS.map((c) => (
                      <th key={c.key} className={`py-2 pr-3 font-medium whitespace-nowrap ${c.num ? 'text-right' : 'text-left'}`}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => (
                    <tr key={r.shop_id} className="border-b border-border/60 hover:bg-secondary/40">
                      {COLS.map((c) => (
                        <td key={c.key} className={`py-2.5 pr-3 whitespace-nowrap ${c.profit ? (Number(r.real_profit) < 0 ? 'text-destructive' : 'text-emerald-600') : ''} ${c.num ? 'tabular-nums text-right' : 'font-medium'}`}>
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
                      {COLS.map(c => <td key={c.key} className={`py-2.5 pr-3 tabular-nums ${c.num ? 'text-right' : 'text-left'}`}>{c.num ? formatNum(totals[c.key]) : 'JAMI'}</td>)}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* History */}
      <Card className="odina-export-history odina-operations-card">
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
                <div key={date} className="odina-export-history-date rounded-xl border border-border p-3">
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
                    <table className="odina-operations-table w-full text-xs">
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
                              <span className={r.sheet_appended ? 'text-emerald-600' : 'text-muted-foreground'}>Sheets: {r.sheet_appended ? 'yuborildi' : 'yuborilmagan'}</span>
                              <br />
                              <span className={r.email_sent ? 'text-emerald-600' : 'text-muted-foreground'}>Email: {r.email_sent ? 'yuborildi' : ['sending', 'uncertain'].includes(r.email_delivery_state) ? 'tekshirish kerak' : 'yuborilmagan'}</span>
                              {r.delivery_error && <p className="mt-1 max-w-xs text-destructive">{r.delivery_error}</p>}
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
