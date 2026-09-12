import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';

export default function TelegramSetup({ user }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  if ((user?.role || user?.data?.role) !== 'admin') return null;

  const inspect = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await base44.functions.invoke('telegram-setup', {});
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
      <p className="text-sm text-muted-foreground">Odina-Ish Jarayoni guruhiga /start@Odina_nazorat_bot yuboring, keyin guruhni aniqlang.</p>
      <Button className="min-h-11 rounded-xl w-full sm:w-auto" onClick={inspect} disabled={busy}>
        {busy ? 'Tekshirilmoqda…' : 'Telegram guruhini aniqlash'}
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
          )) : <p className="text-sm text-muted-foreground">Guruh buyrug‘i topilmadi. Buyruqni guruhning o‘ziga yana yuboring va qayta tekshiring.</p>}
          <p className="text-xs text-muted-foreground">Bu faqat ulanish tekshiruvi. Avtomatik xabarlar hali yoqilmagan. Kerakli guruh nomi va Chat ID raqamini tekshiring.</p>
        </>}
      </div>
    </section>
  );
}
