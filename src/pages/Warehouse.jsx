import React, { useEffect, useMemo, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Archive, ArrowRightLeft, BookOpen, Boxes, ChefHat, ClipboardCheck, ClipboardList, History, Layers3, PackagePlus, Plus, Search, Truck, Warehouse as WarehouseIcon } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { odinaAlert } from '@/lib/odina-dialog';
import { formatNum } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import PageHeader from '@/components/PageHeader';
import { WarehouseHistoryTable } from '@/components/warehouse/WarehouseTables';
import '@/components/warehouse/warehouse-workspace.css';
import '@/styles/catalog-workbench.css';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import TransfersPanel from '@/components/warehouse/TransfersPanel';
import ShopDemandPanel from '@/components/shop-demand/ShopDemandPanel';
import SupplierLedgerPanel from '@/components/warehouse/SupplierLedgerPanel';
import ProductionPanel from '@/components/warehouse/ProductionPanel';
import StockCountPanel from '@/components/warehouse/StockCountPanel';
import { TEST_PRODUCT_IDS } from '@/lib/test-catalog-cleanup';
import { isCakeLayer, ingredientUnitLabel } from '@/lib/cake-layer-inventory';

const TABS = [
  { id: 'cake_layers', label: 'Qavatlar va listlar', icon: Layers3, roles: ['admin', 'manager', 'accountant', 'production'] },
  { id: 'ingredients', label: 'Masalliqlar va qadoqlar', icon: Archive },
  { id: 'products', label: 'Tayyor mahsulotlar', icon: Boxes, roles: ['admin', 'manager', 'cashier', 'accountant', 'production'] },
  { id: 'suppliers', label: 'Kirim va qarzlar', icon: Truck, roles: ['admin', 'manager', 'warehouse', 'accountant'] },
  { id: 'recipes', label: 'Retseptlar', icon: BookOpen, roles: ['admin', 'manager', 'accountant', 'production'] },
  { id: 'production', label: 'Ishlab chiqarish', icon: ChefHat, roles: ['admin', 'manager', 'accountant', 'production'] },
  { id: 'transfers', label: 'Transferlar', icon: ArrowRightLeft, roles: ['admin', 'manager', 'cashier', 'accountant', 'production'] },
  { id: 'demands', label: 'Do‘kon talablari', icon: ClipboardList, roles: ['admin', 'manager', 'cashier', 'accountant', 'production'] },
  { id: 'count', label: 'Ombor sanog‘i', icon: ClipboardCheck, roles: ['admin', 'manager', 'cashier', 'accountant'] },
  { id: 'history', label: 'Ombor tarixi', icon: History },
];

const UNIT_LABELS = { g: 'g', ml: 'ml', piece: 'dona', sheet: 'list' };
const SOURCE_LABELS = {
  central_produced: 'Markaziy ishlab chiqarishda tayyorlanadi',
  shop_prepared: 'Do‘konning o‘zida tayyorlanadi',
  resale: 'Tayyor holda sotib olinadi',
};
const INGREDIENT_CATEGORY_LABELS = {
  food: 'Oziq-ovqat masallig‘i',
  packaging: 'Qadoqlash',
  household: 'Xo‘jalik va tozalash',
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
  waste_cancel: 'Chiqit bekor qilindi',
  refund: 'Qaytarish',
  receipt_cancel: 'Kirim bekor qilindi',
};

export function resolveWarehouseTab(requestedTab, role) {
  const allowedTabs = TABS.filter((item) => !item.roles || item.roles.includes(role));
  return allowedTabs.some((item) => item.id === requestedTab)
    ? requestedTab
    : (allowedTabs[0]?.id || 'ingredients');
}

export default function Warehouse() {
  const { user } = useOutletContext();
  const assignedShopId = user?.shop_id || user?.data?.shop_id || '';
  const assignedShopName = user?.shop_name || user?.data?.shop_name || '';
  const [searchParams, setSearchParams] = useSearchParams();
  const [locations, setLocations] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [products, setProducts] = useState([]);
  const [archivedProductIds, setArchivedProductIds] = useState([]);
  const [ingredientStock, setIngredientStock] = useState([]);
  const [productStock, setProductStock] = useState([]);
  const [movements, setMovements] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState((user?.role === 'admin') ? '' : assignedShopId);
  const requestedTab = searchParams.get('tab');
  const [newLayerView, setNewLayerView] = useState(true);
  const canViewSupplierLedger = ['admin', 'manager', 'warehouse', 'accountant'].includes(user?.role);
  const visibleTabs = TABS.filter((item) => !item.roles || item.roles.includes(user?.role));
  const tab = resolveWarehouseTab(requestedTab, user?.role);
  const [search, setSearch] = useState('');
  const [ingredientCategory, setIngredientCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [loadWarning, setLoadWarning] = useState('');
  const [ingredientOpen, setIngredientOpen] = useState(false);
  const [ingredientIsLayer, setIngredientIsLayer] = useState(false);
  const [adjusting, setAdjusting] = useState(null);

  const loadAssignedTransfers = async () => {
    if (!assignedShopId) return [];

    const [incoming, outgoing] = await Promise.all([
      base44.entities.StockTransfer.filter(
        { destination_location_id: assignedShopId },
        '-sent_at',
        500,
      ),
      base44.entities.StockTransfer.filter(
        { source_location_id: assignedShopId },
        '-sent_at',
        500,
      ),
    ]);

    const exactTransfers = [...(incoming || []), ...(outgoing || [])].filter(
      (transfer) => transfer.destination_location_id === assignedShopId
        || transfer.source_location_id === assignedShopId,
    );
    return Array.from(
      new Map(exactTransfers.map((transfer) => [transfer.id, transfer])).values(),
    ).sort((left, right) => new Date(right.sent_at || right.created_date || 0)
      - new Date(left.sent_at || left.created_date || 0));
  };

  const loadTransferData = async () => {
    try {
      const response = await base44.functions.invoke('stock-transfer', { action: 'list_transfers' });
      const payload = response?.data || response;
      const returnedTransfers = payload?.transfers || [];

      if (!(user?.role === 'admin') && assignedShopId && returnedTransfers.length === 0) {
        const exactTransfers = await loadAssignedTransfers().catch(() => []);
        if (exactTransfers.length > 0) {
          return {
            data: {
              ...payload,
              transfers: exactTransfers,
              effective_location_id: assignedShopId,
              effective_location_name: assignedShopName || null,
              fallback: true,
            },
          };
        }
      }

      return response;
    } catch (error) {
      console.warn('Transferlarni backend orqali yuklash vaqtincha ishlamadi.', error);

      if (user?.role === 'admin') {
        const fallbackTransfers = await base44.entities.StockTransfer.list('-sent_at', 500).catch(() => []);
        return { data: { transfers: fallbackTransfers, fallback: true } };
      }

      try {
        const exactTransfers = await loadAssignedTransfers();
        return {
          data: {
            transfers: exactTransfers,
            effective_location_id: assignedShopId || null,
            effective_location_name: assignedShopName || null,
            fallback: true,
          },
        };
      } catch (fallbackError) {
        console.warn('Biriktirilgan do‘kon transferlarini ham yuklab bo‘lmadi.', fallbackError);
        return { data: { transfers: [], fallback: true, load_failed: true } };
      }
    }
  };

  const load = async () => {
    setLoading(true);
    setLoadWarning('');
    try {
      const results = await Promise.allSettled([
        base44.entities.Shop.list(),
        base44.entities.Ingredient.list('name', 500),
        user?.role === 'warehouse' ? Promise.resolve([]) : base44.entities.Product.list('name', 500),
        base44.entities.IngredientStock.list('-updated_at', 500),
        user?.role === 'warehouse' ? Promise.resolve([]) : base44.entities.ProductStock.list('-updated_at', 500),
        base44.entities.StockMovement.list('-created_at', 500),
        user?.role === 'warehouse'
          ? Promise.resolve({ data: { transfers: [] } })
          : loadTransferData(),
        canViewSupplierLedger ? base44.entities.CashRecipient.list('name', 500) : Promise.resolve([]),
      ]);

      const failedSections = [];
      const resultValue = (result, label, fallback) => {
        if (result.status === 'fulfilled') return result.value;
        failedSections.push(label);
        console.warn(`${label} ma’lumotlarini yuklab bo‘lmadi.`, result.reason);
        return fallback;
      };

      const locationList = resultValue(results[0], 'Joylashuvlar', locations);
      const ingredientList = resultValue(results[1], 'Masalliqlar', ingredients);
      const productList = resultValue(results[2], 'Mahsulotlar', products);
      const ingredientBalances = resultValue(results[3], 'Masalliq qoldiqlari', ingredientStock);
      const productBalances = resultValue(results[4], 'Mahsulot qoldiqlari', productStock);
      const movementList = resultValue(results[5], 'Ombor tarixi', movements);
      const transferResponse = resultValue(results[6], 'Transferlar', { data: { transfers } });
      const recipientList = resultValue(results[7], 'Yetkazib beruvchilar', recipients);

      const activeLocations = (locationList || []).filter((location) => location.active !== false);
      const transferPayload = transferResponse?.data || transferResponse;
      const transferList = transferPayload?.transfers || [];
      if (transferPayload?.load_failed && !failedSections.includes('Transferlar')) {
        failedSections.push('Transferlar');
      }

      setLocations(user?.role === 'manager'
        ? [...new Map([...activeLocations, ...(transferPayload?.destinations || [])].map(item => [item.id, item])).values()]
        : activeLocations);
      setIngredients((ingredientList || []).filter((item) => item.active !== false));
      setArchivedProductIds([
        ...(productList || []).filter((item) => item.archived === true).map((item) => item.id),
        ...TEST_PRODUCT_IDS.filter((id) => !(productList || []).some((item) => item.id === id)),
      ]);
      setProducts((productList || []).filter((item) => item.active !== false && item.archived !== true && item.track_stock !== false));
      setIngredientStock(ingredientBalances || []);
      setProductStock(productBalances || []);
      setMovements(movementList || []);
      setTransfers(transferList);
      setRecipients((recipientList || []).filter((recipient) => recipient.active !== false));
      setLoadWarning(failedSections.length
        ? `Vaqtincha yuklanmagan bo‘limlar: ${failedSections.join(', ')}. Qayta yuklashni bosing.`
        : '');

      const canChooseLocation = (user?.role === 'admin');
      if (!canChooseLocation) {
        const effectiveLocation = transferPayload?.effective_location_id
          || activeLocations.find((location) => location.id === assignedShopId)?.id
          || activeLocations[0]?.id
          || assignedShopId
          || '';
        if (effectiveLocation && effectiveLocation !== selectedLocation) {
          setSelectedLocation(effectiveLocation);
        }
      } else if (!selectedLocation || !activeLocations.some((location) => location.id === selectedLocation)) {
        const preferred = assignedShopId || activeLocations[0]?.id || '';
        setSelectedLocation(preferred);
      }
    } catch (error) {
      const message = error?.response?.data?.error || error?.data?.error || error?.message || String(error);
      setLoadWarning('Omborni yuklashda xato yuz berdi: ' + message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (user) load(); }, [user]);

  useEffect(() => {
    if (!user || user.role === 'warehouse') return undefined;

    const unsubscribe = base44.entities.StockTransfer.subscribe((event) => {
      const recordId = event?.data?.id || event?.id;
      if (!recordId) return;

      setTransfers((current) => {
        if (event.type === 'delete') {
          return current.filter((transfer) => transfer.id !== recordId);
        }

        const existing = current.find((transfer) => transfer.id === recordId);
        const nextRecord = { ...(existing || {}), ...(event.data || {}), id: recordId };
        return existing
          ? current.map((transfer) => transfer.id === recordId ? nextRecord : transfer)
          : [nextRecord, ...current];
      });
    });

    return () => unsubscribe?.();
  }, [user?.id, user?.role]);

  const changeTab = (nextTab) => {
    setSearch('');
    setSearchParams({ tab: nextTab });
  };

  const selectedLocationRecord = locations.find((location) => location.id === selectedLocation);
  const canCreateIngredients = ['admin', 'accountant'].includes(user?.role);

  useEffect(() => {
    if (requestedTab !== 'cake_layers' || user?.role !== 'admin' || !locations.length) return;
    if (selectedLocationRecord?.location_type === 'production') return;
    const central = locations.find((location) => location.location_type === 'production');
    if (central) setSelectedLocation(central.id);
  }, [requestedTab, user?.role, locations, selectedLocationRecord?.location_type]);

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
    const source = tab === 'products' ? products : ingredients.filter((item) => !isCakeLayer(item) && (ingredientCategory === 'all' || item.category === ingredientCategory));
    const query = search.toLowerCase().trim();
    if (!query) return source;
    return source.filter((item) => [
      item.name,
      item.category,
      item.source_type,
    ].filter(Boolean).join(' ').toLowerCase().includes(query));
  }, [tab, products, ingredients, search, ingredientCategory]);

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
    .filter((balance) => balance.location_id === selectedLocation && (!balance.product_id || products.some((p) => p.id === balance.product_id)));
  const stockedCount = balancesForLocation.filter((balance) => Number(balance.quantity || 0) > 0).length;

  return (
    <div className={`odina-page odina-workbench catalog-workbench catalog-warehouse p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in ${newLayerView ? 'warehouse-workspace' : ''}`}>
      <PageHeader
        title={visibleTabs.find((item) => item.id === tab)?.label || 'Ombor'}
        subtitle={selectedLocationRecord ? selectedLocationRecord.name : 'Joylashuvni tanlang'}
        icon={WarehouseIcon}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
          {(
            <Button type="button" variant="outline" aria-pressed={newLayerView} onClick={() => setNewLayerView((current) => !current)} className="min-h-11 rounded-xl">
              <Layers3 className="w-4 h-4 mr-1.5" aria-hidden="true" /> {newLayerView ? 'Kartalar ko‘rinishi' : 'Ro‘yxat ko‘rinishi'}
            </Button>
          )}
          {canCreateIngredients && (
          <Button onClick={() => { setIngredientIsLayer(tab === 'cake_layers'); setIngredientOpen(true); }} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            <Plus className="w-4 h-4 mr-1.5" /> {tab === 'cake_layers' ? 'Qavat turi qo‘shish' : 'Yangi masalliq'}
          </Button>
          )}
          </div>
        )}
      />

      <div className={newLayerView ? 'warehouse-frame' : undefined}>
      {newLayerView && (
        <nav className="warehouse-nav" aria-label="Ombor bo‘limlari">
          <p className="warehouse-nav-heading"><WarehouseIcon aria-hidden="true" className="w-4 h-4" /> Ombor bo‘limlari</p>
          <div className="warehouse-nav-items">
            {visibleTabs.filter((item) => (item.id !== 'suppliers' || canViewSupplierLedger) && (item.id !== 'cake_layers' || selectedLocationRecord?.location_type === 'production')).map(({ id, label, icon: Icon }) => (
              <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => changeTab(id)}>
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" /><span>{label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
      <div className={newLayerView ? 'warehouse-content' : undefined}>
      {loadWarning && (
        <div role="status" className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950 flex flex-col sm:flex-row sm:items-center gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 text-amber-700" />
          <p className="text-sm flex-1">{loadWarning}</p>
          <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading} className="shrink-0 bg-card">
            {loading ? 'Yuklanmoqda…' : 'Qayta yuklash'}
          </Button>
        </div>
      )}

      <div className="odina-panel catalog-toolbar warehouse-filterbar rounded-2xl bg-card border border-border premium-shadow p-4 sm:p-5 mb-5">
        <div className="warehouse-filter-fields flex flex-col sm:flex-row gap-3">
          {(user?.role === 'admin') ? (
            <label className="sm:w-72 space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">Ombor joylashuvi</span>
              <OdinaSelect
                value={selectedLocation}
                onChange={(event) => {
                  const next = locations.find((location) => location.id === event.target.value);
                  if (tab === 'cake_layers' && next?.location_type !== 'production') changeTab('ingredients');
                  setSelectedLocation(event.target.value);
                }}
                className="flex h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}{location.location_type === 'production' ? ' · Ishlab chiqarish' : ' · Do‘kon'}
                  </option>
                ))}
              </OdinaSelect>
            </label>
          ) : (
            <div className="sm:w-72">
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Sizning omboringiz</p>
              <div className="h-11 rounded-xl bg-secondary/70 px-3 flex items-center text-sm font-medium">
                {selectedLocationRecord?.name || assignedShopName || 'Joylashuv biriktirilmagan'}
              </div>
            </div>
          )}
          <label className="flex-1 space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Qidiruv</span>
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Qoldiq yoki tarixni qidirish…" aria-label="Qoldiq yoki tarixni qidirish" className="h-11 pl-10 rounded-xl bg-background" />
            </div>
          </label>
        </div>
        {tab === 'ingredients' && (
          <label className="warehouse-category-filter block mt-3 sm:max-w-xs space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Mahsulot turi</span>
            <OdinaSelect value={ingredientCategory} onChange={(event) => setIngredientCategory(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm">
              <option value="all">Barcha turlar</option>
              {Object.entries(INGREDIENT_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </OdinaSelect>
          </label>
        )}
      </div>

      {!selectedLocation ? (
        <div className="odina-panel rounded-2xl border border-border bg-card py-16 text-center">
          <WarehouseIcon className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="font-medium">Ombor joylashuvi biriktirilmagan</p>
          <p className="text-sm text-muted-foreground mt-1">Egasi ushbu xodimni joylashuvga biriktirishi kerak.</p>
        </div>
      ) : (
        <>
          {(!newLayerView || ['ingredients', 'products'].includes(tab)) && <div className="warehouse-summary-strip grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
            {newLayerView ? <>
              <Summary label="Filtrdagi turlar" value={items.length} />
              <Summary label="Qoldiq mavjud" value={items.filter((item) => Number(stockMap[item.id]?.quantity || 0) > 0).length} />
              <Summary label="Qoldiq yo‘q" value={items.filter((item) => Number(stockMap[item.id]?.quantity || 0) === 0).length} />
              <Summary label="Manfiy qoldiq" value={items.filter((item) => Number(stockMap[item.id]?.quantity || 0) < 0).length} />
            </> : <>
            <Summary label="Masalliqlar" value={ingredients.filter((item) => !isCakeLayer(item)).length} />
            <Summary label="Tayyor mahsulotlar" value={products.length} />
            <Summary label="Omborda mavjud turlar" value={stockedCount} />
            <Summary label="Ombor harakatlari" value={movements.filter((m) => m.location_id === selectedLocation).length} />
            </>}
          </div>}

          <div className={newLayerView ? 'hidden' : 'flex lg:hidden gap-2 overflow-x-auto pb-2 mb-3'}>
            {visibleTabs.filter((item) => (item.id !== 'suppliers' || canViewSupplierLedger) && (item.id !== 'cake_layers' || selectedLocationRecord?.location_type === 'production')).map(({ id, label, icon: Icon }) => (
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
            <HistoryList movements={visibleMovements} modernView={newLayerView} />
          ) : tab === 'suppliers' && canViewSupplierLedger ? (
            <SupplierLedgerPanel
              modernView={newLayerView}
              user={user}
              location={selectedLocationRecord}
              ingredients={ingredients.filter((ingredient) => !isCakeLayer(ingredient) || selectedLocationRecord?.location_type === 'production')}
              recipients={recipients}
              search={search}
            />
          ) : ['recipes', 'production', 'cake_layers'].includes(tab) ? (
            <ProductionPanel
              mode={tab}
              newLayerView={newLayerView}
              user={user}
              location={selectedLocationRecord}
              products={products}
              ingredients={ingredients}
              ingredientStock={ingredientStock}
              productStock={productStock}
              search={search}
              onReload={load}
              onCreateLayer={() => { setIngredientIsLayer(true); setIngredientOpen(true); }}
              onAdjustLayer={(item) => setAdjusting({ item, kind: 'ingredient' })}
              onTransfer={() => changeTab('transfers')}
            />
          ) : tab === 'transfers' ? (
            <TransfersPanel
              user={user}
              location={selectedLocationRecord}
              locations={locations}
              products={products}
              productStock={productStock}
              transfers={transfers}
              archivedProductIds={archivedProductIds}
              search={search}
              onReload={load}
            />
          ) : tab === 'demands' ? (
            <ShopDemandPanel user={user} products={products} locations={locations} />
          ) : tab === 'count' ? (
            <StockCountPanel user={user} location={selectedLocationRecord} locations={locations} />
          ) : (
            <>
              {tab === 'products' && selectedLocationRecord?.location_type === 'production' && visibleTabs.some((item) => item.id === 'production') && (
                <div className="rounded-2xl border border-primary/35 bg-primary/10 p-4 mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <ChefHat className="w-5 h-5 text-brand-ink shrink-0" />
                  <div className="flex-1">
                    <p className="font-semibold">Retsept bo‘yicha mahsulot kiritish</p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Un, shakar va boshqa masalliqlar tayyor mahsulot kiritilganda yoki buyurtmada “Tayyor bo‘ldi” tasdiqlanganda tex-karta bo‘yicha avtomatik kamayadi. Qo‘lda qoldiq tuzatish masalliqlarni o‘zgartirmaydi.
                    </p>
                  </div>
                  <Button type="button" onClick={() => changeTab('production')} className="shrink-0 bg-primary text-primary-foreground hover:bg-primary-strong">
                    <ChefHat className="w-4 h-4 mr-1.5" /> Ishlab chiqarishga o‘tish
                  </Button>
                </div>
              )}
              <StockGrid
                modernView={newLayerView}
                items={items}
                stockMap={stockMap}
                location={selectedLocationRecord}
                kind={tab === 'products' ? 'product' : 'ingredient'}
                onAdjust={user?.role === 'warehouse' ? null : (item) => setAdjusting({ item, kind: tab === 'products' ? 'product' : 'ingredient' })}
              />
            </>
          )}
        </>
      )}

      </div>
      </div>

      <IngredientDialog
        open={ingredientOpen}
        asLayer={ingredientIsLayer}
        existingIngredients={ingredients}
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
    <div className="odina-panel odina-summary rounded-2xl bg-card border border-border premium-shadow p-4 transition-all hover:-translate-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold mt-1">{formatNum(value)}</p>
    </div>
  );
}

function StockGrid({ items, stockMap, kind, location, onAdjust, modernView = false }) {
  if (!items.length) {
    return <div className="odina-panel rounded-2xl border border-border bg-card py-14 text-center text-sm text-muted-foreground">Mos mahsulot topilmadi.</div>;
  }
  return (
    modernView ? <section className="inventory-ledger" aria-label={kind === 'product' ? 'Tayyor mahsulotlar qoldig‘i' : 'Masalliqlar va qadoqlar qoldig‘i'}>
      <div className="catalog-section-heading">
        <div><h2>{kind === 'product' ? 'Mahsulot qoldiqlari' : 'Masalliq va qadoq qoldiqlari'}</h2><p>{location?.name}</p></div>
        <span className="catalog-result-count">{items.length} ta tur</span>
      </div>
      <div className="warehouse-table-wrap">
        <table className="warehouse-table inventory-ledger-table">
          <caption className="sr-only">{kind === 'product' ? 'Tayyor mahsulotlar qoldig‘i' : 'Masalliqlar va qadoqlar qoldig‘i'}</caption>
          <thead><tr><th scope="col">Nomi</th><th scope="col">{kind === 'product' ? 'Ta’minot turi' : 'Turi'}</th><th scope="col">Qoldiq</th><th scope="col">Birlik</th><th scope="col">Holati</th>{onAdjust && <th scope="col" className="inventory-action-heading">Amal</th>}</tr></thead>
          <tbody>{items.map((item) => {
            const stock = stockMap[item.id];
            const quantity = Number(stock?.quantity || 0);
            const unit = kind === 'ingredient' ? item.base_unit : (stock?.unit || (location?.location_type === 'production' ? item.production_unit || 'piece' : 'piece'));
            return <tr key={item.id}>
              <td data-label="Nomi" className="inventory-name"><strong>{item.name}</strong></td>
              <td data-label="Turi" className="inventory-category">{kind === 'ingredient' ? (INGREDIENT_CATEGORY_LABELS[item.category] || item.category) : (SOURCE_LABELS[item.source_type] || 'Markaziy ishlab chiqarishda tayyorlanadi')}</td>
              <td data-label="Qoldiq" className="warehouse-number">{formatNum(quantity)}</td>
              <td data-label="Birlik" className="inventory-unit">{UNIT_LABELS[unit] || unit}</td>
              <td data-label="Holati"><span className={`warehouse-status ${quantity > 0 ? 'bg-emerald-50 text-emerald-700' : quantity < 0 ? 'bg-red-50 text-destructive' : 'bg-secondary text-muted-foreground'}`}>{quantity > 0 ? 'Mavjud' : quantity < 0 ? 'Manfiy qoldiq' : 'Qoldiq yo‘q'}</span></td>
              {onAdjust && <td data-label="Amal" className="inventory-action"><Button type="button" variant="outline" onClick={() => onAdjust(item)} aria-label={item.name + ' — qoldiqni tuzatish'}><PackagePlus className="w-4 h-4 shrink-0" aria-hidden="true" /> Tuzatish</Button></td>}
            </tr>;
          })}</tbody>
        </table>
      </div>
    </section> :
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {items.map((item) => {
        const stock = stockMap[item.id];
        const quantity = Number(stock?.quantity || 0);
        const unit = kind === 'ingredient' ? item.base_unit : (stock?.unit || (location?.location_type === 'production' ? item.production_unit || 'piece' : 'piece'));
        return (
          <div key={item.id} className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4">
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
                <PackagePlus className="w-4 h-4 mr-1.5" /> {kind === 'product' ? 'Faqat qoldiqni tuzatish' : 'Boshlang‘ich qoldiq / tuzatish'}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryList({ movements, modernView = false }) {
  if (!movements.length) {
    return <div className="odina-panel rounded-2xl border border-border bg-card py-14 text-center text-sm text-muted-foreground">Bu joylashuvda ombor harakati yo‘q.</div>;
  }
  return (
    modernView ? <WarehouseHistoryTable movements={movements} movementLabels={MOVEMENT_LABELS} unitLabels={UNIT_LABELS} /> :
    <div className="space-y-3">
      {movements.map((movement) => (
        <div key={movement.id} className="odina-panel rounded-2xl bg-card border border-border p-4 flex items-start gap-3">
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
              {formatNum(movement.balance_before)} → {formatNum(movement.balance_after)} · {movement.user_name} · {formatUzbekistanDateTime(movement.created_at || movement.created_date)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function IngredientDialog({ open, asLayer = false, existingIngredients = [], onClose, onSaved }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('food');
  const [baseUnit, setBaseUnit] = useState('g');
  const [purchaseUnit, setPurchaseUnit] = useState('kg');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setCategory('food');
      setBaseUnit(asLayer ? 'piece' : 'g');
      setPurchaseUnit(asLayer ? 'piece' : 'kg');
    }
  }, [open, asLayer]);

  const save = async () => {
    if (!name.trim()) return;
    if (asLayer && existingIngredients.some((ingredient) => ingredient.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      void odinaAlert('Bu nomdagi karta mavjud. Mavjud kartadan foydalaning yoki qavat nomini aniqlashtiring.');
      return;
    }
    const validPair = (baseUnit === 'g' && ['g', 'kg'].includes(purchaseUnit))
      || (baseUnit === 'ml' && ['ml', 'l'].includes(purchaseUnit))
      || (baseUnit === 'piece' && purchaseUnit === 'piece');
    if (!validPair) {
      void odinaAlert('Xarid birligi asosiy birlikka mos bo‘lishi kerak.');
      return;
    }
    setSaving(true);
    try {
      await base44.entities.Ingredient.create({
        name: name.trim(),
        category: asLayer ? 'food' : category,
        base_unit: asLayer ? 'piece' : baseUnit,
        purchase_unit: asLayer ? 'piece' : purchaseUnit,
        conversion_to_base: asLayer ? 1 : (['kg', 'l'].includes(purchaseUnit) ? 1000 : 1),
        is_cake_layer: asLayer,
        active: true,
      });
      onSaved();
    } catch (error) {
      void odinaAlert('Masalliqni yaratib bo‘lmadi: ' + (error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="warehouse-dialog sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle className="font-display text-xl">{asLayer ? 'Yangi qavat / list turi' : 'Yangi masalliq, qadoq yoki xo‘jalik buyumi'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Nomi</Label>
            <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={asLayer ? "Masalan: oq biskvit — katta list" : "Masalan: un, sut, tort qutisi"} />
          </div>
          {!asLayer && <>
          <div>
            <Label className="text-xs mb-1.5 block">Turi</Label>
            <OdinaSelect value={category} onChange={(event) => setCategory(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
              <option value="food">Oziq-ovqat masallig‘i</option>
              <option value="packaging">Qadoqlash</option>
              <option value="household">Xo‘jalik va tozalash</option>
            </OdinaSelect>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs mb-1.5 block">Retsept / ombor birligi</Label>
              <OdinaSelect value={baseUnit} onChange={(event) => {
                const value = event.target.value;
                setBaseUnit(value);
                setPurchaseUnit(value === 'g' ? 'kg' : value === 'ml' ? 'l' : 'piece');
              }} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
                <option value="g">Gramm (g)</option>
                <option value="ml">Millilitr (ml)</option>
                <option value="piece">Dona</option>
              </OdinaSelect>
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Odatda qaysi birlikda olinadi</Label>
              <OdinaSelect value={purchaseUnit} onChange={(event) => setPurchaseUnit(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
                {baseUnit === 'g' && <><option value="kg">Kilogramm (kg)</option><option value="g">Gramm (g)</option></>}
                {baseUnit === 'ml' && <><option value="l">Litr (L)</option><option value="ml">Millilitr (ml)</option></>}
                {baseUnit === 'piece' && <option value="piece">Dona</option>}
              </OdinaSelect>
            </div>
          </div>
          <p className="text-xs text-muted-foreground rounded-xl bg-secondary/60 p-3">
            Kilogramm va litr avtomatik ravishda 1 000 gramm yoki millilitrga aylantiriladi.
          </p>
          </>}
          {asLayer && <p className="text-sm rounded-xl bg-secondary/60 p-3">Birlik: butun list/qavat. Turini yaratgach, haqiqiy qoldiqni “Qavat kirimi / tuzatish” orqali kiriting.</p>}
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

  const unit = kind === 'ingredient' ? item?.base_unit : (location?.location_type === 'production' ? item?.production_unit || 'piece' : 'piece');
  const unitLabel = kind === 'ingredient' ? ingredientUnitLabel(item) : (UNIT_LABELS[unit] || unit);
  const change = (mode === 'remove' ? -1 : 1) * Number(quantity || 0);
  const after = current + change;

  const save = async () => {
    if (!item || !location || !Number.isFinite(change) || change === 0 || !reason.trim()) return;
    if (isCakeLayer(item) && !Number.isSafeInteger(change)) {
      void odinaAlert('Butun list/qavat sonini kiriting.');
      return;
    }
    if (after < 0) {
      void odinaAlert('Ombor qoldig‘i manfiy bo‘lishi mumkin emas.');
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
      void odinaAlert('Ombor yangilanishi amalga oshmadi: ' + (error?.response?.data?.error || error?.data?.error || error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="warehouse-dialog sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{kind === 'product' ? 'Tayyor mahsulot qoldig‘ini tuzatish' : 'Ombor qoldig‘ini yangilash'}</DialogTitle>
          <p className="text-sm text-muted-foreground">{item?.name} · {location?.name}</p>
        </DialogHeader>
        <div className="space-y-4">
          {kind === 'product' && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Bu qo‘lda qoldiq tuzatish oynasi. Retsept ishlamaydi va un, shakar hamda boshqa masalliqlar kamaymaydi. Ishlab chiqarilgan mahsulotni “Ishlab chiqarish” bo‘limidan kiriting.
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant={mode === 'add' ? 'default' : 'outline'} onClick={() => setMode('add')} className={mode === 'add' ? 'bg-primary text-primary-foreground hover:bg-primary-strong' : ''}>{kind === 'product' ? 'Qoldiqni oshirish' : 'Kirim qilish'}</Button>
            <Button type="button" variant={mode === 'remove' ? 'destructive' : 'outline'} onClick={() => setMode('remove')}>{kind === 'product' ? 'Qoldiqni kamaytirish' : 'Chiqim qilish'}</Button>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Miqdor ({unitLabel})</Label>
            <Input autoFocus type="number" min={kind === 'product' || unit === 'piece' ? '1' : '0.001'} step={kind === 'product' || unit === 'piece' ? '1' : '0.001'} value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="0" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Sabab</Label>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Doimiy ombor tarixi uchun majburiy" rows={2} />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Yozuv turi</Label>
            <OdinaSelect value={movementType} onChange={(event) => setMovementType(event.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
              <option value="opening">Boshlang‘ich qoldiq</option>
              <option value="adjustment">Qo‘lda tuzatish</option>
            </OdinaSelect>
          </div>
          <div className="rounded-xl bg-secondary/60 p-3 text-sm flex items-center justify-between">
            <span className="text-muted-foreground">O‘zgarishdan keyingi qoldiq</span>
            <span className={`font-semibold ${after < 0 ? 'text-destructive' : ''}`}>{formatNum(after)} {unitLabel}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving || !quantity || !reason.trim() || after < 0} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            {saving ? 'Saqlanmoqda…' : (kind === 'product' ? 'Faqat qoldiqni saqlash' : 'Tarix bilan saqlash')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

