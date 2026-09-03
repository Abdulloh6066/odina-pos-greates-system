import React, { useEffect, useState, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Cake, Plus, Search, Pencil, Star, Upload, Loader2, Trash2, ArchiveRestore } from 'lucide-react';
import { formatUZS, logAction } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
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
      if (!payload?.product) throw new Error(payload?.error || 'Could not update availability.');
      setProducts((items) => items.map((p) => p.id === product.id ? payload.product : p));
    } catch (e) { alert('Availability update failed: ' + (e?.message || e)); }
  };

  return (
    <div className="p-5 sm:p-8 max-w-7xl mx-auto animate-fade-in">
      <PageHeader
        title="Products"
        subtitle={`${products.length} products`}
        icon={Cake}
        actions={canManageCatalog && (
          <Button onClick={openNew} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            <Plus className="w-4 h-4 mr-1.5" /> Add product
          </Button>
        )}
      />

      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products…" className="pl-9" />
        </div>
        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} className="h-10 rounded-lg border border-input bg-card px-3 text-sm font-medium sm:w-56">
          <option value="all">Barcha kategoriyalar</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {role === 'admin' && (
          <Button variant="outline" onClick={() => setShowArchived((value) => !value)} className="whitespace-nowrap">
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
        <div className="text-center py-20"><div className="text-5xl mb-3">🍰</div><p className="text-sm text-muted-foreground">No products found.</p></div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {filtered.map((p) => (
            <div key={p.id} className="group rounded-2xl bg-card border border-border premium-shadow overflow-hidden">
              <div className="relative aspect-square bg-secondary overflow-hidden">
                {p.image_url ? <Image src={p.image_url} alt={p.name} fittingType="fill" className="w-full h-full" /> : <div className="w-full h-full flex items-center justify-center text-3xl font-display text-muted-foreground/40">{p.name.charAt(0)}</div>}
                {p.is_favorite && <Star className="absolute top-2 left-2 w-4 h-4 fill-primary text-primary" />}
                {!p.active && <div className="absolute inset-0 bg-foreground/40 flex items-center justify-center text-white text-xs font-semibold">Inactive</div>}
                {canManageCatalog && (
                  <button onClick={() => openEdit(p)} className="absolute top-2 right-2 w-8 h-8 rounded-full bg-card/90 backdrop-blur flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="p-3">
                <div className="text-sm font-semibold truncate">{p.name}</div>
                <div className="text-xs text-muted-foreground">{p.category_name || 'Uncategorized'}</div>
                <div className="text-[15px] font-bold text-primary-strong mt-1">{formatUZS(p.price)}</div>
                {(role === 'production' || canManageCatalog) && (
                  <Button variant="outline" size="sm" className="w-full mt-2 h-8 text-xs" onClick={() => setAvailability(p)}>
                    Mark {p.active === false ? 'available' : 'unavailable'}
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
    } catch (err) { alert('Upload failed: ' + (err?.message || err)); }
    finally { setUploading(false); }
  };

  const save = async () => {
    if (!name.trim() || !price) { alert('Name and price are required.'); return; }
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
    } catch (e) { alert('Save failed: ' + (e?.message || e)); }
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{product ? 'Edit product' : 'New product'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-4">
            <div className="w-28 h-28 rounded-2xl bg-secondary overflow-hidden border border-border shrink-0">
              {imageUrl ? <img src={imageUrl} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-muted-foreground/40"><Cake className="w-8 h-8" /></div>}
            </div>
            <div className="flex-1 space-y-2">
              <Label className="text-xs">Product image</Label>
              <label className="inline-flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg border border-border cursor-pointer hover:bg-secondary transition-colors">
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? 'Uploading…' : 'Upload image'}
                <input type="file" accept="image/*" className="hidden" onChange={handleUpload} disabled={uploading} />
              </label>
              <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="…or paste image URL" className="h-9 text-xs" />
            </div>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chocolate Truffle Cake" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs mb-1.5 block">Price (UZS)</Label>
              <Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="45000" />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Category</Label>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
                <option value="">None</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">How this product is supplied</Label>
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm">
              <option value="central_produced">Produced at Central Production</option>
              <option value="shop_prepared">Prepared inside each shop</option>
              <option value="resale">Purchased ready-made for resale</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1.5">This prepares the product for recipes and automatic stock rules in the next phase.</p>
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>
          <div className="flex items-center gap-5">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={isFavorite} onChange={(e) => setIsFavorite(e.target.checked)} className="w-4 h-4 accent-primary" />
              Favorite
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-primary" />
              Active
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
          <Button onClick={save} disabled={saving || archiving} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {saving ? 'Saqlanmoqda…' : 'Saqlash'}
          </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}