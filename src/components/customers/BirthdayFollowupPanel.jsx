import React, { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Loader2, Phone, Cake, Send, CheckCircle, PhoneMissed, BellRing } from 'lucide-react';
import { formatPhone } from '@/lib/customers';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import { useToast } from '@/components/ui/use-toast';

const STATUS_LABELS = {
  hali_aloqa_qilinmadi: "Hali aloqa qilinmadi",
  qongiroq_javob_bolmadi: "Qo'ng'iroq qilindi, javob bo'lmadi",
  aloqa_chiqildi: "Aloqaga chiqildi",
};

export default function BirthdayFollowupPanel({ user }) {
  const { toast } = useToast();
  const isAdmin = (user?.role || user?.data?.role) === 'admin';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await base44.functions.invoke('telegram-alerts', { action: 'birthdayList' });
      setData(res.data);
    } catch (e) {
      setData({ items: [], counters: { need_contact: 0, no_answer: 0, reached: 0, total: 0 }, error: e?.response?.data?.error || 'Ma’lumot olinmadi.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 10000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const setStatus = async (customerId, campaignYear, status) => {
    setBusyId(customerId + ':' + status);
    try {
      await base44.functions.invoke('telegram-alerts', { action: 'birthdayContact', customer_id: customerId, campaign_year: campaignYear, contact_status: status });
      await load();
    } catch (e) {
      toast({ title: 'Saqlanmadi', description: e?.response?.data?.error || 'Qayta urinib ko‘ring.', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const sendNow = async () => {
    if (data?.already_sent_today) {
      const ok = window.confirm('Bugun tug‘ilgan kun ro‘yxati allaqachon Telegramga yuborilgan. Yana yuborishni xohlaysizmi?');
      if (!ok) return;
    }
    setSending(true);
    try {
      const res = await base44.functions.invoke('telegram-alerts', { action: 'birthdaySend' });
      const d = res.data;
      if (d?.error) {
        toast({ title: 'Yuborilmadi', description: d.error, variant: 'destructive' });
      } else if (d?.sent) {
        toast({ title: 'Yuborildi', description: d.message || (d.count + ' ta eslatma yuborildi.') });
      } else {
        toast({ title: 'Ma’lumot', description: d.message || 'Yuboriladigan mijoz topilmadi.' });
      }
      await load();
    } catch (e) {
      toast({ title: 'Yuborilmadi', description: e?.response?.data?.error || 'Telegram yuborishda xato. Qayta urinib ko‘ring.', variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  const items = data?.items || [];
  const counters = data?.counters || { need_contact: 0, no_answer: 0, reached: 0, total: 0 };
  const active = items.filter((i) => i.contact_status !== 'aloqa_chiqildi');
  const reached = items.filter((i) => i.contact_status === 'aloqa_chiqildi');

  return (
    <div className="customer-birthday-panel rounded-2xl border p-4 mb-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Cake className="w-5 h-5 text-brand-ink" />
          <h2 className="font-display text-lg font-bold">Tug‘ilgan kun eslatmalari</h2>
        </div>
        {isAdmin && (
          <Button onClick={sendNow} disabled={sending || loading}>
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Tug‘ilgan kunlarni tekshirish va Telegramga yuborish
          </Button>
        )}
      </div>

      <div className="customer-birthday-counters grid grid-cols-3 gap-2 mb-4">
        <Counter icon={<BellRing className="w-4 h-4" />} label="Bog‘lanish kerak" value={counters.need_contact} tone="amber" />
        <Counter icon={<PhoneMissed className="w-4 h-4" />} label="Javob bo‘lmadi" value={counters.no_answer} tone="blue" />
        <Counter icon={<CheckCircle className="w-4 h-4" />} label="Aloqaga chiqildi" value={counters.reached} tone="green" />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : data?.error ? (
        <p className="text-sm text-destructive">{data.error}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">Yaqin 3 kun ichida bog‘lanish kerak bo‘lgan mijoz topilmadi.</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            {active.map((i) => (
              <FollowupRow key={i.customer_id} item={i} onStatus={setStatus} busyId={busyId} />
            ))}
          </div>
          {reached.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-2">Aloqaga chiqildi ({reached.length})</div>
              <div className="space-y-2">
                {reached.map((i) => (
                  <FollowupRow key={i.customer_id} item={i} onStatus={setStatus} busyId={busyId} completed />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Counter({ icon, label, value, tone }) {
  return (
    <div className="customer-birthday-counter rounded-xl border px-3 py-2.5" data-tone={tone}>
      <div className="flex items-center gap-1.5 text-xs font-medium opacity-80">{icon}{label}</div>
      <div className="font-display text-2xl font-bold leading-tight">{value}</div>
    </div>
  );
}

function FollowupRow({ item, onStatus, busyId, completed }) {
  const isBusy = busyId === item.customer_id + ':' + 'qongiroq_javob_bolmadi' || busyId === item.customer_id + ':' + 'aloqa_chiqildi';
  return (
    <div className="customer-followup-row rounded-xl border p-3" data-completed={completed ? 'true' : undefined}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{item.customer_name}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-0.5">
            <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{formatPhone(item.phone) || '—'}</span>
            <span className="flex items-center gap-1"><Cake className="w-3 h-3" />{item.birthday_display}</span>
            <span className="font-medium text-brand-ink">{item.label}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Holati: <span className="font-medium">{STATUS_LABELS[item.contact_status] || item.contact_status}</span>
            {item.contacted_at && item.contacted_by_name && (
              <span className="opacity-70"> · {item.contacted_by_name} · {formatUzbekistanDateTime(item.contacted_at)}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button size="sm" variant="outline" disabled={isBusy} onClick={() => onStatus(item.customer_id, item.campaign_year, 'qongiroq_javob_bolmadi')}>
            {busyId === item.customer_id + ':' + 'qongiroq_javob_bolmadi' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneMissed className="w-3.5 h-3.5" />}
            Javob bo‘lmadi
          </Button>
          <Button size="sm" disabled={isBusy} onClick={() => onStatus(item.customer_id, item.campaign_year, 'aloqa_chiqildi')}>
            {busyId === item.customer_id + ':' + 'aloqa_chiqildi' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
            Aloqaga chiqildi
          </Button>
        </div>
      </div>
    </div>
  );
}