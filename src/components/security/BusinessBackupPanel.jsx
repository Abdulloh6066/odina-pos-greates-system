import React, { useState } from 'react';
import { Download, Loader2, ShieldCheck } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { odinaAlert } from '@/lib/odina-dialog';
import { collectBusinessBackup, downloadBusinessBackup, BACKUP_ENTITIES } from '@/lib/read-only-backup';

export default function BusinessBackupPanel({ user }) {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState('');

  if (user?.role !== 'admin' || user?.active === false) return null;

  const download = async () => {
    if (exporting) return;
    setExporting(true);
    setProgress('Boshlanmoqda…');
    try {
      // The SDK enforces each entity's admin-only read rules. Never use a
      // privileged service-role endpoint or transmit the archive elsewhere.
      const archive = await collectBusinessBackup(base44.entities, {
        onProgress: (name, count) => setProgress(`${name}: ${count} yozuv tekshirildi`),
      });
      const filename = downloadBusinessBackup(archive);
      await odinaAlert(`${filename} yuklab olindi. Faylni xavfsiz joyda saqlang. JSON arxivni avtomatik tiklash hozircha mavjud emas.`);
    } catch (error) {
      void odinaAlert(`Zaxira yaratilmadi: ${error?.message || error}. To‘liq bo‘lmagan fayl yuklanmadi.`);
    } finally {
      setExporting(false);
      setProgress('');
    }
  };

  return (
    <section className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-brand-ink" />
        <h2 className="font-display text-lg font-bold">Biznes ma’lumotlarini zaxiralash</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Mahsulot, ombor, retsept, savdo, smena, to‘lov va moliyaviy tarixni {BACKUP_ENTITIES.length} ta biznes jadvalidan o‘qib, kompyuteringizga JSON arxiv sifatida yuklaydi. Bazaga hech narsa yozilmaydi.
      </p>
      <p className="text-xs text-muted-foreground">
        Faylda mijozlar va moliyaviy ma’lumotlar bor: uni maxfiy saqlang. Parol, PIN, token va xodim akkauntlari saqlanadigan maxfiy jadvallar eksport qilinmaydi. Bu avtomatik tiklash tizimi emas. Izchil nusxa uchun eksport vaqtida savdolarni vaqtincha to‘xtating.
      </p>
      {progress && <p role="status" className="text-sm text-brand-ink">{progress}</p>}
      <Button type="button" onClick={download} disabled={exporting} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong">
        {exporting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
        {exporting ? 'Zaxira tayyorlanmoqda…' : 'Zaxira nusxani yuklab olish'}
      </Button>
    </section>
  );
}
