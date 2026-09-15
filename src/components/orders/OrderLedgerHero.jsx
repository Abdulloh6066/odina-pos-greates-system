import React from 'react';
import { Image } from '@/components/ui/image';

const HERO_IMAGE = 'https://media.base44.com/images/public/6a96eb22a9fd2b34081eb2dd/667ccb0c6_generated_1d85a533.jpg';

export default function OrderLedgerHero({ user, onCreate }) {
  const name = user?.full_name || user?.email || 'Operator';
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const date = new Intl.DateTimeFormat('uz-UZ', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  return <>
    <header className="opl-topbar">
      <div className="opl-brand"><div className="opl-brand-mark">O</div><div className="opl-brand-copy">Buyurtmalar</div></div>
      <div className="opl-top-actions"><span className="opl-top-date">{date}</span><span className="opl-operator">{name}</span><div className="opl-avatar">{initials || 'OP'}</div></div>
    </header>
    <section className="opl-hero">
      <div className="opl-hero-copy"><div className="opl-eyebrow">Buyurtmalar</div><h1>Buyurtmalar</h1><p>Buyurtmalarni qabul qiling, to‘lovlarni kuzating.</p><button type="button" className="opl-primary" onClick={onCreate}>＋ Yangi buyurtma</button></div>
      <Image className="opl-hero-image" src={HERO_IMAGE} fittingType="fill" alt="Qutilarga joylangan bayram tortlari" />
    </section>
  </>;
}