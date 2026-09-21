import React, { useMemo, useState } from 'react';
import { Armchair, Link2, Loader2, Unlink2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatUZS } from '@/lib/pos';

export default function TableGroupDialog({
  open,
  onClose,
  shop,
  tableNumber,
  group,
  hasOpenOrder,
  onChanged,
}) {
  const [selectedNumber, setSelectedNumber] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const currentNumbers = group?.numbers || [tableNumber];
  const candidates = useMemo(() => {
    const groupedElsewhere = new Set(
      (shop?.groups || [])
        .filter((row) => row.id !== group?.id)
        .flatMap((row) => row.numbers || []),
    );
    return Array.from({ length: shop?.table_count || 0 }, (_, index) => index + 1)
      .filter((number) => !currentNumbers.includes(number) && !groupedElsewhere.has(number))
      .map((number) => {
        const order = (shop?.orders || []).find((row) => row.number === number);
        return { number, order, occupied: Boolean(order) };
      });
  }, [shop, group?.id, currentNumbers.join(',')]);

  const handleOpenChange = (nextOpen) => {
    if (!nextOpen && !saving) {
      setSelectedNumber(null);
      setError('');
      onClose();
    }
  };

  const joinTable = async () => {
    if (!selectedNumber || saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'group_tables',
        shop_id: shop.id,
        primary_table_number: group?.numbers?.[0] || tableNumber,
        secondary_table_number: selectedNumber,
      });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Stollar birlashtirilmadi.');
      onChanged(result.shop, result.group);
      setSelectedNumber(null);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Stollarni birlashtirib bo‘lmadi.');
    } finally {
      setSaving(false);
    }
  };

  const ungroupTables = async () => {
    if (!group || hasOpenOrder || saving) return;
    setSaving(true);
    setError('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'ungroup_tables',
        shop_id: shop.id,
        primary_table_number: group.numbers[0],
      });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Stollar ajratilmadi.');
      onChanged(result.shop, null);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Stollarni ajratib bo‘lmadi.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl p-0 overflow-hidden">
        <DialogHeader className="border-b border-border bg-brand-surface px-5 py-5">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-olive/15 text-brand-ink">
              <Link2 className="h-5 w-5" />
            </span>
            Stol qo‘shish
          </DialogTitle>
          <DialogDescription>
            {currentNumbers.join(' + ')}-stolga yana bitta stol ulang. Ular bitta umumiy hisob sifatida ishlaydi.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto p-4 sm:p-5">
          {error && (
            <div role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {candidates.map(({ number, order, occupied }) => {
              const selected = selectedNumber === number;
              const blocked = hasOpenOrder && occupied;
              return (
                <button
                  key={number}
                  type="button"
                  disabled={saving || blocked}
                  onClick={() => setSelectedNumber(number)}
                  className={`min-h-28 rounded-2xl border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
                    selected
                      ? 'border-brand-olive bg-[#FECD7C]/35 ring-2 ring-brand-olive/25'
                      : 'border-border bg-card hover:border-brand-olive/60 hover:bg-brand-olive/5'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-display font-bold">
                      <Armchair className="h-4 w-4 text-brand-ink" />
                      {number}-stol
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      occupied ? 'bg-[#FECD7C]/50 text-brand-ink' : 'bg-emerald-100 text-emerald-800'
                    }`}>
                      {occupied ? 'Band' : 'Bo‘sh'}
                    </span>
                  </span>
                  <span className="mt-4 block text-xs text-muted-foreground">
                    {blocked
                      ? 'Avval bittasining hisobini yoping'
                      : occupied
                        ? formatUZS(order?.total || 0)
                        : 'Birlashtirish mumkin'}
                  </span>
                </button>
              );
            })}
          </div>

          {candidates.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border p-7 text-center text-sm text-muted-foreground">
              Qo‘shish mumkin bo‘lgan boshqa stol yo‘q.
            </div>
          )}

          {group && (
            <div className="mt-5 rounded-2xl border border-brand-olive/25 bg-brand-olive/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">{group.numbers.join(' + ')}-stollar birlashtirilgan</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {hasOpenOrder
                      ? 'Hisob yopilganda stollar avtomatik ajraladi.'
                      : 'Buyurtma hali ochilmagan — hozir ajratish mumkin.'}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={hasOpenOrder || saving}
                  onClick={ungroupTables}
                  className="shrink-0"
                >
                  <Unlink2 className="h-4 w-4" />
                  Ajratish
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-border bg-card px-4 py-3 sm:justify-end sm:px-5">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving} className="flex-1 sm:flex-none">
            Bekor
          </Button>
          <Button type="button" onClick={joinTable} disabled={!selectedNumber || saving} className="flex-[1.4] sm:min-w-48 sm:flex-none">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            Birlashtirish
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
