import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Banknote, CalendarDays, Store, UserRound } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatUZS, formatNum } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';

export default function CashOutHistory() {
  const { user } = useOutletContext();
  const [movements, setMovements] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);

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
  const total = visible.reduce((sum, movement) => sum + Number(movement.amount || 0), 0);
  const ownerView = user?.role === 'admin';

  return (
    <div className="p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader
        title="Cash-out History"
        subtitle={ownerView ? 'Cash removed from every shop' : 'Cash removed by your account only'}
        icon={Banknote}
      />

      <div className="grid sm:grid-cols-2 gap-3 mb-6">
        <div className="rounded-2xl bg-card border border-border premium-shadow p-4">
          <p className="text-xs text-muted-foreground">Total cash removed</p>
          <p className="text-2xl font-semibold mt-1">{formatUZS(total)}</p>
        </div>
        <div className="rounded-2xl bg-card border border-border premium-shadow p-4">
          <p className="text-xs text-muted-foreground">Records</p>
          <p className="text-2xl font-semibold mt-1">{formatNum(visible.length)}</p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-28 rounded-2xl bg-secondary animate-pulse" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl bg-card border border-border py-16 text-center">
          <Banknote className="w-9 h-9 mx-auto text-muted-foreground/50 mb-3" />
          <p className="font-medium">No cash-outs yet</p>
          <p className="text-sm text-muted-foreground mt-1">Cash removed from the drawer will appear here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((movement) => {
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
