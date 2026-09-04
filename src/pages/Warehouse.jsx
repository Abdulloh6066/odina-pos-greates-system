import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { Archive, ArrowRightLeft, Boxes, History, PackagePlus, Plus, Search, Truck, Warehouse as WarehouseIcon } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatNum } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import TransfersPanel from '@/components/warehouse/TransfersPanel';
import SupplierLedgerPanel from '@/components/warehouse/SupplierLedgerPanel';

const TABS = [
  { id: 'ingredients', label: 'Masalliqlar va qadoqlar', icon: Archive },
  { id: 'products', label: 'Tayyor mahsulotlar', icon: Boxes },
  { id: 'suppliers', label: 'Kirim va qarzlar', icon: Truck },
  { id: 'transfers', label: 'Transferlar', icon: ArrowRightLeft },
  { id: 'history', label: 'Ombor tarixi', icon: History },
];

const UNIT_LABELS = { g: 'g', ml: 'ml', piece: 'dona' };
const SOURCE_LABELS = {
  central_produced: 'Markaziy ishlab chiqarishda tayyorlanadi',
  shop_prepared: 'Do‘konning o‘zida tayyorlanadi',
  resale: 'Tayyor holda sotib olinadi',
};
const INGREDIENT_CATEGORY_LABELS = {
  food: 'Oziq-ovqat masallig‘i',
  packaging: 'Qadoqlash',
};
const MOVEMENT_LABELS = {
  opening: 'Boshlang‘ich qoldiq',
  adjustment: 'Qoldiq tuzatishi',
  receipt: 'Yetkazib beruvchidan qabul',
  production_use: 'Ishlab chiqarishda sarf',
  production_output: 'Ishlab chiqarilgan mahsulot',
  transfer_out: 'Jo‘natilgan transfer',
  transfer_in: 'Qabul qilingan transfer',
  sale: 'Kassa savdosi',
  waste: 'Chiqit',
  refund: 'Qaytarish',
};

export default function Warehouse() {
  const { user } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [locations, setLocations] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [products, setProducts] = useState([]);
  const [ingredientStock, setIngredientStock] = useState([]);
  const [productStock, setProductStock] = useState([]);
  const [movements, setMovements] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(user?.role === 'admin' ? '' : (user?.shop_id || ''));
  const requestedTab = searchParams.get('tab');
  const canViewSupplierLedger = ['admin', 'warehouse', 'accountant'].includes(user?.role);
  const tabAllowed = (value) => TABS.some((item) => item.id === value) && (value !== 'suppliers' || canViewSupplierLedger);
  const [tab, setTab] = useState(tabAllowed(requestedTab) ? requestedTab : 'ingredients');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [ingredientOpen, setIngredientOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [locationList, ingredientList, productList, ingredientBalances, productBalances, movementList, transferList, recipientList] = await Promise.all([
        base44.entities.Shop.list(),
        base44.entities.Ingredient.list('name', 500),
        base44.entities.Product.list('name', 500),
        base44.entities.IngredientStock.list('-updated_at', 500),
        base44.entities.ProductStock.list('-updated_at', 500),
        base44.entities.StockMovement.list('-created_at', 500),
        base44.entities.StockTransfer.list('-sent_at', 500),
        base44.entities.CashRecipient.list('name', 500),
      ]);
      setLocations((locationList || []).filter((location) => location.active !== false));
      setIngredients((ingredientList || []).filter((item) => item.active !== false));
      setProducts((productList || []).filter((item) => item.active !== false && item.archived !== true && item.track_stock !== false));
      setIngredientStock(ingredientBalances || []);
      setProductStock(productBalances || []);
      setMovements(movementList || []);
      setTransfers(transferList || []);
      setRecipients((recipientList || []).filter((recipient) => recipient.active !== false));
      if (!selectedLocation) {
        const preferred = user?.shop_id || locationList?.[0]?.id || '';
        setSelectedLocation(preferred);
      }
    } catch (error) {
      alert('Omborni yuklab bo‘lmadi: ' + (error?.message || error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (user) load(); }, [user]);

  useEffect(() => {
    if (requestedTab && tabAllowed(requestedTab) && requestedTab !== tab) {
      setTab(requestedTab);
      setSearch('');
    }
  }, [requestedTab, tab, canViewSupplierLedger]);

  const changeTab = (nextTab) => {
    setTab(nextTab);
    setSearch('');
    setSearchParams({ tab: nextTab });
  };

  const selectedLocationRecord = locations.find((location) => location.id === selectedLocation);
  const canCreateIngredients = ['admin', 'accountant'].includes(user?.role);

  const stockMap = useMemo(() => {
    const balances = tab === 'products' ? productStock : ingredientStock;
    const keyName = tab === 'products' ? 'product_id' : 'ingredient_id';
    return Object.fromEntries(
      balances
        .filter((balance) => balance.location_id === selectedLocation)
        .map((balance) => [balance[keyName], balance]),
    );
  }, [tab, ingredientStock, productStock, selectedLocation]);

  const items = useMemo(() => {
    const source = tab === 'products' ? products : ingredients;
    const query = search.toLowerCase().trim();
    if (!query) return source;
    return source.filter((item) => [
      item.name,
      item.category,
      item.source_type,
    ].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [tab, products, ingredients, search]);

  const visibleMovements = useMemo(() => {
    const query = search.toLowerCase().trim();
    return movements.filter((movement) => {
      if (movement.location_id !== selectedLocation) return false;
      if (!query) return true;
      return [movement.item_name, movement.reason, movement.user_name, MOVEMENT_LABELS[movement.movement_type]]
        .filter(Boolean).join(' ').toLowerCase().includes(query);
    });
  }, [movements, selectedLocation, search]);

  const balancesForLocation = [...ingredientStock, ...productStock]
    .filter((balance) => balance.location_id === selectedLocation);
  const stockedCount = balancesForLocation.filter((balance) => Number(balance.quantity || 0) > 0).length;

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in">
      <PageHeader
        title="Ombor"
        subtitle={selectedLocationRecord ? selectedLocationRecord.name : 'Joylashuvni tanlang'}
        icon={WarehouseIcon}
        actions={canCreateIngredients && (
          <Button onClick={() => setIngredientOpen(true)} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            <Plus className="w-4 h-4 mr-1.5" /> Yangi masalliq
          </Button>
        )}
      />

      <div className="rounded-2xl bg-card border border-border premium-shadow p-4 sm:p-5 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          {user?.role === 'admin' ? (
            <label className="sm:w-72 space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Ombor joylashuvi</span>
              <select
                value={selectedLocation}
                onChange={(event) => setSelectedLocation(event.target.value)}
                className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}{location.location_type === 'production' ? ' · Ishlab chiqarish' : ' · Do‘kon'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="sm:w-72">
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Sizning omboringiz</p>
              <div className="h-11 rounded-xl bg-secondary/70 px-3 flex items-center text-sm font-medium">
                {selectedLocationRecord?.name || user?.shop_name || 'Joylashuv biriktirilmagan'}
              </div>
            </div>
          )}
          <label className="flex-1 space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Qidiruv</span>
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Qoldiq yoki tarixni qidirish…" className="h-11 pl-10 rounded-xl bg-background" />
            </div>
          </label>
        </div>
      </div>

      {!selectedLocation ? (
        <div className="rounded-2xl border border-border bg-card py-16 text-center">
          <WarehouseIcon className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="font-medium">Ombor joylashuvi biriktirilmagan</p>
          <p className="text-sm text-muted-foreground mt-1">Egasi ushbu xodimni joylashuvga biriktirishi kerak.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
            <Summary label="Masalliqlar" value={ingredients.length} />
            <Summary label="Tayyor mahsulotlar" value={products.length} />
            <Summary label="Omborda mavjud turlar" value={stockedCount} />
            <Summary label="Ombor harakatlari" value={movements.filter((m) => m.location_id === selectedLocation).length} />
          </div>

          <div className="flex lg:hidden gap-2 overflow-x-auto pb-2 mb-3">
            {TABS.filter((item) => item.id !== 'suppliers' || canViewSupplierLedger).map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant={tab === id ? 'default' : 'outline'}
                onClick={() => changeTab(id)}
                className={`shrink-0 min-h-11 rounded-xl touch-manipulation ${tab === id ? 'bg-primary text-primary-foreground hover:bg-primary-strong' : ''}`}
              >
                <Icon className="w-4 h-4 mr-1.5" />{label}
              </Button>
            ))}
          </div>

          {loading ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-32 rounded-2xl bg-secondary animate-pulse" />)}
            </div>
          ) : tab === 'history' ? (
            <HistoryList movements={visibleMovements} />
          ) : tab === 'suppliers' && canViewSupplierLedger ? (
            <SupplierLedgerPanel
              user={user}
              location={selectedLocationRecord}
              ingredients={ingredients}
              recipients={recipients}
              search={search}
            />
          ) : tab === 'transfers' ? (
            <TransfersPanel
              user={user}
              location={selectedLocationRecord}
              locations={locations}
              products={products}
              productStock={productStock}
              transfers={transfers}
              search={search}
              onReload={load}
            />
          ) : (
            <StockGrid
              items={items}
              stockMap={stockMap}
              kind={tab === 'products' ? 'product' : 'ingredient'}
              onAdjust={user?.role === 'warehouse' ? null : (item) => setAdjusting({ item, kind: tab === 'products' ? 'product' : 'ingredient' })}
            />
          )}
        </>
      )}

      <IngredientDialog
        open={ingredientOpen}
        onClose={() => setIngredientOpen(false)}
        onSaved={() => { setIngredientOpen(false); load(); }}
      />
      <AdjustStockDialog
        open={Boolean(adjusting)}
        item={adjusting?.item}
        kind={adjusting?.kind}
        location={selectedLocationRecord}
        current={adjusting ? Number(stockMap[adjusting.item.id]?.quantity || 0) : 0}
        onClose={() => setAdjusting(null)}
        onSaved={() => { setAdjusting(null); load(); }}
      />
    </div>
  );
}

function Summary({ label, value }) {
  return (
    <div className="rounded-2xl bg-card border border-border premium-shadow p-4 transition-all hover:-translate-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold mt-1">{formatNum(value)}</p>
    </div>
  );
}

function StockGrid({ items, stockMap, kind, onAdjust }) {
  if (!items.length) {
    return <div className="rounded-2xl border border-border bg-card py-14 text-center text-sm text-muted-foreground">Mos mahsulot topilmadi.</div>;
  }
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {items.map((item) => {
        const stock = stockMap[item.id];
        const quantity = Number(stock?.quantity || 0);
        const unit = kind === 'ingredient' ? item.base_unit : 'piece';
        return (
          <div key={item.id} className="rounded-2xl bg-card border border-border premium-shadow p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold truncate">{item.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5 capitalize">
                  {kind === 'ingredient' ? (INGREDIENT_CATEGORY_LABELS[item.category] || item.category) : (SOURCE_LABELS[item.source_type] || 'Markaziy ishlab chiqarishda tayyorlanadi')}
                </p>
              </div>
              <div className={`rounded-xl px-3 py-1.5 text-right ${quantity > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-secondary text-muted-foreground'}`}>
                <p className="text-lg font-semibold leading-none">{formatNum(quantity)}</p>
                <p className="text-[10px] mt-1">{UNIT_LABELS[unit] || unit}</p>
              </div>
            </div>
            {onAdjust && (
              <Button variant="outline" size="sm" onClick={() => onAdjust(item)} className="w-full mt-4 min-h-11 rounded-xl touch-manipulation">
                <PackagePlus className="w-4 h-4 mr-1.5" /> Boshlang‘ich qoldiq / tuzatish
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryList({ movements }) {
  if (!movements.length) {
    return <div className="rounded-2xl border border-border bg-card py-14 text-center text-sm text-muted-foreground">Bu joylashuvda ombor harakati yo‘q.</div>;
  }
  return (
    <div className="space-y-3">
      {movements.map((movement) => (
        <div key={movement.id} className="rounded-2xl bg-card border border-border p-4 flex items-start gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-semibold shrink-0 ${movement.quantity_change > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-destructive'}`}>
            {movement.quantity_change > 0 ? '+' : '−'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{movement.item_name}</p>
                <p className="text-xs text-muted-foreground">{MOVEMENT_LABELS[movement.movement_type] || movement.movement_type} · {movement.reason}</p>
              </div>
              <p className={`font-semibold ${movement.quantity_change > 0 ? 'text-emerald-700' : 'text-destructive'}`}>
                {movement.quantity_change > 0 ? '+' : ''}{formatNum(movement.quantity_change)} {UNIT_LABELS[movement.unit] || movement.unit}
              </p>
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              {formatNum(movement.balance_before)} → {formatNum(movement.balance_after)} · {movement.user_name} · {new Date(movement.created_at || movement.created_date).toLocaleString('uz-UZ')}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function IngredientDialog({ open, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('food');
  const [baseUnit, setBaseUnit] = useState('g');
  const [purchaseUnit, setPurchaseUnit] = useState('kg');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setCategory('food');
      setBaseUnit('g');
      setPurchaseUnit('kg');
    }
  }, [open]);

  const save = async () => {
    if (!name.trim()) return;
    const validPair = (baseUnit === 'g' && ['g', 'kg'].includes(purchaseUnit))
      || (baseUnit === 'ml' && ['ml', 'l'].includes(purchaseUnit))
      || (baseUnit === 'piece' && purchaseUnit === 'piece');
    if (!validPair) {
      alert('Xarid birligi asosiy birlikka mos bo‘lishi kerak.');
      return;
    }
    setSaving(true);
    try {
      await base44.entities.Ingredient.create({
        name: name.trim(),
        category,
        base_unit: baseUnit,
        purchase_unit: purchaseUnit,
        conversion_to_base: ['kg', 'l'].includes(purchaseUnit) ? 1000 : 1,
        active: true,
      });
      onSaved();
    } catch (error) {
      alert('Masalliqni yaratib bo‘lmadi: ' + (error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle className="font-display text-xl">Yangi masalliq yoki qadoq</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Nomi</Label>
            <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Masalan: un, sut, tort qutisi" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Turi</Label>
            <select value={category} onChange={(event) => setCategory(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
              <option value="food">Oziq-ovqat masallig‘i</option>
              <option value="packaging">Qadoqlash</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs mb-1.5 block">Retsept / ombor birligi</Label>
              <select value={baseUnit} onChange={(event) => {
                const value = event.target.value;
                setBaseUnit(value);
                setPurchaseUnit(value === 'g' ? 'kg' : value === 'ml' ? 'l' : 'piece');
              }} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
                <option value="g">Gramm (g)</option>
                <option value="ml">Millilitr (ml)</option>
                <option value="piece">Dona</option>
              </select>
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Odatda qaysi birlikda olinadi</Label>
              <select value={purchaseUnit} onChange={(event) => setPurchaseUnit(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
                {baseUnit === 'g' && <><option value="kg">Kilogramm (kg)</option><option value="g">Gramm (g)</option></>}
                {baseUnit === 'ml' && <><option value="l">Litr (L)</option><option value="ml">Millilitr (ml)</option></>}
                {baseUnit === 'piece' && <option value="piece">Dona</option>}
              </select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground rounded-xl bg-secondary/60 p-3">
            Kilogramm va litr avtomatik ravishda 1 000 gramm yoki millilitrga aylantiriladi.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving || !name.trim()} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            {saving ? 'Saqlanmoqda…' : 'Yaratish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustStockDialog({ open, item, kind, location, current, onClose, onSaved }) {
  const [mode, setMode] = useState('add');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [movementType, setMovementType] = useState('opening');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMode('add');
      setQuantity('');
      setReason('');
      setMovementType(current === 0 ? 'opening' : 'adjustment');
    }
  }, [open, current]);

  const unit = kind === 'ingredient' ? item?.base_unit : 'piece';
  const change = (mode === 'remove' ? -1 : 1) * Number(quantity || 0);
  const after = current + change;

  const save = async () => {
    if (!item || !location || !Number.isFinite(change) || change === 0 || !reason.trim()) return;
    if (after < 0) {
      alert('Ombor qoldig‘i manfiy bo‘lishi mumkin emas.');
      return;
    }
    setSaving(true);
    try {
      const result = await base44.functions.invoke('warehouse-stock', {
        action: 'adjust_stock',
        location_id: location.id,
        item_kind: kind,
        item_id: item.id,
        movement_type: movementType,
        quantity_change: change,
        reason: reason.trim(),
      });
      const payload = result?.data || result;
      if (!payload?.stock) throw new Error(payload?.error || 'Ombor qoldig‘ini yangilab bo‘lmadi.');
      onSaved();
    } catch (error) {
      alert('Ombor yangilanishi amalga oshmadi: ' + (error?.response?.data?.error || error?.data?.error || error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Ombor qoldig‘ini yangilash</DialogTitle>
          <p className="text-sm text-muted-foreground">{item?.name} · {location?.name}</p>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant={mode === 'add' ? 'default' : 'outline'} onClick={() => setMode('add')} className={mode === 'add' ? 'bg-primary text-primary-foreground hover:bg-primary-strong' : ''}>Kirim qilish</Button>
            <Button type="button" variant={mode === 'remove' ? 'destructive' : 'outline'} onClick={() => setMode('remove')}>Chiqim qilish</Button>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Miqdor ({UNIT_LABELS[unit] || unit})</Label>
            <Input autoFocus type="number" min="0.001" step={unit === 'piece' ? '1' : '0.001'} value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="0" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Sabab</Label>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Doimiy ombor tarixi uchun majburiy" rows={2} />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Yozuv turi</Label>
            <select value={movementType} onChange={(event) => setMovementType(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
              <option value="opening">Boshlang‘ich qoldiq</option>
              <option value="adjustment">Qo‘lda tuzatish</option>
            </select>
          </div>
          <div className="rounded-xl bg-secondary/60 p-3 text-sm flex items-center justify-between">
            <span className="text-muted-foreground">O‘zgarishdan keyingi qoldiq</span>
            <span className={`font-semibold ${after < 0 ? 'text-destructive' : ''}`}>{formatNum(after)} {UNIT_LABELS[unit] || unit}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving || !quantity || !reason.trim() || after < 0} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            {saving ? 'Saqlanmoqda…' : 'Tarix bilan saqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
