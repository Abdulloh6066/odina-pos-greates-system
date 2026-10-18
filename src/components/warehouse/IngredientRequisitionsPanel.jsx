import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ClipboardList, Loader2, Plus, Printer, RefreshCw, Search, Trash2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import OdinaSelect from '@/components/ui/odina-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { odinaConfirm } from '@/lib/odina-dialog';
import { formatUZS } from '@/lib/pos';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import { clearOrderRequest, orderRequestScope, readOrderRequest, retainOrderRequest } from '@/lib/order-request-retry';
import { REQUISITION_UNITS, REQUISITION_STATUSES, requisitionNumber, requisitionReceiptLines, requisitionReceiptTotal, tomorrowRequisitionDate } from '@/lib/ingredient-requisitions';
import IngredientRequisitionTicket, { IngredientRequisitionTicketContent } from './IngredientRequisitionTicket';
import './ingredient-requisitions.css';

const textError = e => e?.response?.data?.error || e?.data?.error || e?.message || 'Amal bajarilmadi.';
const errorData = e => e?.response?.data || e?.data || {};
const newKey = prefix => `${prefix}-${crypto.randomUUID()}`;
async function invoke(payload) {
  const response = await base44.functions.invoke('ingredient-request', payload);
  const data = response?.data || response;
  if (data?.error) throw Object.assign(new Error(data.error), { data });
  return data;
}

export default function IngredientRequisitionsPanel({ user, location, adminShopScope, onStockChanged }) {
  const [catalog, setCatalog] = useState({ ingredients: [], warehouses: [], suppliers: [] });
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [hasMore, setHasMore] = useState(false);
  const [numberSearch, setNumberSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [ingredientSearch, setIngredientSearch] = useState('');
  const [requiredDate, setRequiredDate] = useState(tomorrowRequisitionDate);
  const [sourceKind, setSourceKind] = useState('purchase');
  const [sourceLocation, setSourceLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [draftItems, setDraftItems] = useState([]);
  const [pendingCreate, setPendingCreate] = useState(null);
  const [selected, setSelected] = useState(null);
  const [values, setValues] = useState({});
  const [supplierId, setSupplierId] = useState('');
  const [paymentState, setPaymentState] = useState('unpaid');
  const [invoiceReference, setInvoiceReference] = useState('');
  const [verified, setVerified] = useState(false);
  const [pendingReceipt, setPendingReceipt] = useState(null);
  const [preview, setPreview] = useState(null);
  const [printing, setPrinting] = useState(null);
  const createScope = orderRequestScope(user.id, 'ingredient-requisition-create', location.id);
  const receiptScope = selected ? orderRequestScope(user.id, 'ingredient-requisition-receive', selected.id) : '';

  const load = async (search = activeSearch, append = false) => {
    setLoading(true); setError('');
    try {
      const result = await invoke({ action: 'list', location_id: location.id, search, skip: append ? requests.length : 0 });
      setRequests(previous => append ? [...new Map([...previous, ...result.requests].map(r => [r.id, r])).values()] : result.requests);
      setHasMore(result.has_more);
    } catch (e) { setError(textError(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([invoke({ action: 'catalog', location_id: location.id }), invoke({ action: 'list', location_id: location.id })])
      .then(([data, result]) => { if (active) { setCatalog(data); setRequests(result.requests); setHasMore(result.has_more); } })
      .catch(e => { if (active) setError(textError(e)); })
      .finally(() => { if (active) setLoading(false); });
    setPendingCreate(readOrderRequest(createScope));
    return () => { active = false; };
  }, [location.id, createScope]);

  useEffect(() => adminShopScope?.registerGuard?.(() => busy || createOpen || selected || pendingCreate
    ? 'Avval talabnoma oynasini yoping yoki boshlangan amalni tekshirib yakunlang.' : ''),
  [adminShopScope?.registerGuard, busy, createOpen, selected, pendingCreate]);

  useEffect(() => {
    if (!selected) { setPendingReceipt(null); return; }
    let saved = readOrderRequest(receiptScope);
    if (saved && selected.history.some(h => h.key === saved.idempotency_key)) {
      clearOrderRequest(receiptScope); saved = null;
    }
    setPendingReceipt(saved);
    setValues(saved ? Object.fromEntries(saved.items.map(item => [item.ingredient_id, { quantity: String(item.quantity), unit_price: String(item.unit_price ?? '') }])) : {});
    setSupplierId(saved?.supplier_id || ''); setPaymentState(saved?.payment_state || 'unpaid');
    setInvoiceReference(saved?.invoice_reference || ''); setVerified(Boolean(saved?.verified));
    setError('');
  }, [selected?.id, receiptScope]);

  const execute = async operation => {
    if (busyRef.current) return null;
    busyRef.current = true; setBusy(true); setError(''); setSuccess('');
    try { return await operation(); }
    catch (e) { setError(textError(e)); return null; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const upsert = request => {
    setRequests(previous => [request, ...previous.filter(row => row.id !== request.id)]);
    setSelected(previous => previous?.id === request.id ? request : previous);
  };
  const persistCall = async (scope, payload) => {
    const frozen = retainOrderRequest(scope, payload);
    try {
      const result = await invoke(frozen);
      clearOrderRequest(scope);
      return result;
    } catch (e) {
      if (errorData(e).request_not_started === true) clearOrderRequest(scope);
      throw e;
    }
  };
  const openCreate = () => {
    setError(''); setSuccess(''); setIngredientSearch('');
    if (pendingCreate) {
      setRequiredDate(pendingCreate.required_date); setSourceKind(pendingCreate.source_kind);
      setSourceLocation(pendingCreate.source_location_id || ''); setNotes(pendingCreate.notes || '');
      setDraftItems(pendingCreate.items.map(item => ({ ingredient_id: item.ingredient_id, quantity: String(item.quantity) })));
    } else { setRequiredDate(tomorrowRequisitionDate()); setSourceKind('purchase'); setSourceLocation(''); setNotes(''); setDraftItems([]); }
    setCreateOpen(true);
  };
  const save = async event => {
    event.preventDefault();
    await execute(async () => {
      try {
        const result = await persistCall(createScope, pendingCreate || { action: 'create', idempotency_key: newKey('ir-create'),
          location_id: location.id, source_kind: sourceKind, source_location_id: sourceKind === 'warehouse' ? sourceLocation : '',
          required_date: requiredDate, notes, items: draftItems.map(item => ({ ingredient_id: item.ingredient_id, quantity: item.quantity })) });
        setPendingCreate(null); upsert(result.request); setCreateOpen(false); setSelected(result.request);
        setSuccess('Talabnoma saqlandi. Chek chiqarishingiz mumkin.');
      } finally { setPendingCreate(readOrderRequest(createScope)); }
    });
  };
  const receive = async () => execute(async () => {
    try {
      const result = await persistCall(receiptScope, pendingReceipt || { action: 'receive', request_id: selected.id,
        idempotency_key: newKey('ir-receive'), expected_version: selected.version, verified,
        items: requisitionReceiptLines(selected, values), supplier_id: supplierId, payment_state: paymentState, invoice_reference: invoiceReference });
      setPendingReceipt(null); upsert(result.request); setValues({}); setVerified(false);
      setSuccess(result.already_processed ? 'Bu qabul avval saqlangan. Qoldiq qayta qo‘shilmadi.' : 'Kelgan mahsulotlar omborga kirim qilindi.');
      onStockChanged?.();
    } finally { setPendingReceipt(readOrderRequest(receiptScope)); }
  });
  const resume = async () => execute(async () => {
    const result = await invoke({ action: 'resume', request_id: selected.id });
    clearOrderRequest(receiptScope); setPendingReceipt(null); upsert(result.request); setValues({}); setVerified(false);
    setSuccess('Qabul tekshirilib yakunlandi.'); onStockChanged?.();
  });
  const approve = async request => execute(async () => {
    if (!await odinaConfirm(`${request.location_name} uchun talabnomadagi miqdorlarga ruxsat berasizmi? Qoldiq mahsulot qabul qilinganda o‘tkaziladi.`, { title: 'Ombor tasdig‘i', confirmLabel: 'Tasdiqlash' })) return;
    const result = await invoke({ action: 'approve', request_id: request.id, expected_version: request.version });
    upsert(result.request); setSuccess('Markaziy ombor talabi tasdiqlandi.');
  });
  const cancel = async request => execute(async () => {
    if (!await odinaConfirm('Talabnomaning hali kelmagan qismini bekor qilasizmi? Qabul qilingan mahsulotlar saqlanadi.', { title: 'Talabnomani bekor qilish', confirmLabel: 'Bekor qilish' })) return;
    const result = await invoke({ action: 'cancel', request_id: request.id, expected_version: request.version });
    upsert(result.request); setSuccess('Qolgan talab bekor qilindi.');
  });

  const ingredientMap = useMemo(() => new Map(catalog.ingredients.map(item => [item.id, item])), [catalog.ingredients]);
  const available = useMemo(() => {
    const selectedIds = new Set(draftItems.map(item => item.ingredient_id));
    const query = ingredientSearch.trim().toLocaleLowerCase();
    return catalog.ingredients.filter(item => !selectedIds.has(item.id) && (!query || item.ingredient_name.toLocaleLowerCase().includes(query))).slice(0, 30);
  }, [catalog.ingredients, draftItems, ingredientSearch]);
  const visible = requests.filter(request => status === 'all' || (request.pending_receipt ? status === 'pending' : request.status === status));
  const destinationView = selected?.location_id === location.id;
  const receivePermission = selected && destinationView && (selected.source_kind === 'purchase' ? catalog.can_purchase_receive : catalog.can_transfer_receive);
  const canReceiveNow = receivePermission && !['received', 'cancelled'].includes(selected.status) && !selected.cancellation_pending
    && (selected.source_kind === 'purchase' || selected.approved_by);
  const receivingLocked = busy || Boolean(selected?.pending_receipt || pendingReceipt);
  const selectedLines = selected ? requisitionReceiptLines(selected, values) : [];
  const receiptInvalid = selectedLines.length === 0 || selectedLines.some(line => {
    const item = selected.items.find(row => row.ingredient_id === line.ingredient_id);
    return Number(line.quantity) > item.remaining_quantity || (item.base_unit === 'piece' && !Number.isInteger(Number(line.quantity)))
      || (selected.source_kind === 'purchase' && !/^\d+$/.test(String(line.unit_price)));
  });

  return <section className="ir-panel space-y-4" aria-label="Ertaga kerak mahsulot talabnomalari">
    <div className="ir-toolbar"><div><h2>Ertaga kerak</h2><p>Masalliq va qadoqlarni ro‘yxat qiling, chek chiqaring. Mahsulot kelganda miqdor va narxni tekshirib qabul qiling.</p></div>
      <div className="ir-actions"><Button type="button" variant="outline" disabled={busy || loading} onClick={() => load()}><RefreshCw className="w-4 h-4 mr-2" />Yangilash</Button>
        {catalog.can_create && <Button type="button" disabled={busy} onClick={openCreate}><Plus className="w-4 h-4 mr-2" />Yangi talabnoma</Button>}</div></div>
    {error && <p className="ir-error" role="alert">{error}</p>}
    {success && <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{success}</p>}
    {pendingCreate && <div className="ir-warning">Oldingi saqlashning javobi olinmagan. Yangi talabnoma yaratishdan oldin uni tekshiring. <Button type="button" variant="outline" onClick={openCreate}>Saqlashni qayta tekshirish</Button></div>}
    {catalog.unavailable_ingredients?.length > 0 && <p className="ir-warning">O‘lchov birligi tekshirilishi kerak: {catalog.unavailable_ingredients.join(', ')}.</p>}
    <form className="ir-search-row" onSubmit={event => { event.preventDefault(); setActiveSearch(numberSearch); void load(numberSearch); }}>
      <Input aria-label="Talabnoma raqamini qidirish" placeholder="Chekdagi talabnoma raqami…" value={numberSearch} onChange={e => setNumberSearch(e.target.value)} />
      <Button type="submit" variant="outline" disabled={loading || busy}><Search className="w-4 h-4 mr-2" />Qidirish</Button>
      <OdinaSelect aria-label="Talabnoma holati" value={status} onChange={e => setStatus(e.target.value)}><option value="all">Barcha holatlar</option>
        {Object.entries(REQUISITION_STATUSES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="pending">Qabul yakunlanmagan</option></OdinaSelect>
    </form>
    {loading && requests.length === 0 ? <div className="ir-card flex gap-2 items-center" role="status"><Loader2 className="animate-spin w-4 h-4" />Talabnomalar yuklanmoqda…</div>
      : visible.length === 0 ? <div className="ir-card py-10 text-center"><ClipboardList className="w-9 h-9 mx-auto mb-3 text-muted-foreground" /><p className="font-medium">Hozircha talabnoma yo‘q</p><p className="ir-muted">“Yangi talabnoma” orqali sut, shakar va boshqa kerakli mahsulotlarni yozing.</p></div>
        : <div className="grid xl:grid-cols-2 gap-4">{visible.map(request => <article key={request.id} className="ir-card space-y-3">
          <div className="ir-card-header"><div><h3>{request.request_number}</h3><p className="ir-muted">{request.location_name} · {request.required_date.split('-').reverse().join('.')}</p></div>
            <span className={`ir-status ir-status-${request.status}`}>{request.pending_receipt ? 'Qabul yakunlanmagan' : REQUISITION_STATUSES[request.status]}</span></div>
          <p className="text-sm">{request.items.slice(0, 3).map(item => `${item.ingredient_name} — ${requisitionNumber(item.requested_quantity)} ${REQUISITION_UNITS[item.purchase_unit]}`).join(' · ')}{request.items.length > 3 ? ` · yana ${request.items.length - 3} tur` : ''}</p>
          <p className="ir-muted">{request.source_kind === 'purchase' ? 'Xarid' : `${request.source_location_name} → ${request.location_name}`}{request.source_kind === 'warehouse' && !request.approved_by ? ' · Ombor tasdig‘i kutilmoqda' : ''}<br />Tuzgan: {request.created_by_name}</p>
          <div className="ir-actions"><Button type="button" variant="outline" onClick={() => { setSelected(request); setSuccess(''); }} disabled={busy}>Ochish / Qabul qilish</Button>
            <Button type="button" variant="outline" disabled={Boolean(printing)} onClick={() => setPrinting(request)}><Printer className="w-4 h-4 mr-2" />Chek chiqarish</Button>
            <Button type="button" variant="ghost" onClick={() => setPreview(request)}>Chek ko‘rinishi</Button></div>
        </article>)}</div>}
    {hasMore && <Button type="button" variant="outline" disabled={loading || busy} onClick={() => load(activeSearch, true)}>Yana yuklash</Button>}

    <Dialog open={createOpen} onOpenChange={open => { if (!busy) setCreateOpen(open); }}><DialogContent className="ir-dialog"><DialogHeader><DialogTitle>Yangi talabnoma · {location.name}</DialogTitle></DialogHeader>
      <form onSubmit={save} className="space-y-4">
        {error && <p className="ir-error" role="alert">{error}</p>}
        {pendingCreate && <p className="ir-warning">Oldingi yuborilgan ro‘yxat tekshirilmoqda. Javob aniqlanguncha uni o‘zgartirmang.</p>}
        <fieldset disabled={busy || Boolean(pendingCreate)} className="space-y-4">
          <div className="ir-form-grid"><label className="ir-field">Kerakli sana<Input type="date" required value={requiredDate} onChange={e => setRequiredDate(e.target.value)} /></label>
            <label className="ir-field">Qayerdan keladi?<OdinaSelect aria-label="Qayerdan keladi?" value={sourceKind} onChange={e => setSourceKind(e.target.value)}><option value="purchase">Xarid qilinadi</option><option value="warehouse">Markaziy ombordan</option></OdinaSelect></label></div>
          {sourceKind === 'warehouse' && <label className="ir-field">Jo‘natuvchi ombor<OdinaSelect aria-label="Jo‘natuvchi ombor" value={sourceLocation} onChange={e => setSourceLocation(e.target.value)}><option value="">Omborni tanlang</option>{catalog.warehouses.filter(shop => shop.id !== location.id).map(shop => <option key={shop.id} value={shop.id}>{shop.name}</option>)}</OdinaSelect></label>}
          <label className="ir-field">Mahsulotni qidiring<Input placeholder="Sut, shakar, stakan…" value={ingredientSearch} onChange={e => setIngredientSearch(e.target.value)} /></label>
          <div className="ir-results" aria-label="Tanlash mumkin bo‘lgan mahsulotlar">{available.map(item => <button type="button" key={item.id} disabled={draftItems.length >= 50} onClick={() => setDraftItems(previous => [...previous, { ingredient_id: item.id, quantity: '' }])}><span>{item.ingredient_name}</span><span className="ir-muted">{REQUISITION_UNITS[item.purchase_unit]} ＋</span></button>)}{available.length === 0 && <p className="p-3 ir-muted">Mahsulot topilmadi yoki ro‘yxatga qo‘shilgan.</p>}</div>
          {draftItems.length > 0 && <div className="ir-table-scroll"><table className="ir-data-table"><thead><tr><th>Mahsulot</th><th>Kerakli miqdor</th><th /></tr></thead><tbody>{draftItems.map(row => {
            const ingredient = ingredientMap.get(row.ingredient_id);
            return <tr key={row.ingredient_id}><td>{ingredient?.ingredient_name || row.ingredient_id}</td><td><div className="flex gap-2 items-center"><Input aria-label={`${ingredient?.ingredient_name}: kerakli miqdor`} type="number" min={ingredient?.base_unit === 'piece' ? 1 : 0.001} step={ingredient?.base_unit === 'piece' ? 1 : 0.001} max={1000000} required value={row.quantity} onChange={e => setDraftItems(previous => previous.map(item => item.ingredient_id === row.ingredient_id ? { ...item, quantity: e.target.value } : item))} /><span>{REQUISITION_UNITS[ingredient?.purchase_unit]}</span></div></td><td><Button type="button" variant="ghost" aria-label={`${ingredient?.ingredient_name}ni ro‘yxatdan olib tashlash`} onClick={() => setDraftItems(previous => previous.filter(item => item.ingredient_id !== row.ingredient_id))}><Trash2 className="w-4 h-4" /></Button></td></tr>;
          })}</tbody></table></div>}
          <label className="ir-field">Izoh<Textarea maxLength={1000} placeholder="Masalan: ertalab olib kelinsin" value={notes} onChange={e => setNotes(e.target.value)} /></label>
        </fieldset>
        <div className="ir-actions justify-end"><Button type="button" variant="outline" disabled={busy} onClick={() => setCreateOpen(false)}>Yopish</Button><Button type="submit" disabled={busy || (!pendingCreate && (!draftItems.length || (sourceKind === 'warehouse' && !sourceLocation)))}>{busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}{pendingCreate ? 'Saqlashni qayta tekshirish' : 'Talabnomani saqlash'}</Button></div>
      </form>
    </DialogContent></Dialog>

    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open && !busy) { setSelected(null); setError(''); } }}><DialogContent className="ir-dialog"><DialogHeader><DialogTitle>{selected?.request_number}</DialogTitle></DialogHeader>
      {selected && <div className="space-y-4"><p className="text-sm"><b>{selected.location_name}</b> · Kerakli sana: {selected.required_date.split('-').reverse().join('.')}<br /><span className="ir-muted">{selected.source_kind === 'purchase' ? 'Xarid qilinadi' : `${selected.source_location_name}dan keladi`}</span></p>
        {error && <p className="ir-error" role="alert">{error}</p>}{success && <p role="status" className="text-sm text-emerald-700">{success}</p>}
        {selected.pending_receipt && <div className="ir-warning"><b>Qabul hali yakunlanmagan.</b> Miqdorlarni yangidan kiritmang. Boshlangan amalni tekshirib davom ettiring.<div className="mt-2"><Button type="button" disabled={busy || !receivePermission} onClick={resume}>Qabulni davom ettirish</Button></div></div>}
        {pendingReceipt && !selected.pending_receipt && <div className="ir-warning">Oldingi qabulning javobi olinmagan.<div className="mt-2"><Button type="button" disabled={busy || !receivePermission} onClick={receive}>Qabulni qayta tekshirish</Button></div></div>}
        {selected.source_kind === 'warehouse' && !selected.approved_by && selected.status !== 'cancelled' && <div className="ir-warning">Markaziy ombor mas’uli shu talabni tasdiqlashi kerak. {selected.source_location_id === location.id && catalog.can_purchase_receive && <Button type="button" disabled={busy} onClick={() => approve(selected)}>Ombor nomidan tasdiqlash</Button>}</div>}
        {selected.approved_by && <p className="ir-muted">Ombor tasdig‘i: {selected.approved_by_name} · {formatUzbekistanDateTime(selected.approved_at)}</p>}
        {selected.cancellation_pending && <p className="ir-warning">Oldingi kirim bekor qilinmoqda. Qabul qilishdan oldin tugashini kuting.</p>}
        <div className="ir-table-scroll"><table className="ir-data-table"><thead><tr><th>Mahsulot</th><th>So‘ralgan</th><th>Qabul qilingan</th><th>Qolgan</th>{canReceiveNow && <><th>Hozir kelgan</th>{selected.source_kind === 'purchase' && <th>1 birlik narxi</th>}</>}</tr></thead><tbody>{selected.items.map(item => <tr key={item.ingredient_id}><td className="font-medium">{item.ingredient_name}<div className="ir-muted">{REQUISITION_UNITS[item.purchase_unit]}</div></td><td>{requisitionNumber(item.requested_quantity)}</td><td>{requisitionNumber(item.received_quantity)}</td><td>{requisitionNumber(item.remaining_quantity)}</td>{canReceiveNow && <><td><Input disabled={receivingLocked || item.remaining_quantity === 0} aria-label={`${item.ingredient_name}: kelgan miqdor`} type="number" min={0} max={item.remaining_quantity} step={item.base_unit === 'piece' ? 1 : 0.001} value={values[item.ingredient_id]?.quantity ?? ''} placeholder="0" onChange={e => setValues(previous => ({ ...previous, [item.ingredient_id]: { ...previous[item.ingredient_id], quantity: e.target.value } }))} /></td>{selected.source_kind === 'purchase' && <td><Input disabled={receivingLocked || item.remaining_quantity === 0} aria-label={`${item.ingredient_name}: birlik narxi`} type="number" min={0} max={1000000000} step={1} value={values[item.ingredient_id]?.unit_price ?? ''} placeholder="so‘m" onChange={e => setValues(previous => ({ ...previous, [item.ingredient_id]: { ...previous[item.ingredient_id], unit_price: e.target.value } }))} /></td>}</>}</tr>)}</tbody></table></div>
        {canReceiveNow && !selected.pending_receipt && <><Button type="button" variant="outline" disabled={receivingLocked} onClick={() => { setValues(previous => Object.fromEntries(selected.items.map(item => [item.ingredient_id, { ...previous[item.ingredient_id], quantity: item.remaining_quantity > 0 ? String(item.remaining_quantity) : '' }]))); setVerified(false); }}>Hammasi so‘ralgandek keldi</Button>
          {selected.source_kind === 'purchase' && <fieldset disabled={receivingLocked} className="space-y-3"><div className="ir-form-grid"><label className="ir-field">Yetkazib beruvchi<OdinaSelect aria-label="Yetkazib beruvchi" value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">Yetkazib beruvchini tanlang</option>{catalog.suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</OdinaSelect></label>
            <label className="ir-field">To‘lov holati<OdinaSelect aria-label="To‘lov holati" value={paymentState} onChange={e => setPaymentState(e.target.value)}><option value="unpaid">To‘lanmagan — qarzga</option><option value="paid_external">Oldin to‘langan</option></OdinaSelect></label></div>
            {!catalog.suppliers.length && <p className="ir-warning">Avval “Qabul qiluvchilar” bo‘limiga yetkazib beruvchini qo‘shing.</p>}
            <label className="ir-field">Xarid cheki / hisob raqami (ixtiyoriy)<Input maxLength={200} value={invoiceReference} onChange={e => setInvoiceReference(e.target.value)} /></label>
            <p className="ir-muted">Narxni har bir qatorda ko‘rsatilgan 1 kg, litr yoki dona uchun kiriting. “Oldin to‘langan” tanlovi kassadan yoki budjetdan yana pul yechmaydi.</p>
          </fieldset>}
          {selected.source_kind === 'purchase' && <div className="ir-summary"><span>Hozir qabul qilinadigan xarid</span><strong>{formatUZS(requisitionReceiptTotal(selected, values))}</strong></div>}
          <label className="ir-check-label"><input type="checkbox" disabled={receivingLocked} checked={verified} onChange={e => setVerified(e.target.checked)} /><span>Ha, kelgan miqdorlarni{selected.source_kind === 'purchase' ? ' va narxlarni' : ''} tekshirdim. Faqat kiritilgan miqdor omborga qabul qilinsin.</span></label>
          <Button type="button" disabled={receivingLocked || !verified || receiptInvalid || (selected.source_kind === 'purchase' && !supplierId)} onClick={receive}><CheckCircle2 className="w-4 h-4 mr-2" />Tekshirildi — kirim qilish</Button>
        </>}
        {destinationView && !receivePermission && <p className="ir-muted">Kirimni amaldagi ruxsatlar bo‘yicha boshqaruvchi yoki ombor mas’uli tasdiqlaydi.</p>}
        {selected.notes && <p className="text-sm"><b>Izoh:</b> {selected.notes}</p>}
        {selected.history.length > 0 && <div className="space-y-2"><h3 className="font-semibold text-sm">Qabul tarixi</h3>{selected.history.map(history => <div key={history.key} className="rounded-xl border border-border p-3 text-sm"><b>{history.cancelled ? 'Kirim bekor qilingan' : history.cancelling ? 'Kirim bekor qilinmoqda' : 'Qabul qilindi'}</b> · {history.actor_name}<div className="ir-muted">{formatUzbekistanDateTime(history.received_at)}</div><div>{history.items.map(item => { const ingredient = selected.items.find(row => row.ingredient_id === item.ingredient_id); return `${ingredient?.ingredient_name} ${requisitionNumber(item.quantity)} ${REQUISITION_UNITS[ingredient?.purchase_unit]}`; }).join(' · ')}</div>{history.total_amount !== undefined && selected.source_kind === 'purchase' && <div className="mt-1 font-medium">{formatUZS(history.total_amount)}</div>}</div>)}</div>}
        <div className="ir-actions pt-2"><Button type="button" variant="outline" disabled={Boolean(printing)} onClick={() => setPrinting(selected)}><Printer className="w-4 h-4 mr-2" />Chek chiqarish</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => execute(async () => { const result = await invoke({ action: 'get', request_id: selected.id }); upsert(result.request); })}>Holatini tekshirish</Button>
          {destinationView && catalog.can_create && !selected.pending_receipt && !['received', 'cancelled'].includes(selected.status) && <Button type="button" variant="ghost" disabled={busy || Boolean(pendingReceipt)} onClick={() => cancel(selected)}>Qolgan talabni bekor qilish</Button>}</div>
      </div>}
    </DialogContent></Dialog>

    <Dialog open={Boolean(preview)} onOpenChange={open => !open && setPreview(null)}><DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>80 mm chek ko‘rinishi</DialogTitle></DialogHeader>{preview && <><div className="ir-ticket-preview"><IngredientRequisitionTicketContent request={preview} /></div><Button type="button" disabled={Boolean(printing)} onClick={() => { setPrinting(preview); setPreview(null); }}><Printer className="w-4 h-4 mr-2" />Chek chiqarish</Button></>}</DialogContent></Dialog>
    <IngredientRequisitionTicket request={printing} onAfterPrint={() => setPrinting(null)} onWarning={setError} />
  </section>;
}
