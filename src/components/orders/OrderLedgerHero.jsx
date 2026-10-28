import React from 'react';
import { Plus } from 'lucide-react';

export default function OrderLedgerHero({ onCreate }) {
  return <div className="opl-create">
    <h1 className="sr-only">Buyurtmalar</h1>
    <button type="button" className="opl-primary" onClick={onCreate}>
      <Plus size={19} aria-hidden="true" /> Yangi buyurtma
    </button>
  </div>;
}

