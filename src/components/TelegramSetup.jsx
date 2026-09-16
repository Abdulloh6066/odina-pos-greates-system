import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import TelegramAlerts from '@/components/TelegramAlerts';

export default function TelegramSetup({ user }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  if ((user?.role || user?.data?.role) !== 'admin') return null;

  const inspect = async (action = 'inspect') => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await base44.functions.invoke('telegram-setup', { action });
      setResult(response.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Tekshirib bo‘lmadi. Internetni tekshiring va qayta urinib ko‘ring.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5 mb-5 space-y-3">
      <h2 className="font-display text-lg font-bold">Telegram — Ish jarayoni</h2>
      <p className="text-sm text-muted-foreground">Belgilangan guruh: Odina-Ish Jarayoni · -5570444945. Sinov xabari faqat shu guruhga yuboriladi.</p>
      <Button className="min-h-11 rounded-xl w-full sm:w-auto" onClick={() => inspect()} disabled={busy}>
        {busy ? 'Tekshirilmoqda…' : 'Ulanishni tekshirish'}
      </Button>
      <p className="text-sm text-muted-foreground">Sinov matni: “✅ Odina POS bilan ulanish ishlayapti. Bu sinov xabari. Avtomatik ogohlantirishlar hali yoqilmagan.”</p>
      <Button variant="outline" className="min-h-11 rounded-xl w-full sm:w-auto" onClick={() => inspect('test')} disabled={busy || result?.test_sent}>
        {result?.test_sent ? 'Sinov xabari yuborildi' : 'Guruhga sinov xabari yuborish'}
      </Button>
      <div aria-live="polite" className="space-y-3">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {result && <>
          <p className="text-sm font-medium">Bot tasdiqlandi: @{result.bot_username}</p>
          {result.groups?.length ? result.groups.map(group => (
            <div key={group.id} className="rounded-xl border border-border p-3 space-y-1">
              <p className="font-semibold break-words">{group.title}</p>
              <p className="text-sm">Chat ID: <span className="font-mono select-all break-all">{group.id}</span></p>
            </div>
          )) : <p className="text-sm text-muted-foreground">Belgilangan guruh topilmadi. Bot shu guruhga qo‘shilganini tekshiring.</p>}
          <p className="text-xs text-muted-foreground">Sinov xabari faqat ulanishni tekshiradi. Avtomatik ogohlantirishlar holati quyidagi bo‘limda.</p>
        </>}
      </div>
      <div className="rounded-xl border border-border p-3 space-y-2">
        <p className="text-sm font-semibold">Shaxsiy hisobotlar uchun webhook</p>
        <p className="text-xs text-muted-foreground">Faqat admin: bu amal botning mavjud webhook manzilini saqlagan holda xabar (/id, /hisobot) va tugma hodisalarini birgalikda yoqadi. Guruh bildirishnomalari saqlanadi. Hisobotlar faqat tasdiqlangan Telegram User ID ga ochiladi.</p>
        <Button variant="outline" className="min-h-11 rounded-xl" disabled={busy} onClick={() => inspect('setWebhook')}>
          {busy ? 'Ulanmoqda…' : 'Webhookni ulash (shaxsiy buyruqlar)'}
        </Button>
        <Button variant="outline" className="min-h-11 rounded-xl ml-0 sm:ml-2" disabled={busy} onClick={() => inspect('webhookStatus')}>
          {busy ? 'Tekshirilmoqda…' : 'Webhook diagnostikasi (faqat o‘qish)'}
        </Button>
        {result && typeof result.message_enabled === 'boolean' && (
          <div role="status" className="text-sm rounded-lg border border-border p-3 space-y-1">
            <p>Webhook manzili: {result.webhook_ok ? 'To‘g‘ri' : 'Noto‘g‘ri'}</p>
            <p>Shaxsiy xabarlar: {result.message_enabled ? 'Yoqilgan' : 'O‘chiq'}</p>
            <p>Tugmalar: {result.callbacks_enabled ? 'Yoqilgan' : 'O‘chiq'}</p>
            <p>Navbatdagi xabarlar: {result.pending_update_count}</p>
            <p>Oxirgi yetkazish xatosi: {result.last_error_date ? new Date(result.last_error_date * 1000).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' }) : 'Aniqlanmadi'}</p>
          </div>
        )}
        {result && typeof result.webhook_ok === 'boolean' && typeof result.message_enabled !== 'boolean' && (
          <p role="status" className={`text-sm ${result.webhook_ok ? 'text-emerald-700' : 'text-destructive'}`}>
            {result.webhook_ok ? 'Webhook ulandi: xabarlar va tugmalar yoqilgan.' : 'Webhook hali tasdiqlanmadi. Sozlamani tekshiring.'}
          </p>
        )}
      </div>
      <TelegramAlerts />
    </section>
  );
}
