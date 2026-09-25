import React, { useState } from 'react';
import { Trash2, Loader2, ShieldCheck } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';

export default function DataCleanupPanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const cleanup = async () => {
    const phrase = window.prompt(
      'Bu test mahsulotlari, qoldiqlar, savdo/buyurtmalar, smenalar, transferlar va mijozlarni o‘chiradi. Davom etish uchun TOZALASH deb yozing.',
    );
    if (phrase !== 'TOZALASH') return;
    if (!window.confirm('Test biznes ma’lumotlarini qaytarib bo‘lmaydigan tarzda o‘chirishni tasdiqlaysizmi?')) return;

    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await base44.functions.invoke('cleanup-test-business-data', {
        scope: 'test_business_data',
        confirm: 'TOZALASH',
      });
      const data = response?.data || response;
      setResult(data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Tozalash yakunlanmadi. Hech narsa kiritmasdan oldin Admin bilan tekshiring.');
    } finally {
      setBusy(false);
    }
  };

  const clearPrelaunchSales = async () => {
    const phrase = window.prompt('39 ta sotuv, 3 ta ochiq smena va ularga bog‘liq tarix o‘chiriladi. Mahsulot va qoldiqlar saqlanadi. SOTUVNI_TOZALASH deb yozing.');
    if (phrase !== 'SOTUVNI_TOZALASH') return;
    if (!window.confirm('Sotuv va smenalarni doimiy o‘chirishni tasdiqlaysizmi?')) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await base44.functions.invoke('clear-prelaunch-sales', {
        scope: 'prelaunch_sales_shifts',
        confirm: 'SOTUVNI_TOZALASH',
      });
      const data = response?.data || response;
      setResult({ ...data, total_deleted: Object.values(data.deleted || {}).reduce((sum, count) => sum + count, 0) });
    } catch (e) {
      setError(e?.response?.data?.error || 'Tozalash yakunlanmadi. Qoldiq yozuvlarni tekshiring.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 space-y-3">
      <div className="flex items-start gap-3">
        <Trash2 className="w-5 h-5 text-destructive mt-0.5" />
        <div>
          <h2 className="font-display text-lg font-bold">Bir martalik test ma’lumotlarini tozalash</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Mahsulot, kategoriya, ingredient, tex-karta, qoldiq, savdo, buyurtma, smena, transfer,
            supplier hujjatlari, mijoz va test Telegram tarixini o‘chiradi.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
        <span>Admin hisoblari, do‘konlar, RLS/PIN, Telegram sozlamasi, workflow va xavfsizlik auditi saqlanadi.</span>
      </div>
      <Button variant="destructive" onClick={cleanup} disabled={busy} className="min-h-11 rounded-xl">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        {busy ? 'Tozalanmoqda…' : 'Test ma’lumotlarini tozalash'}
      </Button>
      <Button variant="outline" onClick={clearPrelaunchSales} disabled={busy} className="min-h-11 rounded-xl">
        Sotuv va smenalarni tozalash (mahsulotlar saqlanadi)
      </Button>
      {result?.ok && (
        <p role="status" className="text-sm font-medium text-emerald-700">
          Tozalandi: {Number(result.total_deleted || 0)} ta yozuv. Endi real ma’lumotlarni kiritish mumkin.
        </p>
      )}
      {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
    </section>
  );
}
