import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';

export default function TelegramAlerts() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState('');
  const request = async (action, extra = {}) => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const { data } = await base44.functions.invoke('telegram-alerts', { action, ...extra });
      if (action === 'preview') setPreview(data);
      if (action === 'run') {
        setPreview(null);
        setNotice(data.sent ? data.count + ' ta ogohlantirish yuborildi.' : data.busy ? 'Boshqa tekshiruv ishlayapti.' : data.paused ? 'Yuborish to‘xtatilgan.' : 'Yangi ogohlantirish yo‘q.');
      }
      const response = await base44.functions.invoke('telegram-alerts', { action: 'status' });
      setStatus(response.data);
    } catch (e) {
      setNotice(e?.response?.data?.error || 'Natija olinmadi. Qayta yuborishdan oldin Telegram guruhini tekshiring.');
    } finally { setBusy(false); }
  };
  const formatTime = value => value ? new Date(value).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' }) : 'Hali ishlamagan';
  const labels = { sent: 'Yuborildi', reserved: 'Yuborish boshlangan — natijani tekshiring', uncertain: 'Yetkazilish noaniq — guruhni tekshiring', rejected: 'Telegram qabul qilmadi' };
  return <div className="border-t border-border pt-4 mt-4 space-y-3">
    <h3 className="font-semibold">Avtomatik ogohlantirishlar</h3>
    <p className="text-sm text-muted-foreground">Buyurtmaga 3 soat qolganda, 1 soat qolganda va muddati o‘tganda — har bosqichda bir martadan. Ertangi masalliq kamomadi — Toshkent vaqti bilan 18:00 dan keyin kuniga bir marta. Guruhga moliyaviy ma’lumotlar yuborilmaydi.</p>
    <div className="rounded-xl bg-secondary p-3 text-sm space-y-1">
      <p className="font-medium">Server jadvalini Base44’da bir marta yoqing</p>
      <p>Funksiya: <code>telegram-alerts</code> · har 5 daqiqa · egasi/admin akkauntidan.</p>
      <p>Funksiya argumentlari: <code>{'{"action":"run"}'}</code></p>
      <p>Sayt ochiq bo‘lishi shart emas. Quyidagi tugmalar jadval yaratmaydi.</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => request('status')}>Holatni yangilash</Button>
      <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => request('preview')}>Xabarni oldindan ko‘rish</Button>
      <Button className="min-h-11" disabled={busy || status?.enabled === false} onClick={() => request('run')}>Hozir tekshirish va yuborish</Button>
      {status && <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => request('toggle', { enabled: !status.enabled })}>
        {status.enabled ? 'Yuborishni to‘xtatish' : 'Yuborishga ruxsat berish'}
      </Button>}
    </div>
    <div aria-live="polite" className="space-y-2 text-sm">
      {busy && <p>Tekshirilmoqda…</p>}
      {notice && <p>{notice}</p>}
      {status && <>
        <p>Yuborish: {status.enabled ? 'Ruxsat berilgan' : 'To‘xtatilgan'}</p>
        <p>Oxirgi ishga tushish: {formatTime(status.last_run_at)}</p>
        <p>{status.last_result}</p>
        {status.recent?.map(row => <p key={row.id}>{formatTime(row.sent_at || row.created_date)} · {labels[row.status] || row.status}</p>)}
      </>}
      {preview && <pre className="whitespace-pre-wrap break-words rounded-xl border border-border p-3 font-sans">{preview.text || 'Hozir yangi ogohlantirish yo‘q.'}</pre>}
    </div>
  </div>;
}
