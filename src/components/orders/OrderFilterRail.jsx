import React, { useState } from 'react';
import { Search, SlidersHorizontal, CalendarDays, List, X } from 'lucide-react';
import { uz } from 'date-fns/locale';
import OdinaSelect from '@/components/ui/odina-select';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { uzbekistanDateKey } from '@/lib/uzbekistan-time';

export default function OrderFilterRail({ isAdmin, shops, filters, setters, typeOptions, statusOptions, payOptions, onClear, hasFilters }) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const selectedDate = filters.date ? new Date(filters.date + 'T12:00:00') : undefined;
  const today = new Date(uzbekistanDateKey() + 'T12:00:00');
  const activeCount = [filters.shop, filters.type, filters.pay].filter(Boolean).length;
  const selectDate = (date) => {
    if (!date) return;
    setters.date([date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-'));
    setCalendarOpen(false);
  };

  return <div className="opl-filters">
    <label className="opl-search">
      <Search size={19} aria-hidden="true" />
      <span className="sr-only">Buyurtmani qidirish</span>
      <input type="search" value={filters.query} onChange={(e) => setters.query(e.target.value)}
        placeholder="Raqam, mijoz yoki telefon bo‘yicha qidirish" />
    </label>
    <div className="opl-status-filter">
      <OdinaSelect aria-label="Buyurtma holati" value={filters.status} onChange={(e) => setters.status(e.target.value)}>
        {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </OdinaSelect>
    </div>
    <div className="opl-view-switch" role="group" aria-label="Buyurtmalar sanasi">
      <button type="button" aria-pressed={!filters.date} onClick={() => { if (filters.date) setters.date(''); setCalendarOpen(false); }}>
        <List size={17} aria-hidden="true" /><span>Ro‘yxat</span>
      </button>
      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={filters.date ? 'is-active' : ''} aria-label={filters.date ? 'Sana bo‘yicha: ' + filters.date : 'Sana bo‘yicha tanlash'}>
            <CalendarDays size={17} aria-hidden="true" /><span>{filters.date ? filters.date.split('-').reverse().join('.') : 'Kalendar'}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="opl-calendar-popover w-auto rounded-xl border-border bg-card p-2">
          <p className="px-3 pt-2 text-sm font-semibold">Sana bo‘yicha buyurtmalar</p>
          <Calendar mode="single" locale={uz} selected={selectedDate} defaultMonth={selectedDate || today} today={today}
            onSelect={selectDate} initialFocus
            classNames={{ day: 'h-11 w-11 rounded-lg p-0 font-normal aria-selected:opacity-100', head_cell: 'w-11 text-center text-xs text-muted-foreground' }} />
          {filters.date && <button type="button" className="opl-popover-clear" onClick={() => { setters.date(''); setCalendarOpen(false); }}>
            <X size={15} aria-hidden="true" /> Sanani tozalash
          </button>}
        </PopoverContent>
      </Popover>
    </div>
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="opl-filter-trigger">
          <SlidersHorizontal size={17} aria-hidden="true" /> Filtrlar{activeCount > 0 && <span className="opl-tab-count">{activeCount}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="opl-filter-popover w-[min(400px,calc(100vw-24px))] rounded-xl border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Qo‘shimcha filtrlar</h2>
        <div className="opl-filter-fields">
          {isAdmin && <label>Do‘kon<OdinaSelect aria-label="Buyurtma do‘koni" value={filters.shop} onChange={(e) => setters.shop(e.target.value)}><option value="">Barcha do‘konlar</option>{shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</OdinaSelect></label>}
          <label>Tur<OdinaSelect aria-label="Buyurtma turi" value={filters.type} onChange={(e) => setters.type(e.target.value)}>{typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</OdinaSelect></label>
          <label>To‘lov<OdinaSelect aria-label="Buyurtma to‘lovi" value={filters.pay} onChange={(e) => setters.pay(e.target.value)}>{payOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</OdinaSelect></label>
        </div>
        {hasFilters && <button type="button" className="opl-popover-clear" onClick={onClear}>Filtrlarni tozalash</button>}
      </PopoverContent>
    </Popover>
    {hasFilters && <div className="opl-applied-filters">
      {filters.date && <span><CalendarDays size={14} aria-hidden="true" />{filters.date.split('-').reverse().join('.')}</span>}
      <button type="button" className="opl-clear" onClick={onClear}><X size={14} aria-hidden="true" /> Filtrlarni tozalash</button>
    </div>}
  </div>;
}

