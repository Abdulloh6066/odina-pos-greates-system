import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert } from '@/lib/odina-dialog';
import { Tags, Plus, Pencil, Trash2 } from 'lucide-react';
import { logAction } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

const ICONS = ['🍰', '🧁', '🍪', '🥐', '🍩', '🎂', '🥧', '🍫', '☕', '🍓', '🍋', '🫐'];

export default function Categories() {
  const { user } = useOutletContext();
  const canManage = ['admin', 'accountant'].includes(user?.role);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const c = await base44.entities.Category.list();
    setCategories((c || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)));
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const remove = async (cat) => {
    if (!confirm(`Delete category "${cat.name}"? Products will keep their category name.`)) return;
    await base44.entities.Category.delete(cat.id);
    await logAction(user, 'category_deleted', cat.name);
    load();
  };

  return (
    <div className="odina-page p-5 sm:p-8 max-w-3xl mx-auto animate-fade-in">
      <PageHeader
        title="Categories"
        subtitle={`${categories.length} categories`}
        icon={Tags}
        actions={canManage && (
          <Button onClick={() => { setEditing(null); setOpen(true); }} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            <Plus className="w-4 h-4 mr-1.5" /> Add
          </Button>
        )}
      />
      {loading ? (
        <div className="grid sm:grid-cols-2 gap-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-20 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : categories.length === 0 ? (
        <p className="text-sm text-muted-foreground py-16 text-center">No categories yet.</p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {categories.map((c) => (
            <div key={c.id} className="odina-panel flex items-center gap-3 rounded-2xl bg-card border border-border premium-shadow p-4">
              <div className="w-11 h-11 rounded-xl bg-primary/15 flex items-center justify-center text-xl">{c.icon || '🍰'}</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{c.name}</div>
                <div className="text-xs text-muted-foreground">{c.active ? 'Active' : 'Inactive'}</div>
              </div>
              {canManage && (
                <div className="flex gap-1">
                  <button onClick={() => { setEditing(c); setOpen(true); }} className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:bg-secondary"><Pencil className="w-4 h-4" /></button>
                  <button onClick={() => remove(c)} className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <CategoryDialog open={open} category={editing} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); load(); }} user={user} />
    </div>
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
    } catch (e) { void odinaAlert('Save failed: ' + (e?.message || e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle className="font-display text-xl">{category ? 'Edit category' : 'New category'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cakes" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Icon</Label>
            <div className="flex flex-wrap gap-2">
              {ICONS.map((ic) => (
                <button key={ic} onClick={() => setIcon(ic)} className={`w-10 h-10 rounded-xl text-xl flex items-center justify-center transition-all ${icon === ic ? 'bg-primary premium-shadow scale-105' : 'bg-secondary hover:bg-secondary/70'}`}>{ic}</button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-primary" /> Active
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}