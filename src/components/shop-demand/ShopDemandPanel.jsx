import React, { useMemo, useState } from 'react';
import { ClipboardList, Loader2, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import OdinaSelect from '@/components/ui/odina-select';
import ShopDemandCard from '@/components/shop-demand/ShopDemandCard';
import ShopDemandForm from '@/components/shop-demand/ShopDemandForm';
import { useShopDemand } from '@/components/shop-demand/useShopDemand';
import { DEMAND_STATUSES, displayDate, sortRequests } from '@/lib/shop-demand';
import { formatNum } from '@/lib/pos';

export default function ShopDemandPanel({ user, products, locations }) {
  const { requests, itemsByRequest, loading, error, reload, create, update, cancel, accept, progress, send, safe } = useShopDemand(user);
  const role = user?.role;
  const shopName = user?.shop_name || user?.data?.shop_name || '';
  const canCreate = ['admin', 'manager', 'cashier'].includes(role);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [fDate, setFDate] = useState('');
  const [fShop, setFShop] = useState('');
  const [fProduct, setFProduct] = useState('');
  const [fStatus, setFStatus] = useState('');

  const canViewAll = ['admin', 'accountant', 'production'].includes(role);
  const shopOptions = locations || [];

  const filtered = useMemo(() => sortRequests(requests.filter((r) => {
    if (fDate && r.required_date !== fDate) return false;
    if (fShop && r.shop_id !== fShop) return false;
    if (fStatus && r.status !== fStatus) return false;
    if (fProduct && !(r.items || []).some((it) => it.product_id === fProduct)) return false;
    return true;
  })), [requests, fDate, fShop, fStatus, fProduct]);

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (req) => { setEditing(req); setFormOpen(true); };

  const submitForm = async (data) => {
    if (editing) {
      await safe(() => update({ request_id: editing.id, ...data }), 'Tahrirlash');
    } else {
      await safe(() => create(data), 'Talab yuborish');
    }
  };

  return (
    <div className="space-y-5">
      <div className="odina-panel rounded-2xl border border-border bg-card premium-shadow p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center shrink-0">
          <ClipboardList className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <p className="font-semibold">Do'kon talablari</p>
          <p className="text-sm text-muted-foreground">Markazga mahsulot talab qiling. Talab qabul qilinguncha tahrirlash mumkin.</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={reload} className="min-h-11 rounded-xl touch-manipulation">
            <RefreshCw className="w-4 h-4 mr-1.5" /> Yangilash
          </Button>
          {canCreate && (
            <Button onClick={openCreate} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
              <Plus className="w-4 h-4 mr-1.5" /> Markazga talab yuborish
            </Button>
          )}
        </div>
      </div>

      <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4 sm:p-5">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Sana</span>
            <Input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} className="h-11 rounded-xl" />
          </label>
          {canViewAll && (
            <label className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Do'kon</span>
              <OdinaSelect value={fShop} onChange={(e) => setFShop(e.target.value)} className="w-full h-11 rounded-xl">
                <option value="">Barcha do'konlar</option>
                {shopOptions.filter((s) => s.location_type !== 'production').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </OdinaSelect>
            </label>
          )}
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Mahsulot</span>
            <OdinaSelect value={fProduct} onChange={(e) => setFProduct(e.target.value)} className="w-full h-11 rounded-xl">
              <option value="">Barcha mahsulotlar</option>
              {(products || []).filter((p) => p.active !== false && p.archived !== true).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </OdinaSelect>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Holat</span>
            <OdinaSelect value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="w-full h-11 rounded-xl">
              <option value="">Barcha holatlar</option>
              {DEMAND_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </OdinaSelect>
          </label>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-7 h-7 animate-spin text-brand-olive mr-2" /> Yuklanmoqda…
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-800 text-sm">{error}</div>
      ) : filtered.length === 0 ? (
        <div className="odina-panel rounded-2xl border border-dashed border-border bg-card py-12 text-center">
          <ClipboardList className="w-9 h-9 mx-auto text-muted-foreground/35 mb-2" />
          <p className="text-sm font-medium">Talab topilmadi</p>
          <p className="text-xs text-muted-foreground mt-1">{canCreate ? '“Markazga talab yuborish” tugmasi orqali yangi talab qo‘shing.' : 'Hozircha talablar yo‘q.'}</p>
        </div>
      ) : (
        <div className="grid xl:grid-cols-2 gap-3">
          {filtered.map((r) => (
            <ShopDemandCard
              key={r.id}
              request={{ ...r, items: r.items || itemsByRequest[r.id] || [] }}
              user={user}
              actions={{ accept, progress, send, cancel, onEdit: openEdit }}
            />
          ))}
        </div>
      )}

      {canCreate && (
        <ShopDemandForm
          open={formOpen}
          onClose={() => setFormOpen(false)}
          user={user}
          shopName={shopName}
          products={products}
          editing={editing}
          onSubmit={submitForm}
        />
      )}
    </div>
  );
}