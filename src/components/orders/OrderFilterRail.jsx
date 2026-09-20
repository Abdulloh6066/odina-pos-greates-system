import React from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import OdinaSelect from '@/components/ui/odina-select';

export default function OrderFilterRail({ isAdmin, shops, filters, setters, typeOptions, statusOptions, payOptions, onClear, hasFilters }) {
  return <div className="opl-filters">
    <div className="opl-search-row">
      <label className="opl-search">
        <Search size={19} aria-hidden="true" />
        <span className="sr-only">Buyurtmani qidirish</span>
        <input type="search" value={filters.query} onChange={(e) => setters.query(e.target.value)}
          placeholder="Raqam, mijoz yoki telefon bo‘yicha qidirish" />
      </label>
      <label className="opl-date">
        <span>Sana bo‘yicha</span>
        <input type="date" value={filters.date} onChange={(e) => setters.date(e.target.value)} />
      </label>
    </div>
    <details className="opl-more-filters">
      <summary><SlidersHorizontal size={17} aria-hidden="true" /> Qo‘shimcha filtrlar{hasFilters && <span className="opl-filter-dot" />}</summary>
      <div className="opl-filter-fields">
        {isAdmin && <label>Do‘kon<OdinaSelect value={filters.shop} onChange={(e) => setters.shop(e.target.value)}><option value="">Barcha do‘konlar</option>{shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</OdinaSelect></label>}
        <label>Tur<OdinaSelect value={filters.type} onChange={(e) => setters.type(e.target.value)}>{typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</OdinaSelect></label>
        <label>Holat<OdinaSelect value={filters.status} onChange={(e) => setters.status(e.target.value)}>{statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</OdinaSelect></label>
        <label>To‘lov<OdinaSelect value={filters.pay} onChange={(e) => setters.pay(e.target.value)}>{payOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</OdinaSelect></label>
      </div>
    </details>
    {hasFilters && <button type="button" className="opl-clear" onClick={onClear}>Filtrlarni tozalash</button>}
  </div>;
}
