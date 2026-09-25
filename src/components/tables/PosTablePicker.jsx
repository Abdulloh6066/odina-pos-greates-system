import React, { useEffect, useState } from 'react';
import { Armchair, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import TableFloorplan from './TableFloorplan';
import TableDetailSheet from './TableDetailSheet';

// The POS picker shows only the authenticated active shop. Layout and table
// orders still come from the same server status used by the Stollar page.
export default function PosTablePicker({ open, onOpenChange, activeShopId, onSelect }) {
  const [shop, setShop] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inspectedNumber, setInspectedNumber] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError('');
    base44.functions.invoke('restaurant-tables', { action: 'status' })
      .then((response) => {
        if (!active) return;
        const result = response?.data || response;
        setShop((result?.shops || []).find((item) => item.id === activeShopId) || null);
      })
      .catch((err) => {
        if (!active) return;
        setShop(null);
        setError(err?.response?.data?.error || err?.message || 'Stollarni yuklab bo‘lmadi.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, activeShopId, refreshKey]);

  const inspectTable = (_shopId, number) => {
    onOpenChange(false);
    setInspectedNumber(number);
  };

  const closeDetail = () => {
    setInspectedNumber(null);
    onOpenChange(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex flex-col gap-0 w-[calc(100%_-_1rem)] max-w-[1200px] max-h-[calc(100dvh-1rem)] p-0 overflow-hidden rounded-[26px]">
          <DialogHeader className="shrink-0 border-b border-border px-4 sm:px-6 py-4 bg-brand-surface">
            <DialogTitle className="flex items-center gap-2 font-display text-xl sm:text-2xl">
              <Armchair className="h-5 w-5 text-brand-ink" /> Stollar
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {shop?.name || 'Faol do‘kon'} · Stolni bosing va buyurtmani davom ettiring.
            </p>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-3 sm:p-5">
            {loading ? (
              <div role="status" className="h-64 flex items-center justify-center text-muted-foreground">Stollar yuklanmoqda…</div>
            ) : error ? (
              <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive">
                {error}
                <Button type="button" variant="outline" className="ml-3" onClick={() => setRefreshKey((value) => value + 1)}>
                  <RefreshCw className="h-4 w-4 mr-1" /> Qayta yuklash
                </Button>
              </div>
            ) : !shop || !shop.table_count ? (
              <p className="rounded-xl border border-border p-6 text-center text-muted-foreground">
                Bu do‘konda stol sozlanmagan yoki faol smena yo‘q.
              </p>
            ) : (
              <TableFloorplan key={`${shop.id}:${shop.layout_version}:${shop.table_count}`}
                shop={shop} canManage={false} pickerOnly onOpen={inspectTable} />
            )}
          </div>
        </DialogContent>
      </Dialog>
      {shop && <TableDetailSheet
        open={Boolean(inspectedNumber)}
        onClose={closeDetail}
        tableNumber={inspectedNumber}
        shop={shop}
        onOpenPos={(number) => { setInspectedNumber(null); onSelect(shop.id, number, false); }}
        onPayDirect={(number) => { setInspectedNumber(null); onSelect(shop.id, number, true); }}
        onShopChanged={(updatedShop) => setShop(updatedShop)}
      />}
    </>
  );
}
