import React, { useEffect, useMemo, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { AlertTriangle, Beaker, ChefHat, History, Pencil, Plus, Scale, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert } from '@/lib/odina-dialog';
import { formatNum } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const UNIT_LABELS = { g: 'g', ml: 'ml', piece: 'dona', sheet: 'list' };

const cleanNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) / 1000 : 0;
};

const errorMessage = (error, fallback) =>
  error?.response?.data?.error || error?.data?.error || error?.message || fallback;

export default function ProductionPanel({
  mode,
  user,
  location,
  products,
  ingredients,
  ingredientStock,
  search,
  onReload,
}) {
  const [recipes, setRecipes] = useState([]);
  const [recipeItems, setRecipeItems] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [recipeProduct, setRecipeProduct] = useState(null);
  const [recipePickerOpen, setRecipePickerOpen] = useState(false);
  const [productionProduct, setProductionProduct] = useState(null);

  const canManageRecipes = ['admin', 'accountant'].includes(user?.role);
  const canProduce = ['admin', 'manager', 'production'].includes(user?.role);

  const load = async () => {
    setLoading(true);
    try {
      const [recipeList, itemList, batchList] = await Promise.all([
        base44.entities.Recipe.list('-created_at', 500),
        base44.entities.RecipeItem.list('position', 1000),
        base44.entities.ProductionBatch.list('-created_at', 500),
      ]);
      setRecipes(recipeList || []);
      setRecipeItems(itemList || []);
      setBatches(batchList || []);
    } catch (error) {
      void odinaAlert('Retsept va ishlab chiqarish ma’lumotlarini yuklab bo‘lmadi: ' + errorMessage(error, 'Noma’lum xato'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [user?.id]);

  const activeRecipes = useMemo(
    () => recipes.filter((recipe) => recipe.active === true),
    [recipes],
  );

  const recipeByProduct = useMemo(
    () => Object.fromEntries(activeRecipes.map((recipe) => [recipe.product_id, recipe])),
    [activeRecipes],
  );

  const recipeItemsByRecipe = useMemo(() => {
    const grouped = {};
    for (const item of recipeItems) {
      if (!grouped[item.recipe_id]) grouped[item.recipe_id] = [];
      grouped[item.recipe_id].push(item);
    }
    return grouped;
  }, [recipeItems]);

  const query = search.toLowerCase().trim();
  const recipeProducts = products.filter((product) => {
    if (product.source_type === 'resale') return false;
    if (!query) return true;
    const recipe = recipeByProduct[product.id];
    const itemNames = (recipeItemsByRecipe[recipe?.id] || []).map((item) => item.ingredient_name_snapshot);
    return [product.name, ...itemNames].join(' ').toLowerCase().includes(query);
  });

  const productionProducts = products.filter((product) => {
    if (product.source_type !== 'central_produced' || !recipeByProduct[product.id]) return false;
    return !query || product.name.toLowerCase().includes(query);
  });

  const balances = useMemo(
    () => Object.fromEntries(
      ingredientStock
        .filter((stock) => stock.location_id === location?.id)
        .map((stock) => [stock.ingredient_id, Number(stock.quantity || 0)]),
    ),
    [ingredientStock, location?.id],
  );

  const historyRows = batches.filter((batch) => {
    if (batch.location_id !== location?.id) return false;
    return !query
      || [batch.batch_number, batch.product_name_snapshot, batch.user_name, batch.notes]
        .filter(Boolean).join(' ').toLowerCase().includes(query);
  });

  if (loading) {
    return (
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-36 rounded-2xl bg-secondary animate-pulse" />)}
      </div>
    );
  }

  if (mode === 'recipes') {
    return (
      <>
        {canManageRecipes && (
          <div className="flex justify-end mb-4">
            <Button onClick={() => setRecipePickerOpen(true)} className="min-h-11 rounded-xl">
              <Plus className="w-4 h-4 mr-1.5" /> Retsept yaratish
            </Button>
          </div>
        )}
        <Dialog open={recipePickerOpen} onOpenChange={setRecipePickerOpen}>
          <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
            <DialogHeader><DialogTitle>Retsept uchun mahsulot tanlang</DialogTitle></DialogHeader>
            {products.some((product) => product.source_type !== 'resale') ? (
              <OdinaSelect aria-label="Retsept mahsuloti" defaultValue="" className="w-full h-11 rounded-xl border border-input bg-card px-3"
                onChange={(event) => {
                  const selected = products.find((product) => product.id === event.target.value);
                  if (selected) { setRecipePickerOpen(false); setRecipeProduct(selected); }
                }}>
                <option value="" disabled>Mahsulotni tanlang</option>
                {products.filter((product) => product.source_type !== 'resale').map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
              </OdinaSelect>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Avval mahsulot nomi, narxi va list/dona birligini kiriting. Keyin shu mahsulot uchun retsept yaratasiz.</p>
                <Button asChild className="w-full min-h-11"><Link to="/products">Mahsulot qo‘shish</Link></Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
        <div className="rounded-2xl border border-primary/25 bg-primary/5 p-4 mb-4 flex items-start gap-3">
          <Beaker className="w-5 h-5 text-brand-ink shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Retseptlar versiya bilan saqlanadi</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              Retsept o‘zgarsa eski yozuv saqlanadi, yangi versiya ishlab chiqarishda ishlatiladi.
              {location?.id === '6a96f0a4ecc85c2fc57f3174' && ' Branch’da tayyorlanadigan kofe va boshqa dona mahsulotlar sotilganda faol tex-karta masalliqlari shu filial omboridan avtomatik ayriladi. Tex-kartasi yo‘q mahsulotlarda masalliq hisobi hali ulanmagan.'}
            </p>
          </div>
        </div>

        {!recipeProducts.length ? (
          <Empty text="Retsept uchun mos mahsulot topilmadi." />
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {recipeProducts.map((product) => {
              const recipe = recipeByProduct[product.id];
              const lines = recipeItemsByRecipe[recipe?.id] || [];
              return (
                <div key={product.id} className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4 flex flex-col">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{product.name}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {recipe ? `Faol retsept v${recipe.version} · ${recipe.output_quantity} ${UNIT_LABELS[recipe.output_unit] || "dona"} natija` : 'Retsept yaratilmagan'}
                      </p>
                    </div>
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${recipe ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                      {recipe ? <ChefHat className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
                    </div>
                  </div>

                  {location?.id === '6a96f0a4ecc85c2fc57f3174' && product.source_type === 'shop_prepared' && product.sale_unit !== 'gram' && (
                    <p className={`mt-3 text-xs font-medium ${recipe && lines.length ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {recipe && lines.length ? 'Kassa bilan ulangan · masalliqlar avtomatik ayriladi' : 'Ombor hisobi ulanmagan · tex-karta kiriting'}
                    </p>
                  )}
                  <div className="mt-3 space-y-1.5 flex-1">
                    {lines.slice(0, 4).map((line) => (
                      <div key={line.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate text-foreground/75">{line.ingredient_name_snapshot}</span>
                        <span className="font-medium shrink-0">{formatNum(line.quantity)} {UNIT_LABELS[line.unit] || line.unit}</span>
                      </div>
                    ))}
                    {lines.length > 4 && <p className="text-xs text-muted-foreground">+ yana {lines.length - 4} ta masalliq</p>}
                    {!lines.length && <p className="text-sm text-muted-foreground">Masalliqlar kiritilmagan.</p>}
                  </div>

                  {canManageRecipes && (
                    <Button
                      variant={recipe ? 'outline' : 'default'}
                      onClick={() => setRecipeProduct(product)}
                      className={`w-full mt-4 min-h-11 rounded-xl touch-manipulation ${!recipe ? 'bg-primary text-primary-foreground hover:bg-primary-strong' : ''}`}
                    >
                      {recipe ? <Pencil className="w-4 h-4 mr-1.5" /> : <Plus className="w-4 h-4 mr-1.5" />}
                      {recipe ? 'Retseptni yangilash' : 'Retsept yaratish'}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <RecipeDialog
          open={Boolean(recipeProduct)}
          product={recipeProduct}
          recipe={recipeByProduct[recipeProduct?.id]}
          existingItems={recipeItemsByRecipe[recipeByProduct[recipeProduct?.id]?.id] || []}
          ingredients={ingredients}
          onClose={() => setRecipeProduct(null)}
          onSaved={async () => {
            setRecipeProduct(null);
            await load();
          }}
        />
      </>
    );
  }

  if (location?.location_type !== 'production') {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center">
        <AlertTriangle className="w-9 h-9 mx-auto text-amber-700 mb-3" />
        <p className="font-semibold text-amber-900">Markaziy ishlab chiqarish omborini tanlang</p>
        <p className="text-sm text-amber-800/75 mt-1">Mahsulot tayyorlash faqat ishlab chiqarish joyida amalga oshiriladi.</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] gap-5">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <ChefHat className="w-5 h-5 text-brand-ink" />
            <h3 className="font-display text-lg font-bold">Ishlab chiqarish</h3>
          </div>

          {!productionProducts.length ? (
            <Empty text="Avval markazda ishlab chiqariladigan mahsulot uchun retsept yarating." />
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {productionProducts.map((product) => {
                const recipe = recipeByProduct[product.id];
                const lines = recipeItemsByRecipe[recipe.id] || [];
                const possible = lines.length
                  ? Math.max(0, Math.floor(Math.min(...lines.map((line) => {
                      const perPiece = Number(line.quantity || 0) / Number(recipe.output_quantity || 1);
                      return perPiece > 0 ? Number(balances[line.ingredient_id] || 0) / perPiece : 0;
                    }))))
                  : 0;
                return (
                  <div key={product.id} className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">{product.name}</p>
                        <p className="text-xs text-muted-foreground mt-1">Retsept v{recipe.version} · taxminan {formatNum(possible)} {UNIT_LABELS[recipe.output_unit] || "dona"} tayyorlash mumkin</p>
                      </div>
                      <Scale className="w-5 h-5 text-brand-ink shrink-0" />
                    </div>
                    {canProduce && (
                      <Button
                        onClick={() => setProductionProduct(product)}
                        className="w-full mt-4 min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation"
                      >
                        <Plus className="w-4 h-4 mr-1.5" /> Tayyor mahsulot kiritish
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <History className="w-5 h-5 text-brand-ink" />
            <h3 className="font-display text-lg font-bold">Oxirgi ishlab chiqarishlar</h3>
          </div>
          {!historyRows.length ? (
            <Empty text="Hali ishlab chiqarish yozuvi yo‘q." compact />
          ) : (
            <div className="space-y-2.5">
              {historyRows.slice(0, 12).map((batch) => (
                <div key={batch.id} className="odina-panel rounded-2xl bg-card border border-border p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{batch.product_name_snapshot}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{batch.batch_number} · Retsept v{batch.recipe_version}</p>
                    </div>
                    <span className="font-semibold text-emerald-700 shrink-0">+{formatNum(batch.produced_quantity)} {UNIT_LABELS[batch.unit] || "dona"}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {formatUzbekistanDateTime(batch.completed_at || batch.created_at)} · {batch.user_name}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ProductionDialog
        open={Boolean(productionProduct)}
        product={productionProduct}
        recipe={recipeByProduct[productionProduct?.id]}
        recipeItems={recipeItemsByRecipe[recipeByProduct[productionProduct?.id]?.id] || []}
        balances={balances}
        location={location}
        onClose={() => setProductionProduct(null)}
        onSaved={async () => {
          setProductionProduct(null);
          await Promise.all([load(), onReload()]);
        }}
      />
    </>
  );
}

function Empty({ text, compact = false }) {
  return (
    <div className={`odina-panel rounded-2xl border border-border bg-card text-center text-sm text-muted-foreground ${compact ? 'py-8' : 'py-14'}`}>
      {text}
    </div>
  );
}

function RecipeDialog({ open, product, recipe, existingItems, ingredients, onClose, onSaved }) {
  const [outputQuantity, setOutputQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState([{ ingredient_id: '', quantity: '' }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOutputQuantity(String(recipe?.output_quantity || 1));
    setNotes(recipe?.notes || '');
    setRows(existingItems.length
      ? existingItems.map((item) => ({ ingredient_id: item.ingredient_id, quantity: String(item.quantity) }))
      : [{ ingredient_id: '', quantity: '' }]);
  }, [open, recipe?.id]);

  const updateRow = (index, field, value) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
  };

  const addRow = () => setRows((current) => [...current, { ingredient_id: '', quantity: '' }]);
  const removeRow = (index) => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index));

  const save = async () => {
    const validRows = rows.filter((row) => row.ingredient_id && Number(row.quantity) > 0);
    if (!product || Number(outputQuantity) <= 0 || validRows.length !== rows.length) {
      void odinaAlert('Natija miqdori va barcha masalliqlarni to‘liq kiriting.');
      return;
    }
    setSaving(true);
    try {
      const result = await base44.functions.invoke('production-run', {
        action: 'save_recipe',
        product_id: product.id,
        output_quantity: Number(outputQuantity),
        notes: notes.trim(),
        items: validRows.map((row) => ({
          ingredient_id: row.ingredient_id,
          quantity: Number(row.quantity),
        })),
      });
      const payload = result?.data || result;
      if (!payload?.recipe) throw new Error(payload?.error || 'Retseptni saqlab bo‘lmadi.');
      onSaved();
    } catch (error) {
      void odinaAlert('Retsept saqlanmadi: ' + errorMessage(error, 'Noma’lum xato'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{product?.name} retsepti</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {recipe ? `Hozirgi versiya: v${recipe.version}. Saqlaganda v${Number(recipe.version || 0) + 1} yaratiladi.` : 'Birinchi retsept versiyasi yaratiladi.'}
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <div className="sm:w-64">
            <Label className="text-xs mb-1.5 block">Ushbu retseptdan chiqadigan mahsulot</Label>
            <div className="flex items-center gap-2">
              <Input type="number" min="1" step="1" value={outputQuantity} onChange={(event) => setOutputQuantity(event.target.value)} />
              <span className="text-sm font-medium">{UNIT_LABELS[product?.production_unit] || "dona"}</span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs">Yuqoridagi natija uchun jami masalliqlar (1 kg = 1 000 g)</Label>
              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                <Plus className="w-4 h-4 mr-1" /> Qator qo‘shish
              </Button>
            </div>
            <div className="space-y-2">
              {rows.map((row, index) => {
                const selected = ingredients.find((item) => item.id === row.ingredient_id);
                return (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_130px_40px] gap-2">
                    <OdinaSelect
                      value={row.ingredient_id}
                      onChange={(event) => updateRow(index, 'ingredient_id', event.target.value)}
                      className="h-10 rounded-lg border border-input bg-card px-3 text-sm min-w-0"
                    >
                      <option value="">Masalliqni tanlang</option>
                      {ingredients.map((ingredient) => (
                        <option key={ingredient.id} value={ingredient.id}>{ingredient.name} · {UNIT_LABELS[ingredient.base_unit] || ingredient.base_unit}</option>
                      ))}
                    </OdinaSelect>
                    <div className="relative">
                      <Input
                        type="number"
                        min="0.001"
                        step="0.001"
                        value={row.quantity}
                        onChange={(event) => updateRow(index, 'quantity', event.target.value)}
                        placeholder="0"
                        className="pr-12"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                        {UNIT_LABELS[selected?.base_unit] || ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => rows.length > 1 && removeRow(index)}
                      disabled={rows.length <= 1}
                      className="h-10 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-30"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Masalan: standart ishlab chiqarish retsepti" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {saving ? 'Saqlanmoqda…' : recipe ? 'Yangi versiyani saqlash' : 'Retseptni yaratish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProductionDialog({ open, product, recipe, recipeItems, balances, location, onClose, onSaved }) {
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setQuantity('');
      setNotes('');
    }
  }, [open, product?.id]);

  const produced = Number(quantity || 0);
  const usage = recipeItems.map((item) => {
    const required = cleanNumber(Number(item.quantity || 0) * produced / Number(recipe?.output_quantity || 1));
    const available = cleanNumber(balances[item.ingredient_id] || 0);
    return { ...item, required, available, after: cleanNumber(available - required) };
  });
  const hasShortage = produced > 0 && usage.some((item) => item.after < 0);

  const save = async () => {
    if (!product || !location || !Number.isInteger(produced) || produced <= 0 || hasShortage) return;
    setSaving(true);
    try {
      const result = await base44.functions.invoke('production-run', {
        action: 'complete_production',
        location_id: location.id,
        product_id: product.id,
        produced_quantity: produced,
        notes: notes.trim(),
      });
      const payload = result?.data || result;
      if (!payload?.batch) throw new Error(payload?.error || 'Ishlab chiqarishni saqlab bo‘lmadi.');
      onSaved();
    } catch (error) {
      const message = errorMessage(error, 'Noma’lum xato');
      const shortages = error?.response?.data?.shortages || error?.data?.shortages;
      const details = shortages?.length
        ? '\n' + shortages.map((item) => `${item.ingredient_name}: ${formatNum(item.missing)} ${UNIT_LABELS[item.unit] || item.unit} yetishmaydi`).join('\n')
        : '';
      void odinaAlert('Ishlab chiqarish saqlanmadi: ' + message + details);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{product?.name} ishlab chiqarish</DialogTitle>
          <p className="text-sm text-muted-foreground">{location?.name} · Retsept v{recipe?.version}</p>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Tayyorlangan miqdor</Label>
            <div className="flex items-center gap-2">
              <Input autoFocus type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="0" />
              <span className="text-sm font-medium">{UNIT_LABELS[product?.production_unit] || "dona"}</span>
            </div>
          </div>

          {produced > 0 && (
            <div className="rounded-2xl border border-border overflow-hidden">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 px-3 py-2 bg-secondary/60 text-xs font-medium text-muted-foreground">
                <span>Masalliq</span><span>Sarf</span><span>Qoladi</span>
              </div>
              {usage.map((item) => (
                <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 px-3 py-2.5 border-t border-border text-sm">
                  <span className="truncate">{item.ingredient_name_snapshot}</span>
                  <span>{formatNum(item.required)} {UNIT_LABELS[item.unit] || item.unit}</span>
                  <span className={item.after < 0 ? 'font-semibold text-destructive' : 'font-medium text-emerald-700'}>
                    {formatNum(item.after)} {UNIT_LABELS[item.unit] || item.unit}
                  </span>
                </div>
              ))}
            </div>
          )}

          {hasShortage && (
            <div className="rounded-xl bg-red-50 text-red-800 p-3 flex items-start gap-2 text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              Masalliqlar yetarli emas. Avval omborga kirim qiling yoki miqdorni kamaytiring.
            </div>
          )}

          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} placeholder="Masalan: ertalabki ishlab chiqarish" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button
            onClick={save}
            disabled={saving || !Number.isInteger(produced) || produced <= 0 || hasShortage}
            className="bg-primary text-primary-foreground hover:bg-primary-strong"
          >
            {saving ? 'Saqlanmoqda…' : `${formatNum(produced)} ${UNIT_LABELS[product?.production_unit] || "dona"} ishlab chiqarildi`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
