import React from 'react';
import { Building2 } from 'lucide-react';
import OdinaSelect from '@/components/ui/odina-select';
import '@/styles/admin-shop-scope.css';

const SHARED_NOTES = {
  '/customers': 'Mijozlar ro‘yxati barcha do‘konlar uchun umumiy.',
  '/categories': 'Kategoriyalar umumiy katalogga tegishli. Do‘kondagi ko‘rinish alohida belgilanadi.',
  '/discounts': 'Chegirma kodlari barcha do‘konlar uchun umumiy.',
  '/cash-recipients': 'Qabul qiluvchilar ro‘yxati barcha do‘konlar uchun umumiy.',
  '/security': 'Xavfsizlik va hisob ruxsatlari barcha do‘konlar uchun umumiy.',
};

export default function AdminShopSwitcher({ scope, pathname = '' }) {
  if (!scope?.isAdmin) return null;
  const selected = scope.shops.find((shop) => shop.id === scope.shopId);
  const name = scope.shopId === 'all' ? 'Barcha do‘konlar' : selected?.name || 'Tanlangan do‘kon';
  return <section className="odina-global-shop-bar" aria-label="Umumiy do‘kon tanlash">
    <div className="odina-global-shop-heading"><Building2 aria-hidden="true" /><label htmlFor="admin-global-shop">Do‘kon</label></div>
    <div className="odina-global-shop-picker">
      <OdinaSelect id="admin-global-shop" aria-label="Barcha bo‘limlar uchun do‘kon" value={scope.shopId}
        disabled={!scope.ready} onChange={(event) => scope.selectShop(event.target.value)} placeholder={name}>
        <option value="all">Barcha do‘konlar</option>
        {scope.shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
      </OdinaSelect>
    </div>
    <div className="odina-global-shop-description" aria-live="polite">
      <strong>{scope.ready ? name : scope.error ? 'Do‘konlar yuklanmadi' : 'Do‘konlar yuklanmoqda…'}</strong>
      <span>{SHARED_NOTES[pathname] || 'Tanlov boshqa bo‘limlarda ham saqlanadi.'}</span>
    </div>
    {scope.error && <div className="odina-global-shop-notice" role="alert"><span>{scope.error}</span><button type="button" onClick={scope.reload}>Qayta yuklash</button></div>}
    {scope.blockedReason && <p className="odina-global-shop-notice" role="alert">{scope.blockedReason}</p>}
  </section>;
}
