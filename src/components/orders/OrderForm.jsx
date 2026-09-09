import React, { useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { formatUZS, PAYMENT_METHODS } from '@/lib/pos';
import { buildIdempotencyKey, ORDER_TYPES, FULFILMENT_TYPES, CAKE_SHAPES } from '@/lib/orders';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';
import { Plus, Trash2, X, Loader2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

const WEDDING_PCS = 40;

export default function OrderForm({ open, onClose, onCreated, user, shops }) {
  const { toast } = useToast();
  const role = user?.role || 'cashier';
  const isAdmin = role === 'admin';
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pickProductId, setPickProductId] = useState('');
  const [pickQty, setPickQty] = useState(1);
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(() => ({
    order_type: 'toy_va_bazmlar', customer_name: '', customer_phone: '',
    required_date: '', required_time: '18:00', shop_id: user?.shop_id || '',
    fulfilment_type: 'pickup', delivery_address: '', delivery_fee: 0,
    cake_shape: '', reference_image: '', notes: '',
    adjustment_amount: 0, adjustment_reason: '',
    useAdvance: false, advance_method: 'cash', advance_amount: 0,
  }));

  useEffect(() => {
    if (!open) return;
    setLoadingProducts(true);
    base44.entities.Product.list('name', 500)
      .then((list) => setProducts((list || []).filter((p) => p.active !== false && p.archived !== true)))
      .catch(() => setProducts([]))
      .finally(() => setLoadingProducts(false));
  }, [open]);

  useEffect(() => {
    if (open && role === 'cashier') setForm((f) => ({ ...f, shop_id: user?.shop_id || '' }));
  }, [open, role, user]);

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const addItem = () => {
    const p = productById.get(pickProductId);
    if (!p) { toast({ title: 'Mahsulot tanlang', variant: 'destructive' }); return; }
    const qty = Math.max(1, Math.floor(Number(pickQty) || 0));
    if (!qty) { toast({ title: 'To‘g‘ri miqdor kiriting', variant: 'destructive' }); return; }
    setItems((prev) => {
      const existing = prev.find((i) => i.product_id === p.id);
      if (existing) {
        return prev.map((i) => i.product_id === p.id ? { ...i, quantity: i.quantity + qty } : i);
      }
      return [...prev, { product_id: p.id, name: p.name, image_url: p.image_url || '', category_name: p.category_name || '',
        production_unit: p.production_unit || 'piece', price: Number(p.price || 0), sheet_price: Number(p.sheet_price || 0),
        pieces_per_sheet: Number(p.pieces_per_sheet || 20), quantity: qty, customization_note: '' }];
    });
    setPickProductId('');
    setPickQty(1);
  };

  const setItemQty = (id, qty) => setItems((prev) => prev.map((i) => i.product_id === id ? { ...i, quantity: Math.max(1, Math.floor(Number(qty) || 1)) } : i));
  const setItemNote = (id, note) => setItems((prev) => prev.map((i) => i.product_id === id ? { ...i, customization_note: note } : i));
  const removeItem = (id) => setItems((prev) => prev.filter((i) => i.product_id !== id));

  const isWedding = form.order_type === 'toy_va_bazmlar';
  const subtotal = useMemo(() => items.reduce((sum, i) => {
    const unit = i.production_unit === 'sheet' ? Number(i.sheet_price || 0) : Number(i.price || 0);
    return sum + unit * i.quantity;
  }, 0), [items]);

  const deliveryFee = form.fulfilment_type === 'delivery' ? (isWedding ? 0 : Math.max(0, Number(form.delivery_fee || 0))) : 0;
  const adjustment = Number(form.adjustment_amount || 0);
  const total = Math.max(0, subtotal + deliveryFee + adjustment);
  const advanceAmount = form.useAdvance ? Math.min(Number(form.advance_amount || 0), total) : 0;
  const remaining = total - advanceAmount;

  const valid = form.customer_name.trim() && form.customer_phone.trim() && form.required_date && form.required_time
    && items.length > 0 && (isAdmin || form.shop_id === user?.shop_id)
    && (adjustment === 0 || (isAdmin && form.adjustment_reason.trim().length >= 3))
    && (!form.useAdvance || (advanceAmount > 0 && advanceAmount <= total));

  const submit = async () => {
    if (!valid) { toast({ title: 'Barcha majburiy maydonlarni to‘ldiring', variant: 'destructive' }); return; }
    setSubmitting(true);
    try {
      const payload = {
        action: 'create_order',
        idempotency_key: buildIdempotencyKey('order'),
        order_type: form.order_type,
        customer_name: form.customer_name.trim(),
        customer_phone: form.customer_phone.trim(),
        required_date: form.required_date,
        required_time: form.required_time,
        shop_id: isAdmin ? form.shop_id : user.shop_id,
        fulfilment_type: form.fulfilment_type,
        delivery_address: form.delivery_address,
        delivery_fee: form.delivery_fee,
        cake_shape: form.cake_shape,
        reference_image: form.reference_image,
        notes: form.notes,
        adjustment_amount: adjustment,
        adjustment_reason: form.adjustment_reason,
        items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, customization_note: i.customization_note })),
      };
      if (form.useAdvance && advanceAmount > 0) {
        payload.advance_payment = { method: form.advance_method, amount: advanceAmount, idempotency_key: buildIdempotencyKey('pay') };
      }
      const res = await base44.functions.invoke('customer-orders', payload);
      const data = res?.data || res;
      if (data?.order) {
        toast({ title: 'Buyurtma yaratildi', description: data.order.order_number });
        onCreated(data.order);
        reset();
      } else {
        throw new Error(data?.error || 'Buyurtma yaratilmadi');
      }
    } catch (e) {
      toast({ title: 'Xatolik', description: e?.message || 'Buyurtma yaratilmadi', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setItems([]);
    setForm({ order_type: 'toy_va_bazmlar', customer_name: '', customer_phone: '', required_date: '', required_time: '18:00',
      shop_id: user?.shop_id || '', fulfilment_type: 'pickup', delivery_address: '', delivery_fee: 0,
      cake_shape: '', reference_image: '', notes: '', adjustment_amount: 0, adjustment_reason: '',
      useAdvance: false, advance_method: 'cash', advance_amount: 0 });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle>Yangi buyurtma</DialogTitle>
          <DialogDescription>Mijoz va mahsulot ma’lumotlarini to‘ldiring.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Buyurtma turi *</Label>
              <select value={form.order_type} onChange={(e) => update({ order_type: e.target.value })} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                {ORDER_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <Label>Qabul qiluvchi do‘kon {isAdmin ? '*' : ''}</Label>
              <select value={isAdmin ? form.shop_id : user?.shop_id} disabled={!isAdmin}
                onChange={(e) => update({ shop_id: e.target.value })}
                className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm disabled:opacity-60">
                <option value="">Tanlang</option>
                {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Mijoz ismi *</Label>
              <Input value={form.customer_name} onChange={(e) => update({ customer_name: e.target.value })} className="mt-1" />
            </div>
            <div>
              <Label>Telefon *</Label>
              <Input value={form.customer_phone} onChange={(e) => update({ customer_phone: e.target.value })} className="mt-1" placeholder="+998..." />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <Label>Sana *</Label>
              <input type="date" value={form.required_date} onChange={(e) => update({ required_date: e.target.value })} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm" />
            </div>
            <div>
              <Label>Vaqt *</Label>
              <input type="time" value={form.required_time} onChange={(e) => update({ required_time: e.target.value })} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm" />
            </div>
            <div>
              <Label>Shakl</Label>
              <select value={form.cake_shape} onChange={(e) => update({ cake_shape: e.target.value })} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                <option value="">—</option>
                {CAKE_SHAPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Yetkazib berish *</Label>
              <select value={form.fulfilment_type} onChange={(e) => update({ fulfilment_type: e.target.value })} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                {FULFILMENT_TYPES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            </div>
            {form.fulfilment_type === 'delivery' && !isWedding && (
              <div>
                <Label>Yetkazib berish narxi (UZS)</Label>
                <Input type="number" value={form.delivery_fee} onChange={(e) => update({ delivery_fee: Number(e.target.value) })} className="mt-1" />
              </div>
            )}
          </div>
          {form.fulfilment_type === 'delivery' && (
            <div>
              <Label>Manzil</Label>
              <Input value={form.delivery_address} onChange={(e) => update({ delivery_address: e.target.value })} className="mt-1" />
              {isWedding && <p className="text-xs text-brand-olive mt-1">Toy va bazmlar uchun yetkazib berish bepul.</p>}
            </div>
          )}

          <div>
            <Label className="flex items-center justify-between">
              <span>Mahsulotlar *</span>
              <span className="text-xs font-normal text-muted-foreground">{items.length} ta</span>
            </Label>
            <div className="mt-2 flex flex-col sm:flex-row gap-2">
              <select value={pickProductId} onChange={(e) => setPickProductId(e.target.value)} className="h-11 flex-1 rounded-xl border border-input bg-card px-3 text-sm">
                <option value="">Mahsulot tanlang</option>
                {products.map((p) => {
                  const unit = p.production_unit === 'sheet' ? 'varaq' : 'dona';
                  const price = p.production_unit === 'sheet' ? p.sheet_price : p.price;
                  return <option key={p.id} value={p.id}>{p.name} — {formatUZS(price)}/{unit}</option>;
                })}
              </select>
              <Input type="number" min="1" value={pickQty} onChange={(e) => setPickQty(e.target.value)} className="sm:w-24" />
              <Button type="button" variant="outline" onClick={addItem}><Plus className="w-4 h-4" /> Qo‘shish</Button>
            </div>
            {loadingProducts && <p className="text-xs text-muted-foreground mt-1">Mahsulotlar yuklanmoqda...</p>}

            <div className="mt-3 space-y-2">
              {items.map((i) => {
                const isSheet = i.production_unit === 'sheet';
                const unit = isSheet ? 'varaq' : 'dona';
                const unitPrice = isSheet ? i.sheet_price : i.price;
                const pcs = isSheet ? (isWedding ? WEDDING_PCS : i.pieces_per_sheet) : 0;
                return (
                  <div key={i.product_id} className="border border-border rounded-xl p-3 bg-secondary/30">
                    <div className="flex items-start gap-3">
                      <div className="w-12 h-12 rounded-lg overflow-hidden bg-secondary shrink-0 flex items-center justify-center">
                        {i.image_url ? <Image src={i.image_url} fittingType="fill" className="w-full h-full" /> : <span className="text-lg">{i.name?.[0]}</span>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{i.name}</div>
                        <div className="text-xs text-muted-foreground">{i.category_name} · {formatUZS(unitPrice)}/{unit}{isSheet ? ` (~${pcs} dona)` : ''}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold text-sm">{formatUZS(unitPrice * i.quantity)}</div>
                      </div>
                      <button onClick={() => removeItem(i.product_id)} className="text-muted-foreground hover:text-rose-600 p-1"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <Label className="text-xs shrink-0">Miqdor</Label>
                      <Input type="number" min="1" value={i.quantity} onChange={(e) => setItemQty(i.product_id, e.target.value)} className="h-9 w-24" />
                      <Input value={i.customization_note} onChange={(e) => setItemNote(i.product_id, e.target.value)} placeholder="Izoh (masalan: yozuv)" className="h-9 flex-1" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Havola rasm (URL)</Label>
              <Input value={form.reference_image} onChange={(e) => update({ reference_image: e.target.value })} className="mt-1" />
            </div>
            <div>
              <Label>Umumiy izoh</Label>
              <Input value={form.notes} onChange={(e) => update({ notes: e.target.value })} className="mt-1" />
            </div>
          </div>

          {isAdmin && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-border pt-4">
              <div>
                <Label>Chegirma / Qo‘shimcha (UZS)</Label>
                <Input type="number" value={form.adjustment_amount} onChange={(e) => update({ adjustment_amount: Number(e.target.value) })} className="mt-1" />
              </div>
              <div>
                <Label>Sabab (majburiy)</Label>
                <Input value={form.adjustment_reason} onChange={(e) => update({ adjustment_reason: e.target.value })} className="mt-1" disabled={adjustment === 0} />
              </div>
            </div>
          )}

          <div className="border-t border-border pt-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={form.useAdvance} onChange={(e) => update({ useAdvance: e.target.checked })} className="w-4 h-4 accent-brand-olive" />
              Avans to‘lov (ixtiyoriy)
            </label>
            {form.useAdvance && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <select value={form.advance_method} onChange={(e) => update({ advance_method: e.target.value })} className="h-11 rounded-xl border border-input bg-card px-3 text-sm">
                  {PAYMENT_METHODS.filter((m) => m.id !== 'other').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
                <Input type="number" min="0" value={form.advance_amount} onChange={(e) => update({ advance_amount: Number(e.target.value) })} placeholder="Summa" />
              </div>
            )}
          </div>

          <div className="bg-secondary/40 rounded-xl p-4 space-y-1.5 text-sm">
            <Row label="Mahsulotlar" value={formatUZS(subtotal)} />
            {form.fulfilment_type === 'delivery' && <Row label="Yetkazib berish" value={formatUZS(deliveryFee)} />}
            {adjustment !== 0 && <Row label="Chegirma/Qo‘shimcha" value={formatUZS(adjustment)} />}
            <div className="border-t border-border pt-1.5 flex justify-between font-bold text-base"><span>Jami</span><span>{formatUZS(total)}</span></div>
            {form.useAdvance && advanceAmount > 0 && <>
              <Row label="Avans" value={formatUZS(advanceAmount)} />
              <Row label="Qoldi (to‘lash)" value={formatUZS(remaining)} strong />
            </>}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4 sticky bottom-0 bg-card pt-3">
          <Button variant="outline" onClick={onClose}><X className="w-4 h-4" /> Bekor</Button>
          <Button onClick={submit} disabled={!valid || submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Saqlash
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const Row = ({ label, value, strong }) => (
  <div className={`flex justify-between ${strong ? 'font-semibold' : ''}`}>
    <span className="text-muted-foreground">{label}</span><span>{value}</span>
  </div>
);