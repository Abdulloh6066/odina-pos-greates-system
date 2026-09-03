import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Archive, Boxes, History, PackagePlus, Plus, Search, Warehouse as WarehouseIcon } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatNum } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

const TABS = [
  { id: 'ingredients', label: 'Ingredients & packaging', icon: Archive },
  { id: 'products', label: 'Finished products', icon: Boxes },
  { id: 'history', label: 'Stock history', icon: History },
];

const UNIT_LABELS = { g: 'g', ml: 'ml', piece: 'pcs' };
const MOVEMENT_LABELS = {
  opening: 'Opening stock',
  adjustment: 'Stock adjustment',
  receipt: 'Supplier receipt',
  production_use: 'Production use',
  production_output: 'Production output',
  transfer_out: 'Transfer sent',
  transfer_in: 'Transfer received',
  sale: 'POS sale',
  waste: 'Waste',
  refund: 'Refund',
};

export default function Warehouse() {
  const { user } = useOutletContext();
  const [locations, setLocations] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [products, setProducts] = useState([]);
  const [ingredientStock, setIngredientStock] = useState([]);
  const [productStock, setProductStock] = useState([]);
  const [movements, setMovements] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(user?.role === 'admin' ? '' : (user?.shop_id || ''));
  const [tab, setTab] = useState('ingredients');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [ingredientOpen, setIngredientOpen] = useState(false);
  const [adjusting, setAdjusting] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [locationList, ingredientList, productList, ingredientBalances, productBalances, movementList] = await Promise.all([
        base44.entities.Shop.list(),
        base44.entities.Ingredient.list('name', 500),
        base44.entities.Product.list('name', 500),
        base44.entities.IngredientStock.list('-updated_at', 500),
        base44.entities.ProductStock.list('-updated_at', 500),
        base44.entities.StockMovement.list('-created_at', 500),
      ]);
      setLocations((locationList || []).filter((location) => location.active !== false));
      setIngredients((ingredientList || []).filter((item) => item.active !== false));
      setProducts((productList || []).filter((item) => item.active !== false && item.track_stock !== false));
      setIngredientStock(ingredientBalances || []);
      setProductStock(productBalances || []);
      setMovements(movementList || []);
      if (!selectedLocation) {
        const preferred = user?.shop_id || locationList?.[0]?.id || '';
        setSelectedLocation(preferred);
      }
    } catch (error) {
      alert('Could not load warehouse: ' + (error?.message || error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (user) load(); }, [user]);

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
        title="Warehouse"
        subtitle={selectedLocationRecord ? selectedLocationRecord.name : 'Choose a location'}
        icon={WarehouseIcon}
        actions={canCreateIngredients && (
          <Button onClick={() => setIngredientOpen(true)} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            <Plus className="w-4 h-4 mr-1.5" /> New ingredient
          </Button>
        )}
      />

      <div className="rounded-2xl bg-card border border-border premium-shadow p-4 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          {user?.role === 'admin' ? (
            <label className="sm:w-72 space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Warehouse location</span>
              <select
                value={selectedLocation}
                onChange={(event) => setSelectedLocation(event.target.value)}
                className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}{location.location_type === 'production' ? ' · Production' : ' · Shop'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="sm:w-72">
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Your warehouse</p>
              <div className="h-11 rounded-xl bg-secondary/70 px-3 flex items-center text-sm font-medium">
                {selectedLocationRecord?.name || user?.shop_name || 'No location assigned'}
              </div>
            </div>
          )}
          <label className="flex-1 space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Search</span>
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search stock or history…" className="h-11 pl-10 rounded-xl bg-background" />
            </div>
          </label>
        </div>
      </div>

      {!selectedLocation ? (
        <div className="rounded-2xl border border-border bg-card py-16 text-center">
          <WarehouseIcon className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="font-medium">No warehouse location assigned</p>
          <p className="text-sm text-muted-foreground mt-1">The owner must assign this user to a location.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <Summary label="Ingredients" value={ingredients.length} />
            <Summary label="Finished products" value={products.length} />
            <Summary label="Items in stock" value={stockedCount} />
            <Summary label="Stock movements" value={movements.filter((m) => m.location_id === selectedLocation).length} />
          </div>

          <div className="flex gap-2 overflow-x-auto pb-2 mb-3">
            {TABS.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant={tab === id ? 'default' : 'outline'}
                onClick={() => { setTab(id); setSearch(''); }}
                className={`shrink-0 ${tab === id ? 'bg-primary text-primary-foreground hover:bg-primary-strong' : ''}`}
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
          ) : (
            <StockGrid
              items={items}
              stockMap={stockMap}
              kind={tab === 'products' ? 'product' : 'ingredient'}
              onAdjust={(item) => setAdjusting({ item, kind: tab === 'products' ? 'product' : 'ingredient' })}
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
    <div className="rounded-2xl bg-card border border-border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold mt-1">{formatNum(value)}</p>
    </div>
  );
}

function StockGrid({ items, stockMap, kind, onAdjust }) {
  if (!items.length) {
    return <div className="rounded-2xl border border-border bg-card py-14 text-center text-sm text-muted-foreground">No matching items.</div>;
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
                  {kind === 'ingredient' ? item.category : (item.source_type || 'central produced').replaceAll('_', ' ')}
                </p>
              </div>
              <div className={`rounded-xl px-3 py-1.5 text-right ${quantity > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-secondary text-muted-foreground'}`}>
                <p className="text-lg font-semibold leading-none">{formatNum(quantity)}</p>
                <p className="text-[10px] mt-1">{UNIT_LABELS[unit] || unit}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => onAdjust(item)} className="w-full mt-4">
              <PackagePlus className="w-4 h-4 mr-1.5" /> Set opening / adjust
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function HistoryList({ movements }) {
  if (!movements.length) {
    return <div className="rounded-2xl border border-border bg-card py-14 text-center text-sm text-muted-foreground">No stock movements for this location.</div>;
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
              {formatNum(movement.balance_before)} → {formatNum(movement.balance_after)} · {movement.user_name} · {new Date(movement.created_at || movement.created_date).toLocaleString('en-GB')}
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
      alert('Purchase unit must match the base unit.');
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
      alert('Could not create ingredient: ' + (error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle className="font-display text-xl">New ingredient or packaging</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Name</Label>
            <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Flour, Milk, Cake box" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Type</Label>
            <select value={category} onChange={(event) => setCategory(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
              <option value="food">Food ingredient</option>
              <option value="packaging">Packaging</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs mb-1.5 block">Recipe / stock unit</Label>
              <select value={baseUnit} onChange={(event) => {
                const value = event.target.value;
                setBaseUnit(value);
                setPurchaseUnit(value === 'g' ? 'kg' : value === 'ml' ? 'l' : 'piece');
              }} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
                <option value="g">Grams (g)</option>
                <option value="ml">Millilitres (ml)</option>
                <option value="piece">Pieces</option>
              </select>
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Usually purchased in</Label>
              <select value={purchaseUnit} onChange={(event) => setPurchaseUnit(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
                {baseUnit === 'g' && <><option value="kg">Kilograms (kg)</option><option value="g">Grams (g)</option></>}
                {baseUnit === 'ml' && <><option value="l">Litres (L)</option><option value="ml">Millilitres (ml)</option></>}
                {baseUnit === 'piece' && <option value="piece">Pieces</option>}
              </select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground rounded-xl bg-secondary/60 p-3">
            Kilograms and litres are automatically converted to 1,000 grams or millilitres.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !name.trim()} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {saving ? 'Saving…' : 'Create item'}
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
      alert('Stock cannot become negative.');
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
      if (!payload?.stock) throw new Error(payload?.error || 'Stock could not be updated.');
      onSaved();
    } catch (error) {
      alert('Stock update failed: ' + (error?.response?.data?.error || error?.data?.error || error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Update stock</DialogTitle>
          <p className="text-sm text-muted-foreground">{item?.name} · {location?.name}</p>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant={mode === 'add' ? 'default' : 'outline'} onClick={() => setMode('add')} className={mode === 'add' ? 'bg-primary text-primary-foreground hover:bg-primary-strong' : ''}>Add stock</Button>
            <Button type="button" variant={mode === 'remove' ? 'destructive' : 'outline'} onClick={() => setMode('remove')}>Remove stock</Button>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Quantity ({UNIT_LABELS[unit] || unit})</Label>
            <Input autoFocus type="number" min="0.001" step={unit === 'piece' ? '1' : '0.001'} value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="0" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Reason</Label>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required for permanent stock history" rows={2} />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Record type</Label>
            <select value={movementType} onChange={(event) => setMovementType(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
              <option value="opening">Opening stock</option>
              <option value="adjustment">Manual correction</option>
            </select>
          </div>
          <div className="rounded-xl bg-secondary/60 p-3 text-sm flex items-center justify-between">
            <span className="text-muted-foreground">Balance after change</span>
            <span className={`font-semibold ${after < 0 ? 'text-destructive' : ''}`}>{formatNum(after)} {UNIT_LABELS[unit] || unit}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !quantity || !reason.trim() || after < 0} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {saving ? 'Saving…' : 'Save with history'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
