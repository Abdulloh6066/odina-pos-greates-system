import React, { useMemo, useState } from 'react';
import { CalendarDays, ChefHat, ClipboardList, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useShopDemand } from '@/components/shop-demand/useShopDemand';
import ShopDemandCard from '@/components/shop-demand/ShopDemandCard';
import { aggregateByProduct, displayDate, groupByDateAndShop } from '@/lib/shop-demand';
import { formatNum } from '@/lib/pos';

export default function DemandSection({ user, products }) {
  const { requests, itemsByRequest, loading, error, reload, accept, progress, send, cancel, safe } = useShopDemand(user);
  const [tab, setTab] = useState('list'); // list | summary

  const groups = useMemo(() => groupByDateAndShop(requests, itemsByRequest), [requests, itemsByRequest]);
  const summary = useMemo(() => aggregateByProduct(requests, itemsByRequest), [requests, itemsByRequest]);

  return (
    <section className="mt-8">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <ClipboardList className="w-5 h-5 text-brand-olive" />
        <h2 className="font-display text-lg sm:text-xl font-semibold">Do'kon talablari</h2>
        <span className="text-xs font-medium bg-secondary text-muted-foreground rounded-full px-2 py-0.5">{requests.length}</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-border bg-card overflow-hidden">
            <button type="button" onClick={() => setTab('list')} className={`px-3 h-10 text-sm font-medium touch-manipulation ${tab === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}>Ro'yxat</button>
            <button type="button" onClick={() => setTab('summary')} className={`px-3 h-10 text-sm font-medium touch-manipulation ${tab === 'summary' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'}`}>Mahsulot bo'yicha</button>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={reload} className="min-h-10 rounded-xl touch-manipulation">
            <RefreshCw className="w-4 h-4" /> Yangilash
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="w-6 h-6 animate-spin text-brand-olive mr-2" /> Yuklanmoqda…
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800 text-sm">{error}</div>
      ) : requests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/60 py-8 px-4 text-center">
          <ClipboardList className="w-9 h-9 text-brand-olive/50 mx-auto mb-2" />
          <p className="text-sm font-medium">Hozircha do'kon talablari yo'q</p>
          <p className="text-xs text-muted-foreground mt-1">Do'konlar talab yuborganda shu yerda chiqadi.</p>
        </div>
      ) : tab === 'summary' ? (
        <div className="rounded-2xl border border-border bg-card premium-shadow overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border bg-secondary/40 flex items-center gap-2">
            <ChefHat className="w-4 h-4 text-brand-olive" />
            <h3 className="text-sm font-semibold">Ishlab chiqarish rejasi (talablar)</h3>
            <span className="ml-auto text-xs text-muted-foreground">{summary.length} ta mahsulot</span>
          </div>
          <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {summary.map((g) => (
              <div key={g.product_id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium truncate">{g.name}</p>
                  <span className="text-sm font-bold text-brand-ink whitespace-nowrap">{formatNum(g.total)} {g.unit}</span>
                </div>
                <div className="mt-2 space-y-1">
                  {Object.entries(g.byShop).map(([shopId, s]) => (
                    <div key={shopId} className="flex items-center justify-between text-xs">
                      <span className="truncate text-muted-foreground">{s.shop_name}</span>
                      <span className="whitespace-nowrap">
                        <b className="text-foreground">{formatNum(s.requested)}</b>
                        {s.remaining > 0 && <span className="text-rose-600"> · qoldi {formatNum(s.remaining)}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={`${g.date}|${g.shop_id}`}>
              <div className="mb-2 flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-brand-olive" />
                <h3 className="font-display text-base font-semibold">{displayDate(g.date)} · {g.shop_name}</h3>
                <span className="text-xs font-medium bg-secondary text-muted-foreground rounded-full px-2 py-0.5">{g.requests.length} ta talab</span>
              </div>
              <div className="grid xl:grid-cols-2 gap-3">
                {g.requests.map((r) => (
                  <ShopDemandCard
                    key={r.id}
                    request={r}
                    user={user}
                    actions={{ accept, progress, send, cancel }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}