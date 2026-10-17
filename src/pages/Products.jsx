import React, { useEffect, useState, useMemo } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';
import { Cake, Plus, Search, Pencil, Star, Upload, Loader2, Trash2, ArchiveRestore } from 'lucide-react';
import { formatUZS, logAction } from '@/lib/pos';
import { priceForShop } from '@/lib/shop-pricing';
import { categoryForShop, catalogForShop } from '@/lib/shop-category';
import PageHeader from '@/components/PageHeader';
import TestCatalogCleanup from '@/components/TestCatalogCleanup';
import CakeStockShelf from '@/components/products/CakeStockShelf';
import { loadAllInventoryItems } from '@/lib/cake-stock-shelf';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';
import { productPhotoFallbackFor } from '@/lib/product-photos';
import '@/styles/catalog-workbench.css';

export default function Products() {
  const { user, adminShopScope } = useOutletContext();
  const shopScope = user?.role === 'admin' && adminShopScope?.isAdmin ? adminShopScope : null;
  const scopedShopId = shopScope?.specificShopId || '';
  const role = user?.role || 'cashier';
  const canManageCatalog = role === 'admin' || role === 'accountant';
  const [products, setProducts] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [categories, setCategories] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [productView, setProductView] = useState('stock');
  const [loadError, setLoadError] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [shopPriceProduct, setShopPriceProduct] = useState(null);
  const [shopPrice, setShopPrice] = useState('');
  const [savingShopPrice, setSavingShopPrice] = useState(false);
  useEffect(() => shopScope?.registerGuard?.(() => open || shopPriceProduct || savingShopPrice
    ? 'Avval mahsulot oynasini yoping yoki saqlash tugashini kuting.' : ''),
  [shopScope?.registerGuard, open, shopPriceProduct, savingShopPrice]);
  const scopedCatalog = useMemo(() => scopedShopId
    ? catalogForShop(products, categories, scopedShopId) : { products, categories }, [products, categories, scopedShopId]);

  const saveShopPrice = async () => {
    if (savingShopPrice || !shopPriceProduct) return;
    const value = Number(shopPrice);
    if (!shopPrice.trim() || !Number.isSafeInteger(value) || value < 0) return;
    setSavingShopPrice(true);
    try {
      const response = await base44.functions.invoke('manager-shop', { action: 'set_product_price', product_id: shopPriceProduct.id, price: value });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Narx saqlanmadi.');
      setProducts((rows) => rows.map((row) => row.id === result.product_id ? { ...row, shop_prices: { ...(row.shop_prices || {}), [result.shop_id]: result.price } } : row));
      setShopPriceProduct(null);
    } catch (error) { void odinaAlert(error?.response?.data?.error || error?.message || 'Narx saqlanmadi.'); }
    finally { setSavingShopPrice(false); }
  };

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [p, c, s, materials] = await Promise.all([loadAllInventoryItems(base44.entities.Product, '-created_date'), base44.entities.Category.list('-created_date', 500), base44.entities.Shop.list(), loadAllInventoryItems(base44.entities.Ingredient)]);
      setProducts(p || []);
      setIngredients(materials || []);
      setCategories(c || []);
      setShops((s || []).filter((shop) => shop.location_type === 'shop' && shop.active !== false));
    } catch (error) { setLoadError(error?.message || 'Mahsulotlar yuklanmadi. Qayta urinib ko‘ring.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    let list = scopedCatalog.products.filter((p) => showArchived ? p.archived === true : p.archived !== true);
    if (filterCat !== 'all') list = list.filter((p) => categoryForShop(p, scopedShopId) === filterCat);
    if (search.trim()) list = list.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
    return list;
  }, [scopedCatalog, scopedShopId, filterCat, search, showArchived]);
  useEffect(() => { setFilterCat('all'); }, [scopedShopId]);

  const openNew = () => { setEditing(null); setOpen(true); };
  const openEdit = (p) => { setEditing(p); setOpen(true); };

  const onSaved = () => { setOpen(false); load(); };

  const localizedCategoryName = (name) => ({
    Cakes: 'Tortlar',
    Pastries: 'Pishiriqlar',
    Cookies: 'Pechenyelar',
    Drinks: 'Ichimliklar',
    Cupcakes: 'Kapkeyklar',
    Desserts: 'Desertlar',
  }[name] || name || 'Kategoriyasiz');

  const setAvailability = async (product) => {
    try {
      const result = await base44.functions.invoke('set-product-availability', {
        product_id: product.id,
        active: product.active === false,
      });
      const payload = result?.data || result;
      if (!payload?.product) throw new Error(payload?.error || 'Mavjudlik holatini yangilab bo‘lmadi.');
      setProducts((items) => items.map((p) => p.id === product.id ? payload.product : p));
    } catch (e) { void odinaAlert('Mavjudlikni yangilashda xato: ' + (e?.message || e)); }
  };

  return (
    <div className="odina-page odina-workbench catalog-workbench catalog-products p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in">
      <PageHeader
        title="Mahsulotlar"
        subtitle={productView === 'stock' ? 'Tortlar, sut, kofe va boshqa mahsulotlarning kirim-chiqimi va qoldig‘i' : `${scopedCatalog.products.filter((p) => p.archived !== true).length} ta mahsulot turi`}
        icon={Cake}
        actions={canManageCatalog && (
          <Button onClick={openNew} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            <Plus className="w-4 h-4 mr-1.5" /> Yangi mahsulot turi
          </Button>
        )}
      />

      <div className="flex flex-wrap gap-2 mb-5" role="group" aria-label="Mahsulotlar ko‘rinishi">
        <Button type="button" variant={productView === 'stock' ? 'default' : 'outline'} aria-pressed={productView === 'stock'} onClick={() => setProductView('stock')} className="min-h-11 rounded-xl">Kirim va qoldiq</Button>
        <Button type="button" variant={productView === 'catalog' ? 'default' : 'outline'} aria-pressed={productView === 'catalog'} onClick={() => setProductView('catalog')} className="min-h-11 rounded-xl">Mahsulotlar katalogi</Button>
      </div>
      {loadError && <div role="alert" className="rounded-xl border border-border p-4 mb-5"><p>{loadError}</p><Button type="button" variant="outline" onClick={load} className="mt-3">Qayta yuklash</Button></div>}
      {productView === 'stock' ? (loading ? <div className="h-56 rounded-2xl bg-secondary animate-pulse" aria-label="Mahsulotlar yuklanmoqda" /> : !loadError && <CakeStockShelf user={user} adminShopScope={shopScope} products={products} categories={categories} shops={shopScope?.shops || shops} ingredients={ingredients} />) : <>
      {shopScope && <p className="mb-4 text-sm text-muted-foreground">{scopedShopId ? (shopScope.shops.find((shop) => shop.id === scopedShopId)?.name || 'Tanlangan do‘kon') + ' katalogi va narxlari.' : 'Barcha do‘konlar katalogi.'} Mahsulot turini tahrirlash umumiy katalogga tegishli. Sotuvga chiqarish yoki sotuvdan olish barcha do‘konlarga ta’sir qiladi.</p>}
      {!loading && <TestCatalogCleanup user={user} products={products} onComplete={load} />}

      <div className="odina-panel catalog-toolbar catalog-product-toolbar flex flex-col sm:flex-row gap-3 mb-5 rounded-2xl bg-card border border-border premium-shadow p-3 sm:p-4">
        <label className="catalog-filter-field flex-1">
          <span>Mahsulot qidirish</span>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mahsulot nomini kiriting…" className="pl-9 h-11 rounded-xl" />
          </div>
        </label>
        <label className="catalog-filter-field catalog-category-field"><span>Kategoriya</span>
        <OdinaSelect value={filterCat} onChange={(e) => setFilterCat(e.target.value)} className="h-11 rounded-xl border border-input bg-background px-3 text-sm font-medium sm:w-56">
          <option value="all">Barcha kategoriyalar</option>
          {scopedCatalog.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </OdinaSelect>
        </label>
        {role === 'admin' && (
          <Button variant="outline" aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)} className="catalog-archive-toggle whitespace-nowrap min-h-11 rounded-xl touch-manipulation">
            {showArchived ? <Cake className="w-4 h-4 mr-1.5" /> : <Trash2 className="w-4 h-4 mr-1.5" />}
            {showArchived ? 'Faol mahsulotlar' : 'Arxiv' }
          </Button>
        )}
      </div>

      <div className="catalog-section-heading">
        <div><h2>{showArchived ? 'Arxivdagi mahsulotlar' : 'Mahsulotlar katalogi'}</h2><p>Mahsulot, kategoriya va sotuv narxi</p></div>
        <span className="catalog-result-count" aria-live="polite">{filtered.length} ta mahsulot</span>
      </div>

      {loading ? (
        <div className="catalog-product-grid">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-40 rounded-2xl bg-secondary animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="catalog-empty"><Cake className="w-10 h-10" aria-hidden="true" /><h3>Mahsulot topilmadi</h3><p>Qidiruv yoki kategoriya filtrini o‘zgartiring.</p>{(search || filterCat !== 'all') && <Button variant="outline" onClick={() => { setSearch(''); setFilterCat('all'); }}>Filtrlarni tozalash</Button>}</div>
      ) : (
        <div className="catalog-product-grid">
          {filtered.map((p) => {
            const fallbackPhoto = !p.image_url && productPhotoFallbackFor(p.id);
            const imageSrc = p.image_url || fallbackPhoto;
            return (
            <article key={p.id} className={`odina-panel catalog-product-card rounded-2xl bg-card border border-border overflow-hidden ${p.active === false ? 'is-unavailable' : ''}`}>
              <div className="catalog-product-image relative bg-secondary/70 overflow-hidden">
                {imageSrc ? (
                  <Image src={imageSrc} alt={p.name} fittingType={fallbackPhoto ? 'fit' : 'fill'} className="w-full h-full" style={fallbackPhoto ? { objectFit: 'contain', backgroundColor: '#fff' } : undefined} />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground/35">
                    <Cake className="w-8 h-8" />
                    <span className="text-xs font-medium">Rasm yo‘q</span>
                  </div>
                )}
                {p.is_favorite && <span className="catalog-favorite" aria-label="Sevimli mahsulot"><Star className="w-4 h-4 fill-primary text-primary" aria-hidden="true" /></span>}
              </div>
              <div className="catalog-product-info">
                <div className="catalog-product-heading"><h3>{p.name}</h3><span className={`catalog-product-status ${p.active === false ? '' : 'is-active'}`}>{p.active === false ? 'Sotuvda emas' : 'Sotuvda'}</span></div>
                <p className="catalog-product-category">{localizedCategoryName(categories.find((c) => c.id === categoryForShop(p, scopedShopId))?.name || p.category_name)}</p>
                <div className={`catalog-product-price ${priceForShop(p, scopedShopId) === 0 ? 'text-muted-foreground' : 'text-brand-ink'}`}>
                  {priceForShop(p, scopedShopId) === 0 ? '0 so‘m' : formatUZS(priceForShop(p, scopedShopId))}
                  <span>{p.sale_unit === 'gram' ? '/ 1 kg' : p.production_unit === 'sheet' ? '/ bo‘lak' : '/ dona'}</span>
                </div>
                {!scopedShopId && shops.some((shop) => priceForShop(p, shop.id) !== Number(p.price)) && (
                  <div className="catalog-shop-prices">
                    {shops.map((shop) => `${shop.name}: ${formatUZS(priceForShop(p, shop.id))}`).join(' · ')}
                  </div>
                )}
              </div>
              <div className="catalog-product-actions">
                {canManageCatalog && <Button variant="outline" size="sm" onClick={() => openEdit(p)} aria-label={`${p.name} mahsulotini umumiy katalogda tahrirlash`}><Pencil className="w-4 h-4" aria-hidden="true" /> {shopScope ? 'Umumiy katalogni tahrirlash' : 'Tahrirlash'}</Button>}
                {role === 'manager' && <Button variant="outline" size="sm" onClick={() => { setShopPriceProduct(p); setShopPrice(String(priceForShop(p, user.shop_id))); }}>Do‘kon narxi: {formatUZS(priceForShop(p, user.shop_id))}</Button>}
                {(role === 'production' || canManageCatalog) && (
                  <Button variant="outline" size="sm" className="catalog-availability" onClick={() => setAvailability(p)}>
                    {shopScope ? (p.active === false ? 'Barcha do‘konlarda sotuvga chiqarish' : 'Barcha do‘konlarda sotuvdan olish') : p.active === false ? 'Sotuvga chiqarish' : 'Sotuvdan olish'}
                  </Button>
                )}
              </div>
            </article>
            );
          })}
        </div>
      )}

      </>}
      <Dialog open={Boolean(shopPriceProduct)} onOpenChange={(value) => { if (!value && !savingShopPrice) setShopPriceProduct(null); }}>
        <DialogContent><DialogHeader><DialogTitle>{shopPriceProduct?.name} — do‘kon narxi</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{user?.shop_name} uchun sotuv narxi</p>
          <Label>Narx (so‘m)</Label><Input type="number" min="0" step="1000" value={shopPrice} onChange={(event) => setShopPrice(event.target.value)} />
          <DialogFooter><Button disabled={savingShopPrice || !shopPrice.trim() || !Number.isSafeInteger(Number(shopPrice)) || Number(shopPrice) < 0} onClick={saveShopPrice}>{savingShopPrice ? 'Saqlanmoqda…' : 'Saqlash'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ProductDialog open={open} product={editing} categories={categories} shops={shops} onClose={() => setOpen(false)} onSaved={onSaved} user={user} canArchive={role === 'admin'} />
    </div>
  );
}

function ProductDialog({ open, product, categories, shops, onClose, onSaved, user, canArchive }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [saleUnit, setSaleUnit] = useState('piece');
  const [shopPrices, setShopPrices] = useState({});
  const [categoryId, setCategoryId] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [description, setDescription] = useState('');
  const [sourceType, setSourceType] = useState('central_produced');
  const [productionUnit, setProductionUnit] = useState('piece');
  const [piecesPerSheet, setPiecesPerSheet] = useState(20);
  const [sheetPrice, setSheetPrice] = useState('');
  const [isFavorite, setIsFavorite] = useState(false);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(product?.name || '');
      setPrice(product?.price ?? '');
      setSaleUnit(product?.sale_unit || 'piece');
      setShopPrices(product?.shop_prices || {});
      setCategoryId(product?.category_id || (categories[0]?.id || ''));
      setImageUrl(product?.image_url || '');
      setDescription(product?.description || '');
      setSourceType(product?.source_type || 'central_produced');
      setProductionUnit(product?.production_unit || 'piece');
      setPiecesPerSheet(product?.pieces_per_sheet || 20);
      setSheetPrice(product?.sheet_price ?? '');
      setIsFavorite(product?.is_favorite || false);
      setActive(product?.active !== false);
    }
  }, [open, product]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setImageUrl(file_url);
    } catch (err) { void odinaAlert('Rasmni yuklashda xato: ' + (err?.message || err)); }
    finally { setUploading(false); }
  };

  const save = async () => {
    if (!name.trim() || price === '' || !Number.isFinite(Number(price)) || Number(price) < 0) {
      void odinaAlert('Nomi va manfiy bo‘lmagan narx majburiy.'); return;
    }
    if (shops.some((shop) => shopPrices[shop.id] !== undefined
      && (!Number.isSafeInteger(Number(shopPrices[shop.id])) || String(shopPrices[shop.id]).trim() === '' || Number(shopPrices[shop.id]) < 0))) {
      void odinaAlert('Har bir do‘kon narxi musbat yoki 0 bo‘lgan butun son bo‘lishi kerak.'); return;
    }
    if (productionUnit === 'sheet' && (!Number.isSafeInteger(Number(piecesPerSheet)) || Number(piecesPerSheet) < 1
      || sheetPrice === '' || !Number.isFinite(Number(sheetPrice)) || Number(sheetPrice) < 0)) {
      void odinaAlert('1 listdan chiqadigan butun bo‘lak soni va list narxini kiriting.'); return;
    }
    setSaving(true);
    const cat = categories.find((c) => c.id === categoryId);
    const payload = {
      name: name.trim(),
      price: Number(price),
      shop_prices: Object.fromEntries(Object.entries(shopPrices).map(([id, value]) => [id, Number(value)])),
      category_id: categoryId || undefined,
      category_name: cat?.name,
      image_url: imageUrl || undefined,
      description: description || undefined,
      source_type: sourceType,
      stock_unit: 'piece',
      sale_unit: saleUnit,
      production_unit: productionUnit,
      ...(!product ? { pieces_per_sheet: productionUnit === 'sheet' ? Number(piecesPerSheet) : 1 } : {}),
      sheet_price: productionUnit === 'sheet' ? Number(sheetPrice) : 0,
      track_stock: saleUnit !== 'gram',
      is_favorite: isFavorite,
      active,
    };
    try {
      if (product) {
        await base44.entities.Product.update(product.id, payload);
        await logAction(user, 'product_updated', payload.name);
      } else {
        await base44.entities.Product.create(payload);
        await logAction(user, 'product_created', payload.name);
      }
      onSaved();
    } catch (e) { void odinaAlert('Saqlashda xato: ' + (e?.message || e)); }
    finally { setSaving(false); }
  };

  const setArchived = async (archived) => {
    const question = archived
      ? `“${product?.name}” mahsulotini o‘chirishni tasdiqlaysizmi? Eski savdo va hisobotlar saqlanadi.`
      : `“${product?.name}” mahsulotini qayta tiklaysizmi?`;
    if (!product) return;
    const accepted = await odinaConfirm(question, {
      title: archived ? 'Mahsulotni o‘chirish' : 'Mahsulotni tiklash',
      tone: archived ? 'danger' : 'warning',
      confirmLabel: archived ? 'O‘chirish' : 'Qayta tiklash',
    });
    if (!accepted) return;
    setArchiving(true);
    try {
      await base44.entities.Product.update(product.id, { archived, active: archived ? false : true });
      await logAction(user, archived ? 'product_archived' : 'product_restored', product.name);
      onSaved();
    } catch (e) {
      void odinaAlert((archived ? 'Mahsulotni o‘chirishda xato: ' : 'Mahsulotni tiklashda xato: ') + (e?.message || e));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{product ? 'Mahsulotni tahrirlash' : 'Yangi mahsulot'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-4">
            <div className="w-28 h-28 rounded-2xl bg-secondary overflow-hidden border border-border shrink-0">
              {imageUrl ? <img src={imageUrl} alt={name ? `${name} rasmi` : 'Mahsulot rasmi'} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-muted-foreground/40"><Cake className="w-8 h-8" /></div>}
            </div>
            <div className="flex-1 space-y-2">
              <Label className="text-xs">Mahsulot rasmi</Label>
              <label className="inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg border border-border cursor-pointer hover:bg-secondary transition-colors">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? 'Yuklanmoqda…' : 'Rasm yuklash'}
                <input type="file" accept="image/*" className="hidden" onChange={handleUpload} disabled={uploading} />
              </label>
              <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="…yoki rasm havolasini kiriting" className="h-9 text-xs" />
            </div>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Nomi</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Masalan: Shokoladli tort" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs mb-1.5 block">{saleUnit === 'gram' ? '1 kg narxi (UZS)' : productionUnit === 'sheet' ? '1 bo‘lak narxi (UZS)' : '1 dona narxi (UZS)'}</Label>
              <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="45000" />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Kategoriya</Label>
              <OdinaSelect value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
                <option value="">Tanlanmagan</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </OdinaSelect>
            </div>
          </div>
          {shops.length > 0 && (
            <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-3">
              <p className="text-xs text-muted-foreground">Mahsulot barcha do‘konlarda ko‘rinadi. Har bir do‘kon narxini shu yerda alohida o‘zgartiring.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {shops.map((shop) => (
                  <div key={shop.id}>
                    <Label className="text-xs mb-1.5 block">{shop.name} {saleUnit === 'gram' ? '1 kg' : ''} narxi (UZS)</Label>
                    <Input type="number" min="0" step="1" value={shopPrices[shop.id] ?? price}
                      onChange={(e) => setShopPrices((current) => ({ ...current, [shop.id]: e.target.value }))} />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <Label className="text-xs mb-1.5 block">Mahsulot qayerdan ta’minlanadi</Label>
            <OdinaSelect value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
              <option value="central_produced">Markaziy ishlab chiqarishda tayyorlanadi</option>
              <option value="shop_prepared">Har bir do‘konda tayyorlanadi</option>
              <option value="resale">Sotish uchun tayyor holda xarid qilinadi</option>
            </OdinaSelect>
            <p className="text-xs text-muted-foreground mt-1.5">Bu tanlov keyingi bosqichdagi retsept va avtomatik ombor qoidalari uchun ishlatiladi.</p>
          </div>
          <div className="rounded-xl border border-primary/25 bg-primary/5 p-3 space-y-3">
            <div>
              <Label className="text-xs mb-1.5 block">Mahsulot turi</Label>
              <OdinaSelect value={saleUnit === 'gram' ? 'gram' : productionUnit} disabled={Boolean(product)}
                onChange={(e) => {
                  setSaleUnit(e.target.value === 'gram' ? 'gram' : 'piece');
                  setProductionUnit(e.target.value === 'sheet' ? 'sheet' : 'piece');
                }} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm disabled:opacity-60">
                <option value="piece">Donali — narx 1 dona uchun</option>
                <option value="sheet">Listli — kassada bo‘laklab sotiladi</option>
                <option value="gram">Vaznli — narx 1 kg uchun</option>
              </OdinaSelect>
            </div>
            {productionUnit === 'sheet' && (
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs mb-1.5 block">1 listdan bo‘lak soni</Label><Input type="number" min="1" step="1" value={piecesPerSheet} disabled={Boolean(product)} onChange={(e) => setPiecesPerSheet(e.target.value)} /></div>
                <div><Label className="text-xs mb-1.5 block">1 list narxi (UZS)</Label><Input type="number" min="0" value={sheetPrice} onChange={(e) => setSheetPrice(e.target.value)} /></div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{saleUnit === 'gram' ? 'Kassada gramm kiritiladi va summa avtomatik hisoblanadi. Ombor hisobi hozircha yuritilmaydi.' : productionUnit === 'sheet' ? `Markazda list. Do‘kon qabul qilganda 1 list → ${piecesPerSheet} bo‘lak. Kassa narxi — bitta bo‘lak uchun.` : 'Narx bitta dona uchun. Kassada dona soni bilan sotiladi.'}</p>
            {product && <p className="text-xs text-muted-foreground">Qoldiq birliklari aralashmasligi uchun mavjud mahsulotning birligi va bo‘lak soni o‘zgarmaydi. Boshqa kesim uchun yangi mahsulot yarating.</p>}
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Tavsif</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ixtiyoriy" />
          </div>
          <div className="flex items-center gap-5">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={isFavorite} onChange={(e) => setIsFavorite(e.target.checked)} className="w-4 h-4 accent-primary" />
              Sevimli
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-primary" />
              Faol
            </label>
          </div>
        </div>
        <DialogFooter className="mt-4 sm:justify-between">
          <div>
            {product && canArchive && (
              <Button
                variant="outline"
                onClick={() => setArchived(product.archived !== true)}
                disabled={saving || archiving}
                className={product.archived ? "text-emerald-700" : "text-destructive hover:text-destructive"}
              >
                {product.archived ? <ArchiveRestore className="w-4 h-4 mr-1.5" /> : <Trash2 className="w-4 h-4 mr-1.5" />}
                {archiving ? 'Bajarilmoqda…' : product.archived ? 'Qayta tiklash' : 'Mahsulotni o‘chirish'}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving || archiving}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving || archiving} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            {saving ? 'Saqlanmoqda…' : 'Saqlash'}
          </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
