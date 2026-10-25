import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';
import { Plus, Pencil, Trash2, Search, Tags } from 'lucide-react';
import { logAction } from '@/lib/pos';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import CategoryIcon from '@/components/CategoryIcon';
import { TEA_ICON_URL, APELSIN_ICON_URL, SMOOTHIE_ICON_URL, MILKSHAKE_ICON_URL } from '@/lib/category-icon';
import '@/styles/categories-catalog.css';
import '@/styles/catalog-workbench.css';
import PageHeader from '@/components/PageHeader';

const ICONS = ['🎂', '🧁', '🥐', '🍮', '☕', '🍵', '💧', '🧊', '🥤', '🍰', '🍪', '🍩', '🥧', '🍫', '🍓', '🍋', '🫐', '🍔', '➕', TEA_ICON_URL, APELSIN_ICON_URL, SMOOTHIE_ICON_URL, MILKSHAKE_ICON_URL];

export default function Categories() {
  const { user } = useOutletContext();
  const canManage = ['admin', 'accountant'].includes(user?.role);
  const isManager = user?.role === 'manager';
  const [savingVisibilityId, setSavingVisibilityId] = useState('');
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);
    const c = await base44.entities.Category.list();
    setCategories((c || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)));
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => (c.name || '').toLowerCase().includes(q));
  }, [categories, query]);

  const setShopVisibility = async (category) => {
    if (!isManager || savingVisibilityId) return;
    setSavingVisibilityId(category.id);
    try {
      const hidden = !category.hidden_shop_ids?.includes(user.shop_id);
      const response = await base44.functions.invoke('manager-shop', { action: 'set_category_visibility', category_id: category.id, hidden });
      const result = response?.data || response;
      if (!result?.ok || result.shop_id !== user.shop_id) throw new Error(result?.error || 'Kategoriya ko‘rinishi saqlanmadi.');
      setCategories(rows => rows.map(row => row.id === result.category_id ? { ...row, hidden_shop_ids: result.hidden
        ? [...new Set([...(row.hidden_shop_ids || []), user.shop_id])]
        : (row.hidden_shop_ids || []).filter(id => id !== user.shop_id) } : row));
    } catch (error) { void odinaAlert(error?.response?.data?.error || error?.message || 'Kategoriya ko‘rinishi saqlanmadi.'); }
    finally { setSavingVisibilityId(''); }
  };

  const remove = async (cat) => {
    const accepted = await odinaConfirm(`“${cat.name}” kategoriyasini o‘chirasizmi?`, {
      title: 'Kategoriyani o‘chirish',
      details: 'Mahsulotlarda kategoriya nomi saqlanib qoladi.',
      tone: 'danger',
      confirmLabel: 'O‘chirish',
    });
    if (!accepted) return;
    await base44.entities.Category.delete(cat.id);
    await logAction(user, 'category_deleted', cat.name);
    load();
  };

  return (
    <div className="cat-page odina-page odina-workbench catalog-workbench catalog-categories">
      <div className="cat-shell">
        <PageHeader title="Kategoriyalar" subtitle="Mahsulotlarni tartiblang va katalogni boshqaring" icon={Tags} actions={canManage && (
            <button className="cat-add" onClick={() => { setEditing(null); setOpen(true); }}>
              <Plus size={18} aria-hidden="true" /> Qo‘shish
            </button>
          )} />

        <div className="category-overview" aria-label="Kategoriya holatlari">
          <div><Tags className="w-5 h-5" aria-hidden="true" /><span>Barcha kategoriyalar</span><strong>{categories.length}</strong></div>
          <div><span className="category-overview-dot" aria-hidden="true" /><span>Faol</span><strong>{categories.filter((c) => c.active !== false).length}</strong></div>
          <div><span className="category-overview-dot is-inactive" aria-hidden="true" /><span>Nofaol</span><strong>{categories.filter((c) => c.active === false).length}</strong></div>
        </div>

        <div className="cat-workspace">
          <div className="cat-toolbar catalog-toolbar">
            <label className="catalog-filter-field category-search-field"><span>Kategoriya qidirish</span><div className="cat-search">
              <Search size={18} aria-hidden="true" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Kategoriya qidirish…"
                aria-label="Kategoriya qidirish"
              />
            </div></label>
            <span className="cat-count-pill" aria-live="polite">{filtered.length} / {categories.length} ta kategoriya</span>
          </div>

          {loading ? (
            <div className="cat-skeletons">
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="cat-skeleton" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="cat-empty">
              {query ? (
                <>
                  <strong>Hech narsa topilmadi</strong>
                  <p>“{query}” bo‘yicha kategoriya yo‘q.</p>
                  <button className="cat-empty-add" onClick={() => setQuery('')}>Filtrlarni tozalash</button>
                </>
              ) : (
                <>
                  <strong>Hozircha kategoriyalar yo‘q</strong>
                  <p>Birinchi kategoriyani qo‘shing.</p>
                  {canManage && <button className="cat-empty-add" onClick={() => { setEditing(null); setOpen(true); }}>
                    <Plus size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 5 }} />Kategoriya qo‘shish
                  </button>}
                </>
              )}
            </div>
          ) : (
            <div className="cat-grid">
              {filtered.map((c) => (
                <CategoryCard key={c.id} category={c} canManage={canManage} onEdit={() => { setEditing(c); setOpen(true); }} onRemove={() => remove(c)}
                  shopVisibility={isManager ? { hidden: c.hidden_shop_ids?.includes(user.shop_id), disabled: Boolean(savingVisibilityId), onChange: () => setShopVisibility(c) } : null} />
              ))}
            </div>
          )}
        </div>

        <CategoryDialog open={open} category={editing} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); }} user={user} />
      </div>
    </div>
  );
}

function CategoryCard({ category: c, canManage, onEdit, onRemove, shopVisibility }) {
  const active = c.active !== false;
  return (
    <article className={`cat-card${active ? '' : ' is-inactive'}`}>
      <div className="cat-card-top">
        <div className="cat-icon-box">
          <CategoryIcon icon={c.icon} />
        </div>
        <h2 className="cat-card-name">{c.name}</h2>
        <span className={`cat-status${active ? ' is-active' : ' is-inactive'}`}>
          <span className="cat-dot" /> {active ? 'Faol' : 'Nofaol'}
        </span>
      </div>
      {shopVisibility && <div className="cat-actions"><button className="cat-act" disabled={shopVisibility.disabled} onClick={shopVisibility.onChange}>
        {shopVisibility.hidden ? 'Do‘konimda ko‘rsatish' : 'Do‘konimda yashirish'}
      </button></div>}
      {canManage && (
        <div className="cat-actions">
          <button className="cat-act" onClick={onEdit}><Pencil size={15} aria-hidden="true" /> Tahrirlash</button>
          <button className="cat-act cat-act-danger" onClick={onRemove}><Trash2 size={15} aria-hidden="true" /> O‘chirish</button>
        </div>
      )}
    </article>
  );
}

function CategoryDialog({ open, category, onClose, onSaved, user }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🍰');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(category?.name || '');
      setIcon(category?.icon || '🍰');
      setActive(category?.active !== false);
    }
  }, [open, category]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (category) { await base44.entities.Category.update(category.id, { name: name.trim(), icon, active }); await logAction(user, 'category_updated', name); }
      else { await base44.entities.Category.create({ name: name.trim(), icon, active, sort_order: 0 }); await logAction(user, 'category_created', name); }
      onSaved();
    } catch (e) { void odinaAlert('Saqlashda xato: ' + (e?.message || e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle className="font-display text-xl">{category ? 'Kategoriyani tahrirlash' : 'Yangi kategoriya'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Nomi</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Masalan: Tortlar" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Belgi</Label>
            <div className="flex flex-wrap gap-2">
              {ICONS.map((ic) => (
                <button key={ic} onClick={() => setIcon(ic)} className={`w-10 h-10 rounded-xl text-xl flex items-center justify-center transition-all overflow-hidden ${icon === ic ? 'bg-primary premium-shadow scale-105' : 'bg-secondary hover:bg-secondary/70'}`}>
                  <CategoryIcon icon={ic} imgClassName="w-7 h-7" />
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-primary" /> Faol
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">{saving ? 'Saqlanmoqda…' : 'Saqlash'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
