import React, { useEffect, useMemo, useRef, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { base44 } from '@/api/base44Client';
import { formatUZS, PAYMENT_METHODS } from '@/lib/pos';
import { buildIdempotencyKey, ORDER_TYPES, FULFILMENT_TYPES, CAKE_SHAPES, MONTHS_UZ, tashkentNowParts, tashkentNowStamp, composeRequiredDate, isFutureDateTime } from '@/lib/orders';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Image } from '@/components/ui/image';
import { Plus, Minus, Trash2, X, Loader2, Lock } from 'lucide-react';
import ProductCombobox from '@/components/orders/ProductCombobox';
import ReferenceImageField from '@/components/orders/ReferenceImageField';
import { useToast } from '@/components/ui/use-toast';

const WEDDING_PCS = 40;

const isOrderCatalogProduct = (product) => {
  if (product?.production_unit === 'sheet') return true;
  const name = String(product?.name || '').toUpperCase();
  return ['LIST', 'ЛИСТ', 'MINI', 'МИНИ'].some((marker) => name.includes(marker));
};

function mapPrefillItems(sourceItems, products) {
  return (sourceItems || []).map((si) => {
    const p = (products || []).find((x) => x.id === si.product_id);
    if (p) {
      return {
        product_id: p.id, name: p.name, image_url: p.image_url || '',
        category_name: p.category_name || '', production_unit: p.production_unit || 'piece',
        price: Number(p.price || 0), sheet_price: Number(p.sheet_price || 0),
        pieces_per_sheet: Number(p.pieces_per_sheet || 20),
        quantity: Math.max(1, Math.floor(Number(si.quantity) || 1)),
        customization_note: si.customization_note || '',
      };
    }
    const isSheet = si.unit_snapshot === 'sheet';
    return {
      product_id: si.product_id, name: si.product_name_snapshot,
      image_url: si.product_image_snapshot || '', category_name: si.category_name_snapshot || '',
      production_unit: isSheet ? 'sheet' : 'piece',
      price: isSheet ? 0 : Number(si.unit_price_snapshot || 0),
      sheet_price: isSheet ? Number(si.unit_price_snapshot || 0) : 0,
      pieces_per_sheet: Number(si.event_pieces_per_sheet_snapshot) || 20,
      quantity: Math.max(1, Math.floor(Number(si.quantity) || 1)),
      customization_note: si.customization_note || '',
    };
  });
}

export default function OrderForm({ open, onClose, onCreated, user, shops, prefill }) {
  const { toast } = useToast();
  const role = user?.role || 'cashier';
  const isAdmin = role === 'admin';
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [items, setItems] = useState([]);
  const [acceptanceStamp, setAcceptanceStamp] = useState('');
  const [dateParts, setDateParts] = useState({ day: '', month: '', year: '' });
  const [form, setForm] = useState(() => ({
    order_type: 'toy_va_bazmlar', customer_name: '', customer_phone: '',
    required_date: '', required_time: '18:00', shop_id: user?.shop_id || '',
    fulfilment_type: 'pickup', delivery_address: '', delivery_fee: 0,
    cake_shape: '', reference_image: '', notes: '',
    adjustment_amount: '', adjustment_reason: '',
    useAdvance: false, advance_method: 'cash', advance_amount: 0,
  }));

  useEffect(() => {
    if (!open) return;
    setLoadingProducts(true);
    base44.entities.Product.list('name', 500)
      .then((list) => setProducts((list || []).filter((p) => p.active !== false && p.archived !== true && isOrderCatalogProduct(p))))
      .catch(() => setProducts([]))
      .finally(() => setLoadingProducts(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setAcceptanceStamp(tashkentNowStamp());
    const np = tashkentNowParts();
    setDateParts({ day: '', month: String(np.month), year: String(np.year) });
  }, [open]);

  useEffect(() => {
    if (open && role === 'cashier') setForm((f) => ({ ...f, shop_id: user?.shop_id || '' }));
  }, [open, role, user]);

  const appliedPrefillId = useRef('');
  const hadPrefill = useRef(false);

  useEffect(() => {
    if (!open) { appliedPrefillId.current = ''; return; }
    if (prefill) {
      if (loadingProducts) return;
      if (appliedPrefillId.current === prefill.order.id) return;
      appliedPrefillId.current = prefill.order.id;
      hadPrefill.current = true;
      const np = tashkentNowParts();
      setForm({
        order_type: prefill.order.order_type || 'toy_va_bazmlar',
        customer_name: prefill.order.customer_name || '',
        customer_phone: prefill.order.customer_phone || '',
        required_date: '',
        required_time: prefill.order.required_time || '18:00',
        shop_id: isAdmin ? (prefill.order.shop_id || '') : (user?.shop_id || ''),
        fulfilment_type: prefill.order.fulfilment_type || 'pickup',
        delivery_address: prefill.order.delivery_address || '',
        delivery_fee: prefill.order.delivery_fee || 0,
        cake_shape: prefill.order.cake_shape || '',
        reference_image: prefill.order.reference_image || '',
        notes: prefill.order.notes || '',
        adjustment_amount: '', adjustment_reason: '',
        useAdvance: false, advance_method: 'cash', advance_amount: 0,
      });
      setDateParts({ day: '', month: String(np.month), year: String(np.year) });
      setItems(mapPrefillItems(prefill.items || [], products));
    } else if (hadPrefill.current) {
      hadPrefill.current = false;
      appliedPrefillId.current = '';
      setItems([]);
      const np = tashkentNowParts();
      setDateParts({ day: '', month: String(np.month), year: String(np.year) });
      setForm({ order_type: 'toy_va_bazmlar', customer_name: '', customer_phone: '', required_date: '', required_time: '18:00',
        shop_id: user?.shop_id || '', fulfilment_type: 'pickup', delivery_address: '', delivery_fee: 0,
        cake_shape: '', reference_image: '', notes: '', adjustment_amount: '', adjustment_reason: '',
        useAdvance: false, advance_method: 'cash', advance_amount: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill, loadingProducts, products]);

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

  const addFromCombobox = (p, qty) => {
    const q = Math.max(1, Math.floor(Number(qty) || 0));
    setItems((prev) => {
      const existing = prev.find((i) => i.product_id === p.id);
      if (existing) {
        return prev.map((i) => i.product_id === p.id ? { ...i, quantity: i.quantity + q } : i);
      }
      return [...prev, { product_id: p.id, name: p.name, image_url: p.image_url || '', category_name: p.category_name || '',
        production_unit: p.production_unit || 'piece', price: Number(p.price || 0), sheet_price: Number(p.sheet_price || 0),
        pieces_per_sheet: Number(p.pieces_per_sheet || 20), quantity: q, customization_note: '' }];
    });
  };

  const setItemQty = (id, qty) => setItems((prev) => prev.map((i) => i.product_id === id ? { ...i, quantity: Math.max(1, Math.floor(Number(qty) || 1)) } : i));
  const incItemQty = (id, delta) => setItems((prev) => prev.map((i) => i.product_id === id ? { ...i, quantity: Math.max(1, i.quantity + delta) } : i));
  const setItemNote = (id, note) => setItems((prev) => prev.map((i) => i.product_id === id ? { ...i, customization_note: note } : i));
  const removeItem = (id) => setItems((prev) => prev.filter((i) => i.product_id !== id));

  const isWedding = form.order_type === 'toy_va_bazmlar';
  const composedDate = useMemo(() => composeRequiredDate(dateParts.year, dateParts.month, dateParts.day), [dateParts]);
  const yearOptions = useMemo(() => { const np = tashkentNowParts(); return [np.year, np.year + 1, np.year + 2]; }, []);
  const daysInMonth = useMemo(() => { const y = Number(dateParts.year); const m = Number(dateParts.month); return (y && m) ? new Date(y, m, 0).getDate() : 31; }, [dateParts.year, dateParts.month]);
  const dateError = useMemo(() => {
    if (!dateParts.day) return '';
    if (!composedDate) return 'Noto‘g‘ri sana';
    if (!isFutureDateTime(composedDate, form.required_time)) return 'O‘tib ketgan sana yoki vaqt';
    return '';
  }, [composedDate, dateParts.day, form.required_time]);
  useEffect(() => { setForm((f) => ({ ...f, required_date: composedDate })); }, [composedDate]);
  const subtotal = useMemo(() => items.reduce((sum, i) => {
    const unit = i.production_unit === 'sheet' ? Number(i.sheet_price || 0) : Number(i.price || 0);
    return sum + unit * i.quantity;
  }, 0), [items]);

  const deliveryFee = form.fulfilment_type === 'delivery' ? (isWedding ? 0 : Math.max(0, Number(form.delivery_fee || 0))) : 0;
  const adjustment = Number(form.adjustment_amount) || 0;
  const total = Math.max(0, subtotal + deliveryFee + adjustment);
  const advanceAmount = form.useAdvance ? Math.min(Number(form.advance_amount || 0), total) : 0;
  const remaining = total - advanceAmount;

  const valid = form.customer_name.trim() && form.customer_phone.trim() && form.required_date && form.required_time
    && !dateError
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
        onCreated(data.order, data.items || []);
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
    const np = tashkentNowParts();
    setDateParts({ day: '', month: String(np.month), year: String(np.year) });
    setAcceptanceStamp(tashkentNowStamp());
    setForm({ order_type: 'toy_va_bazmlar', customer_name: '', customer_phone: '', required_date: '', required_time: '18:00',
      shop_id: user?.shop_id || '', fulfilment_type: 'pickup', delivery_address: '', delivery_fee: 0,
      cake_shape: '', reference_image: '', notes: '', adjustment_amount: '', adjustment_reason: '',
      useAdvance: false, advance_method: 'cash', advance_amount: 0 });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle>{prefill ? 'Qayta buyurtma' : 'Yangi buyurtma'}</DialogTitle>
          <DialogDescription>
            {prefill ? `${prefill.order.order_number} asosida yangi buyurtma — sanani va vaqtni qaytadan tanlang.` : 'Mijoz va mahsulot ma’lumotlarini to‘ldiring.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Buyurtma turi *</Label>
              <OdinaSelect value={form.order_type} onChange={(e) => update({ order_type: e.target.value })} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                {ORDER_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </OdinaSelect>
            </div>
            <div>
              <Label>Qabul qiluvchi do‘kon {isAdmin ? '*' : ''}</Label>
              <OdinaSelect value={isAdmin ? form.shop_id : user?.shop_id} disabled={!isAdmin}
                onChange={(e) => update({ shop_id: e.target.value })}
                className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm disabled:opacity-60">
                <option value="">Tanlang</option>
                {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </OdinaSelect>
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

          <div className="rounded-xl border border-border bg-secondary/20 p-3 flex items-center gap-2.5 text-sm">
            <Lock className="w-4 h-4 text-brand-olive shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-muted-foreground">Qabul qilingan vaqt (avtomatik)</div>
              <div className="font-medium truncate">{acceptanceStamp || '—'}</div>
            </div>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            <div>
              <Label>Topshirish kuni *</Label>
              <OdinaSelect value={dateParts.day} onChange={(e) => setDateParts((d) => ({ ...d, day: e.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                <option value="">Kun</option>
                {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => <option key={d} value={String(d)}>{d}</option>)}
              </OdinaSelect>
            </div>
            <div>
              <Label>Oy *</Label>
              <OdinaSelect value={dateParts.month} onChange={(e) => setDateParts((d) => ({ ...d, month: e.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                {MONTHS_UZ.map((m, idx) => <option key={idx} value={String(idx + 1)}>{m}</option>)}
              </OdinaSelect>
            </div>
            <div>
              <Label>Yil *</Label>
              <OdinaSelect value={dateParts.year} onChange={(e) => setDateParts((d) => ({ ...d, year: e.target.value }))} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                {yearOptions.map((y) => <option key={y} value={String(y)}>{y}</option>)}
              </OdinaSelect>
            </div>
            <div>
              <Label>Vaqt *</Label>
              <input type="time" value={form.required_time} onChange={(e) => update({ required_time: e.target.value })} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm" />
            </div>
            <div>
              <Label>Shakl</Label>
              <OdinaSelect value={form.cake_shape} onChange={(e) => update({ cake_shape: e.target.value })} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                <option value="">—</option>
                {CAKE_SHAPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </OdinaSelect>
            </div>
          </div>
          {dateError && <p className="text-xs text-rose-600 -mt-2">{dateError}</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Yetkazib berish *</Label>
              <OdinaSelect value={form.fulfilment_type} onChange={(e) => update({ fulfilment_type: e.target.value })} className="mt-1 h-11 w-full rounded-xl border border-input bg-card px-3 text-sm">
                {FULFILMENT_TYPES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </OdinaSelect>
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
            <div className="mt-2">
              <ProductCombobox products={products} onAdd={addFromCombobox} loading={loadingProducts} />
            </div>

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
                        {i.image_url ? <Image src={i.image_url} alt={i.name || 'Mahsulot rasmi'} fittingType="fill" className="w-full h-full" /> : <span className="text-lg">{i.name?.[0]}</span>}
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
                      <button type="button" onClick={() => incItemQty(i.product_id, -1)} className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:bg-secondary shrink-0"><Minus className="w-4 h-4" /></button>
                      <Input type="number" min="1" value={i.quantity} onChange={(e) => setItemQty(i.product_id, e.target.value)} className="h-9 w-20 text-center" />
                      <button type="button" onClick={() => incItemQty(i.product_id, 1)} className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:bg-secondary shrink-0"><Plus className="w-4 h-4" /></button>
                      <Input value={i.customization_note} onChange={(e) => setItemNote(i.product_id, e.target.value)} placeholder="Izoh (masalan: yozuv)" className="h-9 flex-1 min-w-0" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <Label>Namuna rasm (ixtiyoriy)</Label>
            <div className="mt-1">
              <ReferenceImageField value={form.reference_image} onChange={(url) => update({ reference_image: url })} disabled={submitting} />
            </div>
          </div>
          <div>
            <Label>Umumiy izoh</Label>
            <Input value={form.notes} onChange={(e) => update({ notes: e.target.value })} className="mt-1" />
          </div>

          {isAdmin && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-border pt-4">
              <div>
                <Label>Chegirma / Qo‘shimcha (UZS)</Label>
                <Input type="number" value={form.adjustment_amount} onChange={(e) => update({ adjustment_amount: e.target.value })} placeholder="Masalan: 25000 yoki -25000" className="mt-1" />
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
                <OdinaSelect value={form.advance_method} onChange={(e) => update({ advance_method: e.target.value })} className="h-11 rounded-xl border border-input bg-card px-3 text-sm">
                  {PAYMENT_METHODS.filter((m) => m.id !== 'other').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </OdinaSelect>
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