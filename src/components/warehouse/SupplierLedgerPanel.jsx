import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardList, PackagePlus, Plus, ReceiptText, Scale, Trash2, Truck } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { formatNum, formatUZS } from '@/lib/pos';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const UNIT_LABELS = { kg: 'kg', l: 'litr', g: 'g', ml: 'ml', piece: 'dona' };
const STATUS_LABELS = { unpaid: 'To‘lanmagan', partial: 'Qisman to‘langan', paid: 'To‘langan' };

export default function SupplierLedgerPanel({ user, location, ingredients, recipients, search }) {
  const [receipts, setReceipts] = useState([]);
  const [receiptItems, setReceiptItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [receiptList, itemList] = await Promise.all([
        base44.entities.SupplierReceipt.list('-received_at', 500),
        base44.entities.SupplierReceiptItem.list('-created_date', 500),
      ]);
      setReceipts(receiptList || []);
      setReceiptItems(itemList || []);
    } catch (error) {
      alert('Kirim va qarzlarni yuklab bo‘lmadi: ' + (error?.message || error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    const query = search.toLowerCase().trim();
    return receipts.filter((receipt) => {
      if (user?.role !== 'admin' && receipt.location_id !== location?.id) return false;
      if (user?.role === 'admin' && location?.id && receipt.location_id !== location.id) return false;
      if (!query) return true;
      return [
        receipt.receipt_number,
        receipt.supplier_name_snapshot,
        receipt.location_name_snapshot,
        receipt.invoice_reference,
        receipt.notes,
      ].filter(Boolean).join(' ').toLowerCase().includes(query);
    });
  }, [receipts, user?.role, location?.id, search]);

  const outstanding = visible.reduce((sum, receipt) => sum + Number(receipt.remaining_debt || 0), 0);
  const totalPurchases = visible.reduce((sum, receipt) => sum + Number(receipt.total_amount || 0), 0);
  const canReceive = ['admin', 'warehouse'].includes(user?.role);

  if (loading) {
    return <div className="grid sm:grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-36 rounded-2xl bg-secondary animate-pulse" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-card p-4 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex-1">
          <p className="font-semibold">Yetkazib beruvchilar kirimi va qarzi</p>
          <p className="text-sm text-muted-foreground mt-1">Tovar kelganda qoldiq va qarz bir vaqtda yaratiladi.</p>
        </div>
        {canReceive && (
          <Button onClick={() => setDialogOpen(true)} disabled={!location} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong">
            <PackagePlus className="w-4 h-4 mr-1.5" /> Yangi kirim
          </Button>
        )}
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <Summary icon={ReceiptText} label="Jami kirim" value={formatUZS(totalPurchases)} />
        <Summary icon={Scale} label="Qolgan qarz" value={formatUZS(outstanding)} warning={outstanding > 0} />
        <Summary icon={Truck} label="Kirimlar soni" value={formatNum(visible.length)} />
      </div>

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-14 text-center">
          <ClipboardList className="w-9 h-9 mx-auto text-muted-foreground/40 mb-3" />
          <p className="font-medium">Hali yetkazib beruvchi kirimi yo‘q</p>
          <p className="text-sm text-muted-foreground mt-1">Yangi kirim yaratilganda shu yerda ko‘rinadi.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((receipt) => {
            const items = receiptItems.filter((item) => item.receipt_id === receipt.id);
            return (
              <div key={receipt.id} className="rounded-2xl border border-border bg-card premium-shadow p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{receipt.supplier_name_snapshot}</p>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${Number(receipt.remaining_debt || 0) > 0 ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
                        {STATUS_LABELS[receipt.status] || receipt.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {receipt.receipt_number} · {receipt.location_name_snapshot} · {new Date(receipt.received_at || receipt.created_date).toLocaleString('uz-UZ')}
                    </p>
                    {items.length > 0 && (
                      <p className="text-sm mt-3">
                        {items.map((item) => `${item.ingredient_name_snapshot}: ${formatNum(item.purchase_quantity)} ${UNIT_LABELS[item.purchase_unit] || item.purchase_unit}`).join(' · ')}
                      </p>
                    )}
                    {receipt.notes && <p className="text-xs text-muted-foreground mt-2">{receipt.notes}</p>}
                  </div>
                  <div className="sm:text-right shrink-0">
                    <p className="text-xs text-muted-foreground">Kirim summasi</p>
                    <p className="font-semibold">{formatUZS(receipt.total_amount)}</p>
                    <p className="text-xs text-muted-foreground mt-2">Qolgan qarz</p>
                    <p className={`text-lg font-semibold ${Number(receipt.remaining_debt || 0) > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {formatUZS(receipt.remaining_debt)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ReceiptDialog
        open={dialogOpen}
        location={location}
        ingredients={ingredients}
        recipients={recipients}
        onClose={() => setDialogOpen(false)}
        onSaved={() => { setDialogOpen(false); load(); }}
      />
    </div>
  );
}

function Summary({ icon: Icon, label, value, warning }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="w-4 h-4" />{label}</div>
      <p className={`text-xl font-semibold mt-2 ${warning ? 'text-amber-700' : ''}`}>{value}</p>
    </div>
  );
}

function ReceiptDialog({ open, location, ingredients, recipients, onClose, onSaved }) {
  const [supplierId, setSupplierId] = useState('');
  const [invoiceReference, setInvoiceReference] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([{ ingredient_id: '', purchase_quantity: '', unit_price: '' }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSupplierId('');
      setInvoiceReference('');
      setNotes('');
      setLines([{ ingredient_id: '', purchase_quantity: '', unit_price: '' }]);
    }
  }, [open]);

  const supplierList = recipients.filter((recipient) => recipient.active !== false && ['supplier', 'company'].includes(recipient.recipient_type));
  const lineTotal = (line) => Number(line.purchase_quantity || 0) * Number(line.unit_price || 0);
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const valid = supplierId && location?.id && lines.length > 0 && lines.every((line) =>
    line.ingredient_id && Number(line.purchase_quantity) > 0 && Number(line.unit_price) >= 0,
  ) && total > 0 && new Set(lines.map((line) => line.ingredient_id)).size === lines.length;

  const updateLine = (index, key, value) => {
    setLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, [key]: value } : line));
  };

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      const result = await base44.functions.invoke('supplier-ledger', {
        action: 'create_receipt',
        supplier_id: supplierId,
        location_id: location.id,
        invoice_reference: invoiceReference.trim() || undefined,
        notes: notes.trim() || undefined,
        items: lines.map((line) => ({
          ingredient_id: line.ingredient_id,
          purchase_quantity: Number(line.purchase_quantity),
          unit_price: Number(line.unit_price),
        })),
      });
      const payload = result?.data || result;
      if (!payload?.receipt) throw new Error(payload?.error || 'Kirimni saqlab bo‘lmadi.');
      onSaved();
    } catch (error) {
      alert('Kirim amalga oshmadi: ' + (error?.response?.data?.error || error?.data?.error || error?.message || error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[92dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Yetkazib beruvchidan yangi kirim</DialogTitle>
          <p className="text-sm text-muted-foreground">{location?.name} · jami summa avtomatik qarzga yoziladi</p>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs mb-1.5 block">Yetkazib beruvchi</Label>
              <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
                <option value="">Ro‘yxatdan tanlang</option>
                {supplierList.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </select>
              {supplierList.length === 0 && <p className="text-xs text-amber-700 mt-1.5">Owner avval Kassa → Qabul qiluvchilar bo‘limida yetkazib beruvchi yaratishi kerak.</p>}
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Hisob-faktura raqami (ixtiyoriy)</Label>
              <Input value={invoiceReference} onChange={(event) => setInvoiceReference(event.target.value)} placeholder="Masalan: 154-A" className="h-11 rounded-xl" />
            </div>
          </div>

          <div className="space-y-3">
            {lines.map((line, index) => {
              const ingredient = ingredients.find((item) => item.id === line.ingredient_id);
              return (
                <div key={index} className="rounded-2xl border border-border bg-secondary/30 p-3">
                  <div className="grid sm:grid-cols-[1fr_130px_160px_auto] gap-2 items-end">
                    <div>
                      <Label className="text-xs mb-1.5 block">Masalliq yoki qadoq</Label>
                      <select value={line.ingredient_id} onChange={(event) => updateLine(index, 'ingredient_id', event.target.value)} className="w-full h-11 rounded-xl border border-input bg-card px-3 text-sm">
                        <option value="">Tanlang</option>
                        {ingredients.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs mb-1.5 block">Miqdor ({UNIT_LABELS[ingredient?.purchase_unit] || 'birlik'})</Label>
                      <Input type="number" min="0.001" step="0.001" value={line.purchase_quantity} onChange={(event) => updateLine(index, 'purchase_quantity', event.target.value)} placeholder="0" className="h-11 rounded-xl" />
                    </div>
                    <div>
                      <Label className="text-xs mb-1.5 block">1 birlik narxi</Label>
                      <Input type="number" min="0" step="1" value={line.unit_price} onChange={(event) => updateLine(index, 'unit_price', event.target.value)} placeholder="0 UZS" className="h-11 rounded-xl" />
                    </div>
                    <Button type="button" variant="ghost" size="icon" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))} className="h-11 w-11 text-destructive">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 text-right">Qator jami: <span className="font-medium text-foreground">{formatUZS(lineTotal(line))}</span></p>
                </div>
              );
            })}
            <Button type="button" variant="outline" onClick={() => setLines((current) => [...current, { ingredient_id: '', purchase_quantity: '', unit_price: '' }])} className="min-h-11 rounded-xl">
              <Plus className="w-4 h-4 mr-1.5" /> Yana masalliq
            </Button>
          </div>

          <div>
            <Label className="text-xs mb-1.5 block">Izoh (ixtiyoriy)</Label>
            <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Yetkazib berish haqida izoh" rows={2} />
          </div>

          <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-amber-800">Avtomatik yaratiladigan qarz</p>
              <p className="text-xs text-amber-700 mt-1">To‘lov keyin istalgan do‘kon kassasidan owner PIN bilan qilinadi.</p>
            </div>
            <p className="text-xl font-semibold text-amber-800 whitespace-nowrap">{formatUZS(total)}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={save} disabled={saving || !valid} className="min-h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong">
            {saving ? 'Saqlanmoqda…' : 'Kirim va qarzni yaratish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
