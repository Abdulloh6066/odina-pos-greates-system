import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, BarChart3, Boxes, Cake, Clock, LockKeyhole, ReceiptText, Settings, ShieldCheck, Users, WalletCards } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { useAdminAccess } from '@/components/admin/AdminAccessProvider';

const TOOLS = [
  { title: 'Xodimlar', description: 'Jamoa, lavozimlar va ish joylari.', path: '/users', icon: Users },
  { title: 'Xavfsizlik', description: 'Ruxsatlar, tasdiqlash PIN kodi va amallar tarixi.', path: '/security', icon: ShieldCheck },
  { title: 'Mahsulotlar va narxlar', description: 'Mahsulotlar, retseptlar va sotuv narxlari.', path: '/3d-plus', icon: Cake },
  { title: 'Ombor', description: 'Qoldiqlar, kirimlar va mahsulot harakati.', path: '/warehouse', icon: Boxes },
  { title: 'Hisobotlar', description: 'Savdo natijalari va do‘konlar ko‘rsatkichlari.', path: '/reports', icon: BarChart3 },
  { title: 'Budget', description: 'Moliyaviy hisoblar va pul harakati.', path: '/budget', icon: WalletCards },
  { title: 'Savdolar tarixi', description: 'Tasdiqlangan savdolar va to‘lovlar.', path: '/sales', icon: ReceiptText },
  { title: 'Smenalar', description: 'Kassa smenalari va yakuniy hisoblar.', path: '/shifts', icon: Clock },
  { title: 'Sozlamalar', description: 'Do‘kon, chek va tizim sozlamalari.', path: '/settings', icon: Settings },
];

export default function AdminPanel() {
  const { unlocked, requestOpen, checkSession, lock } = useAdminAccess();
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    let active = true;
    setVerified(false);
    if (unlocked) void checkSession().then((valid) => { if (active) setVerified(valid); });
    return () => { active = false; };
  }, [unlocked, checkSession]);

  return (
    <div className="odina-page p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader title="Admin panel" eyebrow="BOSHQARUV MARKAZI" icon={ShieldCheck}
        subtitle="Odina POS · Egasi / Admin boshqaruvi"
        actions={<>
          <Button variant="outline" asChild className="min-h-11 rounded-xl gap-2"><Link to="/pos"><ArrowLeft className="h-4 w-4" />Kassaga qaytish</Link></Button>
          {unlocked && <Button variant="outline" onClick={lock} className="min-h-11 rounded-xl gap-2"><LockKeyhole className="h-4 w-4" />Qulflash</Button>}
        </>} />
      {!unlocked ? (
        <section className="odina-panel rounded-2xl border border-border bg-card p-6 sm:p-10 text-center max-w-xl mx-auto space-y-4">
          <LockKeyhole className="h-9 w-9 mx-auto text-brand-olive" />
          <h2 className="text-xl font-semibold">Admin panel qulflangan</h2>
          <p className="text-sm text-muted-foreground">Davom etish uchun admin parolini kiriting. Kirish uchun internet aloqasi kerak.</p>
          <Button onClick={() => void requestOpen()} className="min-h-12 rounded-xl px-6">Parol bilan ochish</Button>
          <p className="text-xs text-muted-foreground">Klaviaturada: Ctrl + Alt + A</p>
        </section>
      ) : !verified ? (
        <p role="status" className="py-12 text-center text-muted-foreground">Admin ruxsati tekshirilmoqda…</p>
      ) : (
        <div className="space-y-5">
          <div className="rounded-2xl border border-brand-olive/30 bg-brand-olive/10 px-5 py-4 flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
            <div><p className="font-semibold">Admin kirishi tasdiqlandi</p><p className="text-sm text-muted-foreground mt-1">5 daqiqa harakatsizlikdan so‘ng yoki 15 daqiqada qayta qulflanadi. Amaldagi lavozim ruxsatlari saqlanadi.</p></div>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {TOOLS.map(({ title, description, path, icon: Icon }) => (
              <Link key={path} to={path} className="group odina-panel rounded-2xl border border-border bg-card p-5 sm:p-6 min-h-44 hover:border-brand-olive/60 hover:bg-secondary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-olive">
                <div className="flex items-center justify-between mb-5"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-sand/20"><Icon className="h-5 w-5" /></span><ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" /></div>
                <h2 className="font-semibold text-lg">{title}</h2><p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
