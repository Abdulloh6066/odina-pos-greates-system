import React from 'react';
import OdinaSelect from '@/components/ui/odina-select';

export default function OrderFilterRail({ isAdmin, shops, filters, setters, typeOptions, statusOptions, payOptions }) {
  const fields = [
    ['Tur', filters.type, setters.type, typeOptions],
    ['Holat', filters.status, setters.status, statusOptions],
    ['To‘lov', filters.pay, setters.pay, payOptions],
  ];
  return <aside className="opl-rail">
    <h2 className="opl-rail-title">Filtrlar</h2>
    <div className="opl-field"><label>Qidiruv</label><input value={filters.query} onChange={(e) => setters.query(e.target.value)} placeholder="Nomer, mijoz, telefon" /></div>
    {isAdmin && <div className="opl-field"><label>Do‘kon</label><OdinaSelect value={filters.shop} onChange={(e) => setters.shop(e.target.value)}><option value="">Barcha do‘konlar</option>{shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</OdinaSelect></div>}
    {fields.map(([label, value, setter, options]) => <div className="opl-field" key={label}><label>{label}</label><OdinaSelect value={value} onChange={(e) => setter(e.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</OdinaSelect></div>)}
    <div className="opl-field"><label>Sana</label><input type="date" value={filters.date} onChange={(e) => setters.date(e.target.value)} /></div>
    <div className="opl-rail-divider" />
    <p className="opl-filter-note">Barcha maydonlar bo‘yicha buyurtmalarni tez toping.</p>
  </aside>;
}