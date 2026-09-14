import React from 'react';
import { ShieldCheck, Lock, KeyRound, Users } from 'lucide-react';

export default function SecurityPosture({ users, pinSet }) {
  const active = users.filter((u) => u.active !== false).length;
  const inactive = users.length - active;
  const cards = [
    { icon: Lock, label: "Ma'lumotlar himoyasi", value: 'RLS siyosatlari', note: 'Muhim jadvallar rol va do‘kon bo‘yicha cheklangan', ok: true },
    { icon: ShieldCheck, label: 'Rol asosli kirish', value: 'Frontend + backend', note: 'Sahifa va muhim amallar alohida tekshiriladi', ok: true },
    { icon: KeyRound, label: 'Egasi PIN kodi', value: pinSet ? "O'rnatilgan" : "O'rnatilmagan", note: pinSet ? 'Tasdiqlash PIN xavfsiz saqlangan' : "Himoyalangan amallar uchun PIN o'rnating", ok: pinSet },
    { icon: Users, label: 'Xodimlar holati', value: active + ' ta faol', note: inactive ? inactive + " ta o'chirilgan" : 'Barchasi faol', ok: true },
  ];
  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div key={c.label} className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4">
            <div className="flex items-start gap-3">
              <div className={'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ' + (c.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}>
                <Icon className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className="font-display text-base font-bold truncate mt-0.5">{c.value}</p>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5">{c.note}</p>
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}