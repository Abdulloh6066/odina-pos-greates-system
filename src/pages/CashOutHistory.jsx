import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Banknote, CalendarDays, Search, Store, UserRound, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatUZS, formatNum } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export default function CashOutHistory() {
  const { user } = useOutletContext();
  const [movements, setMovements] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

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
    if (user?.role === 'admin') return movements;
    return movements.filter((movement) => movement.user_id === user?.id);
  }, [movements, user]);

  const shopNames = useMemo(
    () => Object.fromEntries(shops.map((shop) => [shop.id, shop.name])),
    [shops],
  );
  const filtered = useMemo(() => {
    const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return visible;

    return visible.filter((movement) => {
      const date = new Date(movement.created_at || movement.created_date);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      const haystack = [
        shopNames[movement.shop_id],
        movement.employee_name,
        movement.user_name,
        movement.reason,
        movement.amount,
        `${day}.${month}.${year}`,
        `${day}/${month}/${year}`,
        date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [visible, search, shopNames]);

  const total = filtered.reduce((sum, movement) => sum + Number(movement.amount || 0), 0);
  const ownerView = user?.role === 'admin';

  return (
    <div className="p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader
        title="Cash-out History"
        subtitle={ownerView ? 'Cash removed from every shop' : 'Cash removed by your account only'}
        icon={Banknote}
      />

      <div className="relative mb-4">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search shop, date, employee or reason…"
          className="h-12 rounded-xl pl-10 pr-11 bg-card"
        />
        {search && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setSearch('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-9 w-9"
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-4">Example: Odina Central 14.07.2026</p>

      <div className="grid sm:grid-cols-2 gap-3 mb-6">
        <div className="rounded-2xl bg-card border border-border premium-shadow p-4">
          <p className="text-xs text-muted-foreground">Total cash removed</p>
          <p className="text-2xl font-semibold mt-1">{formatUZS(total)}</p>
        </div>
        <div className="rounded-2xl bg-card border border-border premium-shadow p-4">
          <p className="text-xs text-muted-foreground">Records</p>
          <p className="text-2xl font-semibold mt-1">{formatNum(filtered.length)}</p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-28 rounded-2xl bg-secondary animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl bg-card border border-border py-16 text-center">
          <Banknote className="w-9 h-9 mx-auto text-muted-foreground/50 mb-3" />
          <p className="font-medium">{search ? 'No matching cash-outs' : 'No cash-outs yet'}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {search ? 'Try a different shop, date, employee or reason.' : 'Cash removed from the drawer will appear here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((movement) => {
            const date = new Date(movement.created_at || movement.created_date);
            const employee = movement.employee_name || movement.user_name || 'Unknown user';
            return (
              <div key={movement.id} className="rounded-2xl bg-card border border-border premium-shadow p-4 sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-semibold break-words">{movement.reason}</p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarDays className="w-3.5 h-3.5" />
                        {date.toLocaleString('en-GB', {
                          day: '2-digit', month: 'short', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <UserRound className="w-3.5 h-3.5" />{employee}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <Store className="w-3.5 h-3.5" />{shopNames[movement.shop_id] || 'Shop'}
                      </span>
                    </div>
                  </div>
                  <p className="text-lg font-semibold text-amber-700 whitespace-nowrap">−{formatUZS(movement.amount)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
