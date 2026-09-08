import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Cake, Plus, Search, Pencil, Star, Upload, Loader2, Trash2, ArchiveRestore } from 'lucide-react';
import { formatUZS, logAction } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import TestCatalogCleanup from '@/components/TestCatalogCleanup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';

export default function Products() {
  const { user } = useOutletContext();
  const role = user?.role || 'cashier';
  const canManageCatalog = role === 'admin' || role === 'accountant';
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const [p, c] = await Promise.all([base44.entities.Product.list(), base44.entities.Category.list()]);
    setProducts(p || []);
    setCategories(c || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    let list = products.filter((p) => showArchived ? p.archived === true : p.archived !== true);
    if (filterCat !== 'all') list = list.filter((p) => p.category_id === filterCat);
    if (search.trim()) list = list.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
    return list;
  }, [products, filterCat, search, showArchived]);

  const openNew = () => { setEditing(null); setOpen(true); };
  const openEdit = (p) => { setEditing(p); setOpen(true); };

  const onSaved = () => { setOpen(false); load(); };

  const setAvailability = async (product) => {
    try {
      const result = await base44.functions.invoke('set-product-availability', {
        product_id: product.id,
        active: product.active === false,
      });
      const payload = result?.data || result;
      if (!payload?.product) throw new Error(payload?.error || 'Mavjudlik holatini yangilab bo‘lmadi.');
      setProducts((items) => items.map((p) => p.id === product.id ? payload.product : p));
    } catch (e) { alert('Mavjudlikni yangilashda xato: ' + (e?.message || e)); }
  };

  return (
    <div className="odina-page p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in">
      <PageHeader
        title="Mahsulotlar"
        subtitle={`${products.filter((p) => p.archived !== true).length} ta faol mahsulot`}
        icon={Cake}
        actions={canManageCatalog && (
          <Button onClick={openNew} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            <Plus className="w-4 h-4 mr-1.5" /> Mahsulot qo‘shish
          </Button>
        )}
      />

      {!loading && <TestCatalogCleanup user={user} products={products} onComplete={load} />}

      <div className="odina-panel flex flex-col sm:flex-row gap-3 mb-5 rounded-2xl bg-card border border-border premium-shadow p-3 sm:p-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mahsulotlarni qidirish…" className="pl-9 h-11 rounded-xl" />
        </div>
        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} className="h-11 rounded-xl border border-input bg-background px-3 text-sm font-medium sm:w-56">
          <option value="all">Barcha kategoriyalar</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {role === 'admin' && (
          <Button variant="outline" onClick={() => setShowArchived((value) => !value)} className="whitespace-nowrap min-h-11 rounded-xl touch-manipulation">
            {showArchived ? <Cake className="w-4 h-4 mr-1.5" /> : <Trash2 className="w-4 h-4 mr-1.5" />}
            {showArchived ? 'Faol mahsulotlar' : 'Arxiv' }
          </Button>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-52 rounded-2xl bg-secondary animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20"><div className="text-5xl mb-3">🍰</div><p className="text-sm text-muted-foreground">Mahsulot topilmadi.</p></div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {filtered.map((p) => (
            <div key={p.id} className="odina-panel group rounded-2xl bg-card border border-border premium-shadow overflow-hidden transition-all hover:-translate-y-0.5 hover:premium-shadow-lg">
              <div className="relative aspect-square bg-secondary overflow-hidden">
                {p.image_url ? <Image src={p.image_url} alt={p.name} fittingType="fill" className="w-full h-full" /> : <div className="w-full h-full flex items-center justify-center text-3xl font-display text-muted-foreground/40">{p.name.charAt(0)}</div>}
                {p.is_favorite && <Star className="absolute top-2 left-2 w-4 h-4 fill-primary text-primary" />}
                {!p.active && <div className="absolute inset-0 bg-foreground/40 flex items-center justify-center text-white text-xs font-semibold">Mavjud emas</div>}
                {canManageCatalog && (
                  <button onClick={() => openEdit(p)} className="absolute top-2 right-2 w-10 h-10 rounded-full bg-card/95 backdrop-blur flex items-center justify-center opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity shadow touch-manipulation">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="p-3">
                <div className="text-sm font-semibold truncate">{p.name}</div>
                <div className="text-xs text-muted-foreground">{p.category_name || 'Kategoriyasiz'}</div>
                <div className="text-[15px] font-bold text-brand-ink mt-1">{formatUZS(p.price)}</div>
                {(role === 'production' || canManageCatalog) && (
                  <Button variant="outline" size="sm" className="w-full mt-2 min-h-10 rounded-xl text-xs touch-manipulation" onClick={() => setAvailability(p)}>
                    {p.active === false ? 'Sotuvga chiqarish' : 'Sotuvdan vaqtincha olish'}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <ProductDialog open={open} product={editing} categories={categories} onClose={() => setOpen(false)} onSaved={onSaved} user={user} canArchive={role === 'admin'} />
    </div>
  );
}

function ProductDialog({ open, product, categories, onClose, onSaved, user, canArchive }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
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
    } catch (err) { alert('Rasmni yuklashda xato: ' + (err?.message || err)); }
    finally { setUploading(false); }
  };

  const save = async () => {
    if (!name.trim() || price === '' || !Number.isFinite(Number(price)) || Number(price) < 0) {
      alert('Nomi va manfiy bo‘lmagan narx majburiy.'); return;
    }
    if (productionUnit === 'sheet' && (!Number.isSafeInteger(Number(piecesPerSheet)) || Number(piecesPerSheet) < 1
      || sheetPrice === '' || !Number.isFinite(Number(sheetPrice)) || Number(sheetPrice) < 0)) {
      alert('1 listdan chiqadigan butun bo‘lak soni va list narxini kiriting.'); return;
    }
    setSaving(true);
    const cat = categories.find((c) => c.id === categoryId);
    const payload = {
      name: name.trim(),
      price: Number(price),
      category_id: categoryId || undefined,
      category_name: cat?.name,
      image_url: imageUrl || undefined,
      description: description || undefined,
      source_type: sourceType,
      stock_unit: 'piece',
      production_unit: productionUnit,
      pieces_per_sheet: productionUnit === 'sheet' ? Number(piecesPerSheet) : 1,
      sheet_price: productionUnit === 'sheet' ? Number(sheetPrice) : 0,
      track_stock: true,
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
    } catch (e) { alert('Saqlashda xato: ' + (e?.message || e)); }
    finally { setSaving(false); }
  };

  const setArchived = async (archived) => {
    const question = archived
      ? `“${product?.name}” mahsulotini o‘chirishni tasdiqlaysizmi? Eski savdo va hisobotlar saqlanadi.`
      : `“${product?.name}” mahsulotini qayta tiklaysizmi?`;
    if (!product || !window.confirm(question)) return;
    setArchiving(true);
    try {
      await base44.entities.Product.update(product.id, { archived, active: archived ? false : true });
      await logAction(user, archived ? 'product_archived' : 'product_restored', product.name);
      onSaved();
    } catch (e) {
      alert((archived ? 'Mahsulotni o‘chirishda xato: ' : 'Mahsulotni tiklashda xato: ') + (e?.message || e));
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
              {imageUrl ? <img src={imageUrl} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-muted-foreground/40"><Cake className="w-8 h-8" /></div>}
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
              <Label className="text-xs mb-1.5 block">{productionUnit === 'sheet' ? '1 bo‘lak narxi (UZS)' : '1 dona narxi (UZS)'}</Label>
              <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="45000" />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Kategoriya</Label>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
                <option value="">Tanlanmagan</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Mahsulot qayerdan ta’minlanadi</Label>
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
              <option value="central_produced">Markaziy ishlab chiqarishda tayyorlanadi</option>
              <option value="shop_prepared">Har bir do‘konda tayyorlanadi</option>
              <option value="resale">Sotish uchun tayyor holda xarid qilinadi</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1.5">Bu tanlov keyingi bosqichdagi retsept va avtomatik ombor qoidalari uchun ishlatiladi.</p>
          </div>
          <div className="rounded-xl border border-primary/25 bg-primary/5 p-3 space-y-3">
            <div>
              <Label className="text-xs mb-1.5 block">Ishlab chiqarish va jo‘natish birligi</Label>
              <select value={productionUnit} disabled={Boolean(product)} onChange={(e) => setProductionUnit(e.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm disabled:opacity-60">
                <option value="piece">Donali — kruassan, pechenye va boshqalar</option>
                <option value="sheet">Listli tort — do‘konda bo‘laklab sotiladi</option>
              </select>
            </div>
            {productionUnit === 'sheet' && (
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs mb-1.5 block">1 listdan bo‘lak soni</Label><Input type="number" min="1" step="1" value={piecesPerSheet} disabled={Boolean(product)} onChange={(e) => setPiecesPerSheet(e.target.value)} /></div>
                <div><Label className="text-xs mb-1.5 block">1 list narxi (UZS)</Label><Input type="number" min="0" value={sheetPrice} onChange={(e) => setSheetPrice(e.target.value)} /></div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{productionUnit === 'sheet' ? `Markazda list. Do‘kon qabul qilganda 1 list → ${piecesPerSheet} bo‘lak. Kassa narxi — bitta bo‘lak uchun.` : 'Markazda va do‘konda dona hisobida yuritiladi. Retseptda bir tayyorlashdan chiqadigan dona sonini ko‘rsatasiz.'}</p>
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