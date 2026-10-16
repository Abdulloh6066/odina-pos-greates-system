import '@/styles/operations-workbench.css';
import React, { useEffect, useMemo, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { useOutletContext } from 'react-router-dom';
import { Banknote, CalendarDays, Search, Store, Tag, UserRound, WalletCards, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatUZS, formatNum } from '@/lib/pos';
import { formatUzbekistanDate, formatUzbekistanDateTime, shiftDateKey, uzbekistanDateKey, uzbekistanDateParts, uzbekistanMonthKey } from '@/lib/uzbekistan-time';
import PageHeader from '@/components/PageHeader';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const CATEGORY_LABELS = {
  shop_expense: 'Do‘kon xarajati',
  goods_payment: 'Tovarlarga pul',
  owner_withdrawal: 'Egasi olgan pul',
  other_expense: 'Boshqa chiqim',
};

const categoryOf = (movement) => movement.expense_category || 'other_expense';

export default function CashOutHistory() {
  const { user, adminShopScope } = useOutletContext();
  const shopScope = user?.role === 'admin' && adminShopScope?.isAdmin ? adminShopScope : null;
  const [movements, setMovements] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState('today');
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(() => uzbekistanMonthKey());
  const [localShop, setLocalShop] = useState('all');
  const selectedShop = shopScope?.shopId || localShop;
  const setSelectedShop = (value) => shopScope ? shopScope.selectShop(value) : setLocalShop(value);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedRecipient, setSelectedRecipient] = useState('all');

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const [cashOuts, shopList] = await Promise.all([
          base44.entities.CashMovement.list('-created_at', 300),
          base44.entities.Shop.list(),
        ]);
        if (active) {
          setMovements(cashOuts || []);
          setShops(shopList || []);
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, []);

  const visible = useMemo(() => {
    if (shopScope?.ready === false) return [];
    if (user?.role === 'admin' && shopScope?.specificShopId) return movements.filter((movement) => movement.shop_id === shopScope.specificShopId);
    if (['admin', 'manager'].includes(user?.role)) return movements;
    return movements.filter((movement) => movement.user_id === user?.id);
  }, [movements, user, shopScope]);

  const shopNames = useMemo(
    () => Object.fromEntries(shops.map((shop) => [shop.id, shop.name])),
    [shops],
  );
  const recipientNames = useMemo(() => (
    [...new Set(visible.map((movement) => movement.recipient_name_snapshot).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'uz'))
  ), [visible]);

  const filtered = useMemo(() => {
    const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const today = uzbekistanDateKey();
    const yesterday = shiftDateKey(today, -1);
    const weekStart = shiftDateKey(today, -6);

    return visible.filter((movement) => {
      const date = new Date(movement.created_at || movement.created_date);
      const dateKey = uzbekistanDateKey(date);
      const dateParts = uzbekistanDateParts(date) || { day: '', month: '', year: '' };
      const category = categoryOf(movement);
      if (selectedShop !== 'all' && movement.shop_id !== selectedShop) return false;
      if (selectedCategory !== 'all' && category !== selectedCategory) return false;
      if (selectedRecipient !== 'all' && movement.recipient_name_snapshot !== selectedRecipient) return false;
      if (selectedDate && dateKey !== selectedDate) return false;
      if (!selectedDate && period === 'today' && dateKey !== today) return false;
      if (!selectedDate && period === 'yesterday' && dateKey !== yesterday) return false;
      if (!selectedDate && period === 'week' && dateKey < weekStart) return false;
      if (!selectedDate && period === 'month' && dateKey.slice(0, 7) !== selectedMonth) return false;
      const { day, month, year } = dateParts;
      const haystack = [
        shopNames[movement.shop_id],
        movement.employee_name,
        movement.user_name,
        movement.reason,
        movement.amount,
        CATEGORY_LABELS[category],
        movement.recipient_name_snapshot,
        `${day}.${month}.${year}`,
        `${day}/${month}/${year}`,
        formatUzbekistanDate(date),
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [visible, search, shopNames, selectedShop, selectedDate, selectedMonth, selectedCategory, selectedRecipient, period]);

  const total = filtered.reduce((sum, movement) => sum + Number(movement.amount || 0), 0);
  const categoryTotals = useMemo(() => Object.keys(CATEGORY_LABELS).map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    total: filtered
      .filter((movement) => categoryOf(movement) === key)
      .reduce((sum, movement) => sum + Number(movement.amount || 0), 0),
  })), [filtered]);
  const ownerView = ['admin', 'manager'].includes(user?.role);

  return (
    <div className="odina-page odina-workbench odina-operations odina-cashouthistory p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader
        title="Kassadan pul olish tarixi"
        eyebrow="NAQD PUL JURNALI"
        subtitle={shopScope?.specificShopId
          ? `${shopScope.shops?.find((shop) => shop.id === shopScope.specificShopId)?.name || 'Tanlangan do‘kon'} · olingan naqd pullar`
          : ownerView ? 'Barcha do‘konlardan olingan naqd pullar' : 'Faqat sizning hisobingiz orqali olingan pullar'}
        icon={Banknote}
      />

      <div className="odina-operations-toolbar odina-panel rounded-2xl bg-card border border-border p-4 sm:p-5 mb-6 space-y-4">
        <div className="odina-toolbar-heading"><h2>Chiqimlarni saralash</h2><p>Davr, do‘kon va qabul qiluvchi bo‘yicha naqd pul harakatlarini ko‘ring.</p></div>
        <div className="odina-period-switch flex flex-wrap gap-2">
          {[
            ['today', 'Bugun'],
            ['yesterday', 'Kecha'],
            ['week', 'Oxirgi 7 kun'],
            ['month', 'Tanlangan oy'],
            ['all', 'Barcha vaqt'],
          ].map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={period === value && !selectedDate ? 'default' : 'outline'}
              onClick={() => { setPeriod(value); setSelectedDate(''); }}
              className={`min-h-11 rounded-xl touch-manipulation ${period === value && !selectedDate ? 'bg-primary text-primary-foreground hover:bg-primary-strong' : ''}`}
            >
              {label}
            </Button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Aniq kunni tanlang</span>
            <Input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
              className="h-11 rounded-xl bg-background"
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Oy</span>
            <Input
              type="month"
              value={selectedMonth}
              onChange={(event) => { setSelectedMonth(event.target.value); setSelectedDate(''); setPeriod('month'); }}
              className="h-11 rounded-xl bg-background"
            />
          </label>
          {ownerView && (
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Do‘kon</span>
              <OdinaSelect
                value={selectedShop}
                onChange={(event) => setSelectedShop(event.target.value)}
                className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="all">Barcha do‘konlar</option>
                {shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
              </OdinaSelect>
            </label>
          )}
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Chiqim turi</span>
            <OdinaSelect
              value={selectedCategory}
              onChange={(event) => setSelectedCategory(event.target.value)}
              className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">Barcha chiqimlar</option>
              {Object.entries(CATEGORY_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </OdinaSelect>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Kimga berildi</span>
            <OdinaSelect
              value={selectedRecipient}
              onChange={(event) => setSelectedRecipient(event.target.value)}
              className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">Barcha qabul qiluvchilar</option>
              {recipientNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </OdinaSelect>
          </label>
        </div>

        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            aria-label="Chiqim tarixi bo‘yicha qidirish"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Xodim, sabab, qabul qiluvchi yoki summa…"
            className="h-11 rounded-xl pl-10 pr-11 bg-background"
          />
          {search && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setSearch('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 h-9 w-9"
              aria-label="Qidiruvni tozalash"
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="odina-operations-metrics grid sm:grid-cols-2 mb-3">
        <div className="odina-operations-metric p-4">
          <p className="text-xs text-muted-foreground">Jami olingan naqd pul</p>
          <p className="text-2xl font-semibold mt-1">{formatUZS(total)}</p>
        </div>
        <div className="odina-operations-metric p-4">
          <p className="text-xs text-muted-foreground">Yozuvlar</p>
          <p className="text-2xl font-semibold mt-1">{formatNum(filtered.length)}</p>
        </div>
      </div>

      <div className="odina-operations-metrics odina-category-metrics grid grid-cols-2 lg:grid-cols-4 mb-6">
        {categoryTotals.map((item) => (
          <div key={item.key} className="odina-operations-metric p-3 sm:p-4">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="text-base sm:text-lg font-semibold mt-1">{formatUZS(item.total)}</p>
          </div>
        ))}
      </div>

      <div className="odina-operations-section-heading"><div><p className="odina-page-eyebrow">CHIQIMLAR</p><h2>Pul olish yozuvlari</h2></div><p>{formatNum(filtered.length)} ta yozuv · {formatUZS(total)}</p></div>
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-28 rounded-2xl bg-secondary animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="odina-panel rounded-2xl bg-card border border-border py-16 text-center">
          <Banknote className="w-9 h-9 mx-auto text-muted-foreground/50 mb-3" />
          <p className="font-medium">{search ? 'Mos yozuv topilmadi' : 'Hali kassadan pul olinmagan'}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {search ? 'Boshqa do‘kon, sana, xodim yoki sababni tanlang.' : 'Kassadan olingan pullar shu yerda ko‘rinadi.'}
          </p>
        </div>
      ) : (
        <div className="odina-ledger space-y-3">
          {filtered.map((movement) => {
            const date = new Date(movement.created_at || movement.created_date);
            const employee = movement.employee_name || movement.user_name || 'Noma’lum xodim';
            const category = categoryOf(movement);
            return (
              <div key={movement.id} className="odina-ledger-row odina-cashout-row odina-panel rounded-2xl bg-card border border-border p-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold break-words">{movement.reason}</p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium">
                        <Tag className="w-3 h-3" />{CATEGORY_LABELS[category]}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays className="w-3.5 h-3.5" />
                        {formatUzbekistanDateTime(date, { month: 'short' })}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <UserRound className="w-3.5 h-3.5" />{employee}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <Store className="w-3.5 h-3.5" />{shopNames[movement.shop_id] || 'Do‘kon'}
                      </span>
                      {movement.recipient_name_snapshot && (
                        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/75">
                          <WalletCards className="w-3.5 h-3.5" />Kimga: {movement.recipient_name_snapshot}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="odina-ledger-amount text-lg font-semibold text-brand-ink whitespace-nowrap">−{formatUZS(movement.amount)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
