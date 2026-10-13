import React from 'react';
import { Plus } from 'lucide-react';

export default function OrderLedgerHero({ onCreate }) {
  return <header className="opl-header">
    <div>
      <div className="opl-eyebrow">MIJOZLAR BILAN ISHLASH</div>
      <h1>Buyurtmalar</h1>
      <p>Tayyorlash navbati, topshirish vaqti va to‘lovlar — bir joyda.</p>
    </div>
    <button type="button" className="opl-primary" onClick={onCreate}>
      <Plus size={19} aria-hidden="true" /> Yangi buyurtma
    </button>
  </header>;
}

