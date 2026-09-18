import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';
import { AlertTriangle, Search, Star, Clock, Building2, Banknote, CloudOff, CloudUpload, RefreshCw, Armchair, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUZS } from '@/lib/pos';
import ProductCard from '@/components/pos/ProductCard';
import Cart from '@/components/pos/Cart';
import PaymentModal from '@/components/pos/PaymentModal';
import Receipt from '@/components/pos/Receipt';
import { OpenShiftDialog, CloseShiftDialog } from '@/components/pos/ShiftDialog';
import { OwnerPinDialog, CashWithdrawalDialog } from '@/components/pos/KassaActionDialogs';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import useOfflineSaleQueue from '@/hooks/useOfflineSaleQueue';
import {
  buildPendingSale,
  createSaleIdempotencyKey,
  isRetryableSyncError,
  syncErrorMessage,
} from '@/lib/offline-sales';

// Load the larger floor-plan component only when the cashier opens its picker.
const TableFloorplan = React.lazy(() => import('@/components/tables/TableFloorplan'));

export default function POS() {
  const { user, sidebarCollapsed, screenMode } = useOutletContext();
  const navigate = useNavigate();
  const location = useLocation();
  const tableQuery = useMemo(() => {
    const query = new URLSearchParams(location.search);
    const shopId = query.get('table_shop');
    const rawNumber = query.get('table_number');
    if (!shopId && !rawNumber) return { selected: null, invalid: false };
    if (!shopId || !/^[1-9]\d*$/.test(rawNumber || '')) return { selected: null, invalid: true };
    const number = Number(rawNumber);
    if (!Number.isInteger(number) || number > 30) return { selected: null, invalid: true };
    return { selected: { shopId, number }, invalid: false };
  }, [location.search]);
  const selectedTable = screenMode ? null : tableQuery.selected;
  const tableKey = selectedTable ? `${selectedTable.shopId}:${selectedTable.number}` : '';
  const priorTableKey = useRef(tableKey);

  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [productStock, setProductStock] = useState([]);
  const [activeCat, setActiveCat] = useState('all');
  const [search, setSearch] = useState('');
  const [showFav, setShowFav] = useState(false);
  const [cart, setCart] = useState([]);
  const [shops, setShops] = useState([]);
  const [shift, setShift] = useState(null);
  const [settings, setSettings] = useState(null);
  const [cashRecipients, setCashRecipients] = useState([]);
  const [supplierDebts, setSupplierDebts] = useState({});
  const [loadingData, setLoadingData] = useState(true);
  const [stockChecking, setStockChecking] = useState(false);
  const [wasteAlerts, setWasteAlerts] = useState([]);

  const [discountCode, setDiscountCode] = useState('');
  const [discountPct, setDiscountPct] = useState(0);
  const [discountError, setDiscountError] = useState('');
  const [discountOwnerPin, setDiscountOwnerPin] = useState('');
  const [roundingTarget, setRoundingTarget] = useState(null);
  const [adjustmentMode, setAdjustmentMode] = useState(null);
  const [roundingError, setRoundingError] = useState('');

  const [payOpen, setPayOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [checkoutOffline, setCheckoutOffline] = useState(false);
  const checkoutRequestKeyRef = useRef('');
  const checkoutRecordedAtRef = useRef('');
  const [lastSale, setLastSale] = useState(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const [openShiftOpen, setOpenShiftOpen] = useState(false);
  const [closeShiftOpen, setCloseShiftOpen] = useState(false);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [discountApprovalOpen, setDiscountApprovalOpen] = useState(false);
  const [pendingDiscountCode, setPendingDiscountCode] = useState('');
  const [discountLoading, setDiscountLoading] = useState(false);
  const [cashWithdrawalOpen, setCashWithdrawalOpen] = useState(false);
  const [cashWithdrawalLoading, setCashWithdrawalLoading] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [tablePickerLoading, setTablePickerLoading] = useState(false);
  const [tablePickerError, setTablePickerError] = useState('');
  const [tablePickerShops, setTablePickerShops] = useState([]);
  const [tablePickerShopId, setTablePickerShopId] = useState('');
  const [tableOrder, setTableOrder] = useState(null);
  const [tableOrderLoading, setTableOrderLoading] = useState(false);
  const [tableOrderError, setTableOrderError] = useState('');
  const [tableSaveError, setTableSaveError] = useState('');
  const [savingTable, setSavingTable] = useState(false);
  const savingTableRef = useRef(false);
  const [tableReload, setTableReload] = useState(0);

  // Do not accidentally carry an unsaved cart from one table to another when
  // only the URL changes and React keeps the POS component mounted.
  useEffect(() => {
    if (priorTableKey.current === tableKey) return;
    priorTableKey.current = tableKey;
    setCart([]);
    setDiscountCode('');
    setDiscountPct(0);
    setDiscountOwnerPin('');
    setRoundingTarget(null);
    setAdjustmentMode(null);
    setPayOpen(false);
    setMobileCartOpen(false);
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
  }, [tableKey]);

  // The server owns every open order. Reloading or switching devices restores
  // the exact unpaid items; nothing is recorded as revenue at this point.
  useEffect(() => {
    if (!selectedTable) {
      setTableOrder(null);
      setTableOrderLoading(false);
      setTableOrderError('');
      setTableSaveError('');
      return undefined;
    }
    let active = true;
    setTableOrderLoading(true);
    setTableOrderError('');
    setTableSaveError('');
    base44.functions.invoke('restaurant-tables', {
      action: 'get_table_order', shop_id: selectedTable.shopId, table_number: selectedTable.number,
    }).then((response) => {
      if (!active) return;
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Stol buyurtmasi yuklanmadi.');
      setTableOrder(result.order || null);
      setCart(result.order?.items || []);
      setDiscountCode(''); setDiscountPct(0); setDiscountOwnerPin('');
      setRoundingTarget(null); setAdjustmentMode(null);
    }).catch((error) => {
      if (active) setTableOrderError(error?.response?.data?.error || error?.data?.error || error?.message || 'Buyurtmani yuklab bo‘lmadi.');
    }).finally(() => { if (active) setTableOrderLoading(false); });
    return () => { active = false; };
  }, [tableKey, tableReload]);

  const tableCartDirty = Boolean(selectedTable) && (
    cart.length !== (tableOrder?.items?.length || 0)
    || cart.some((row) => {
      const saved = tableOrder?.items?.find((item) => item.product_id === row.product_id);
      return !saved || saved.quantity !== row.quantity || saved.price !== row.price;
    })
  );
  const tableLocked = Boolean(selectedTable) && (tableOrderLoading || savingTable
    || Boolean(tableOrderError) || tableOrder?.state === 'paying');
  const saveTableOrder = async () => {
    if (!selectedTable || !tableCartDirty) return !selectedTable || Boolean(tableOrder?.id);
    if (savingTableRef.current || tableOrderLoading || tableOrderError || tableOrder?.state === 'paying') return false;
    if (!shift || shift.shop_id !== selectedTable.shopId) {
      void odinaAlert('Buyurtmani saqlash uchun shu do‘kondagi smenani oching.');
      return false;
    }
    if (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      void odinaAlert('Stol buyurtmasi serverda saqlanadi. Internet aloqasini kuting; savatingiz o‘chmaydi.');
      return false;
    }
    if (!cart.length) {
      void odinaAlert('Ochiq buyurtmadagi hamma mahsulotni tozalash mumkin emas. Hisobni yopish yoki mas’ulga murojaat qiling.');
      return false;
    }
    savingTableRef.current = true;
    setSavingTable(true);
    setTableSaveError('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'save_table_order', shop_id: selectedTable.shopId,
        table_number: selectedTable.number, shift_id: shift.id,
        expected_revision: tableOrder?.revision || 0,
        items: cart.map((row) => ({ product_id: row.product_id, quantity: row.quantity })),
      });
      const result = response?.data || response;
      if (!result?.ok || !result.order?.id) throw new Error(result?.error || 'Buyurtma saqlangani tasdiqlanmadi.');
      setTableOrder(result.order);
      setCart(result.order.items);
      return true;
    } catch (error) {
      const message = error?.response?.data?.error || error?.data?.error || error?.message || 'Stol buyurtmasi saqlanmadi.';
      setTableSaveError(message);
      return false;
    } finally {
      savingTableRef.current = false;
      setSavingTable(false);
    }
  };

  const loadAll = async () => {
    setLoadingData(true);
    const [cats, prods, shopList, settingsList, shifts, recipientList, supplierReceipts, stockList, wasteAlertResult] = await Promise.all([
      base44.entities.Category.list(),
      base44.entities.Product.list(),
      base44.entities.Shop.list(),
      base44.entities.Settings.list(),
      base44.entities.Shift.list(),
      base44.entities.CashRecipient.list('name', 500),
      base44.functions.invoke('supplier-ledger', { action: 'get_debts' }).catch(() => ({ data: { debts: {} } })),
      base44.entities.ProductStock.list('-updated_at', 500),
      base44.functions.invoke('waste-ledger', { action: 'get_alerts' }).catch(() => ({ data: { expired_items: [] } })),
    ]);
    setCategories((cats || []).filter((c) => c.active));
    setProducts((prods || []).filter((p) => p.active && p.archived !== true));
    setProductStock(stockList || []);
    setShops((shopList || []).filter((shop) => shop.active !== false && shop.allows_pos !== false));
    setSettings(settingsList?.[0] || null);
    setCashRecipients((recipientList || []).filter((recipient) => recipient.active !== false));
    const debtPayload = supplierReceipts?.data || supplierReceipts;
    setSupplierDebts(debtPayload?.debts || {});
    const wastePayload = wasteAlertResult?.data || wasteAlertResult;
    setWasteAlerts(wastePayload?.expired_items || []);
    const myOpen = (shifts || []).find((s) => s.user_id === user?.id && s.status === 'open');
    setShift(myOpen || null);
    setLoadingData(false);
  };

  const {
    isOnline,
    records: offlineSales,
    syncing: offlineSyncing,
    storageError: offlineStorageError,
    syncError: offlineSyncError,
    enqueue: enqueueOfflineSale,
    syncNow: syncOfflineSales,
  } = useOfflineSaleQueue(user?.id, () => loadAll().catch(() => {}));

  useEffect(() => {
    if (user) loadAll().catch(() => setLoadingData(false));
  }, [user]);

  useEffect(() => {
    if (!user) return undefined;

    const unsubscribe = base44.entities.ProductStock.subscribe((event) => {
      const recordId = event?.data?.id || event?.id;
      if (!recordId) return;

      setProductStock((current) => {
        if (event.type === 'delete') {
          return current.filter((stock) => stock.id !== recordId);
        }

        const existing = current.find((stock) => stock.id === recordId);
        const nextRecord = { ...(existing || {}), ...(event.data || {}), id: recordId };
        return existing
          ? current.map((stock) => stock.id === recordId ? nextRecord : stock)
          : [nextRecord, ...current];
      });
    });

    return () => unsubscribe?.();
  }, [user?.id]);

  // The POS table picker uses the same server-scoped map as the Stollar page.
  // The backend limits cashiers to their assigned shop; an open shift further
  // restricts the picker to its shop. This is read-only until a table is tapped.
  const openTablePicker = async () => {
    if (screenMode) return;
    setTablePickerOpen(true);
    setTablePickerLoading(true);
    setTablePickerError('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', { action: 'status' });
      const result = response?.data || response;
      if (!Array.isArray(result?.shops)) throw new Error('Stollar javobi noto‘g‘ri.');
      const available = shift
        ? result.shops.filter((shop) => shop.id === shift.shop_id)
        : result.shops;
      setTablePickerShops(available);
      setTablePickerShopId((previous) => available.some((shop) => shop.id === previous) ? previous
        : available.some((shop) => shop.id === selectedTable?.shopId) ? selectedTable.shopId
          : available[0]?.id || '');
      if (!available.length) setTablePickerError('Bu smena do‘koni uchun stollar topilmadi. Do‘kon biriktirilishini tekshiring.');
    } catch (error) {
      setTablePickerShops([]);
      setTablePickerShopId('');
      setTablePickerError(error?.response?.data?.error || error?.data?.error || error?.message || 'Stollar xaritasini yuklab bo‘lmadi.');
    } finally {
      setTablePickerLoading(false);
    }
  };
  const chooseTableInPos = async (shopId, number) => {
    if (tablePickerLoading || (selectedTable?.shopId === shopId && selectedTable?.number === number)) {
      setTablePickerOpen(false);
      return;
    }
    if (shift && shift.shop_id !== shopId) {
      void odinaAlert('Bu stol joriy smenaning do‘koniga tegishli emas.');
      return;
    }
    if (selectedTable && tableOrderLoading) return;
    if (selectedTable && tableCartDirty && !(await saveTableOrder())) return;
    if (!selectedTable && cart.length && !(await odinaConfirm({
      title: 'Oddiy savat saqlanmagan',
      description: 'Stolga o‘tsangiz oddiy savat o‘chadi. Avval uning savdosini yakunlang yoki tasdiqlang.',
      confirmLabel: 'Stolga o‘tish', tone: 'warning',
    }))) return;
    setTablePickerOpen(false);
    navigate(`/pos?${new URLSearchParams({ table_shop: shopId, table_number: String(number) })}`);
  };
  const tablePickerShop = tablePickerShops.find((shop) => shop.id === tablePickerShopId);

  const tableShop = selectedTable ? shops.find((shop) => shop.id === selectedTable.shopId) : null;
  const tableSelectionError = tableQuery.invalid && !screenMode
    ? 'Stol havolasi noto‘g‘ri. Xaritadan qayta tanlang.'
    : selectedTable && !loadingData && (!tableShop
      || !Number.isInteger(tableShop.restaurant_table_count)
      || selectedTable.number > tableShop.restaurant_table_count)
      ? 'Tanlangan stol bu do‘konda mavjud emas. Xaritani yangilang.'
      : selectedTable && shift && shift.shop_id !== selectedTable.shopId
        ? 'Faol smena boshqa do‘konga tegishli. To‘g‘ri smenani tanlang.'
        : '';

  const subtotal = useMemo(() => cart.reduce((s, i) => s + i.subtotal, 0), [cart]);
  const couponDiscount = useMemo(() => Math.round(subtotal * discountPct / 100), [subtotal, discountPct]);
  const roundingDiscount = roundingTarget !== null && !discountCode ? subtotal - roundingTarget : 0;
  const discount = couponDiscount + roundingDiscount;
  const total = Math.max(0, subtotal - discount);

  // A rounding decision never carries over when products or quantities change.
  useEffect(() => { setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); }, [cart]);

  const applyAdjustment = (target, mode) => {
    const reduction = subtotal - target;
    if (discountCode) { setRoundingError('Kupon bilan birga qo‘llab bo‘lmaydi.'); return false; }
    if (!Number.isSafeInteger(target) || target <= 0 || !Number.isSafeInteger(subtotal)
      || reduction <= 0 || (mode === 'rounding' && reduction > Math.min(5000, Math.floor(subtotal * 0.1)))) {
      setRoundingError(mode === 'manual'
        ? 'Chegirma musbat bo‘lsin va yakuniy summa kamida 1 so‘m qolsin.'
        : 'Yaxlitlash 5 000 so‘m yoki 10% limitidan oshmasin.');
      return false;
    }
    setRoundingTarget(target);
    setAdjustmentMode(mode);
    setRoundingError('');
    return true;
  };

  const applyManualDiscount = (input) => {
    // Accept both 2000 and -2000 as a deduction; never change the product price.
    const raw = String(input).trim();
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      setRoundingError('Masalan, 2000 yoki -2000 ko‘rinishida kiriting.');
      return false;
    }
    return applyAdjustment(subtotal - Math.abs(Number(raw)), 'manual');
  };

  const applyRounding = () => {
    const step = subtotal >= 10000 ? 5000 : subtotal >= 1000 ? 1000 : 100;
    return applyAdjustment(Math.floor(subtotal / step) * step, 'rounding');
  };

  const addToCart = (product) => {
    if (tableLocked || paying) return;
    setCart((prev) => {
      const existing = prev.find((i) => i.product_id === product.id);
      if (existing) {
        return prev.map((i) => i.product_id === product.id ? { ...i, quantity: i.quantity + 1, subtotal: i.subtotal + i.price } : i);
      }
      return [...prev, { product_id: product.id, product_name: product.name, image_url: product.image_url, price: product.price, quantity: 1, subtotal: product.price }];
    });
  };

  const inc = (item) => { if (!tableLocked && !paying) setCart((p) => p.map((i) => i.product_id === item.product_id ? { ...i, quantity: i.quantity + 1, subtotal: i.subtotal + i.price } : i)); };
  const dec = (item) => { if (tableLocked || paying) return; setCart((p) => p.flatMap((i) => {
    if (i.product_id !== item.product_id) return [i];
    const q = i.quantity - 1;
    return q <= 0 ? [] : [{ ...i, quantity: q, subtotal: q * i.price }];
  })); };
  const removeItem = (item) => { if (!tableLocked && !paying) setCart((p) => p.filter((i) => i.product_id !== item.product_id)); };
  const resetCart = () => { setCart([]); setDiscountCode(''); setDiscountPct(0); setDiscountError(''); setDiscountOwnerPin(''); setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); };
  const clearCart = () => { if (!tableLocked && !paying && (!selectedTable || !tableOrder)) resetCart(); }; 

  const validateDiscount = async (code, ownerPin = '') => {
    setDiscountLoading(true);
    try {
      const result = await base44.functions.invoke('complete-sale', {
        action: 'validate_discount',
        code,
        owner_pin: ownerPin || undefined,
      });
      const dc = result?.data || result;
      if (!dc?.code) throw new Error(dc?.error || 'Kod noto‘g‘ri yoki faol emas.');
      const percentage = Number(dc.percentage);
      setDiscountPct(percentage);
      setDiscountCode(dc.code);
      setRoundingTarget(null);
      setAdjustmentMode(null);
      setRoundingError('');
      setDiscountOwnerPin(user?.role === 'cashier' && percentage === 100 ? ownerPin : '');
      setDiscountError('');
      setDiscountApprovalOpen(false);
      setPendingDiscountCode('');
    } catch (e) {
      const errorPayload = e?.response?.data || e?.data || {};
      if (errorPayload.requires_owner_pin && !ownerPin) {
        setPendingDiscountCode(code);
        setDiscountApprovalOpen(true);
        setDiscountError('');
      } else {
        setDiscountError(errorPayload.error || e?.message || 'Kodni tekshirib bo‘lmadi.');
        setDiscountApprovalOpen(false);
        setPendingDiscountCode('');
        setDiscountOwnerPin('');
      }
    } finally {
      setDiscountLoading(false);
    }
  };

  const applyDiscount = (code) => {
    const normalized = code?.trim().toUpperCase();
    if (!normalized) return;
    validateDiscount(normalized);
  };

  const removeDiscount = () => {
    setDiscountCode('');
    setDiscountPct(0);
    setDiscountError('');
    setDiscountOwnerPin('');
    setPendingDiscountCode('');
  };

  const filtered = useMemo(() => {
    let list = products;
    if (activeCat !== 'all') list = list.filter((p) => p.category_id === activeCat);
    if (showFav) list = list.filter((p) => p.is_favorite);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [products, activeCat, showFav, search]);

  const queuedForCurrentShift = useMemo(
    () => offlineSales.filter((record) => record.shift_id === shift?.id),
    [offlineSales, shift?.id],
  );
  const queuedShiftTotal = useMemo(
    () => queuedForCurrentShift.reduce((sum, record) => sum + Number(record.local_sale?.total || 0), 0),
    [queuedForCurrentShift],
  );
  const queuedQuantityByProduct = useMemo(() => {
    const quantities = {};
    for (const record of queuedForCurrentShift) {
      for (const item of record.request?.items || []) {
        quantities[item.product_id] = Number(quantities[item.product_id] || 0) + Number(item.quantity || 0);
      }
    }
    return quantities;
  }, [queuedForCurrentShift]);
  const productsById = useMemo(
    () => Object.fromEntries(products.map((product) => [product.id, product])),
    [products],
  );

  const stockByProduct = useMemo(() => {
    const locationId = shift?.shop_id || user?.shop_id;
    if (!locationId) return {};

    const quantities = Object.fromEntries(
      productStock
        .filter((stock) => stock.location_id === locationId)
        .map((stock) => [stock.product_id, Number(stock.quantity || 0)]),
    );
    for (const [productId, queuedQuantity] of Object.entries(queuedQuantityByProduct)) {
      quantities[productId] = Number(quantities[productId] || 0) - Number(queuedQuantity || 0);
    }
    return quantities;
  }, [productStock, queuedQuantityByProduct, shift?.shop_id, user?.shop_id]);

  const confirmStockWarnings = async (shortages, allowNegativeStock) => {
    if (!shortages.length) return true;
    const details = shortages
      .map((item) => `${item.product_name}: ${item.requested} ta kerak, ${item.available} ta mavjud`)
      .join('\n');
    if (allowNegativeStock === false) {
      await odinaAlert('Savdoni davom ettirish mumkin emas.', {
        title: 'Qoldiq yetarli emas',
        details,
        tone: 'danger',
      });
      return false;
    }
    return odinaConfirm(
      'Savdodan keyin ayrim mahsulotlar qoldig‘i minus bo‘ladi.',
      {
        title: 'Qoldiq yetarli emas',
        details,
        tone: 'warning',
        confirmLabel: 'Baribir sotish',
      },
    );
  };

  const openPayment = (offline) => {
    checkoutRequestKeyRef.current = createSaleIdempotencyKey();
    checkoutRecordedAtRef.current = new Date().toISOString();
    setCheckoutOffline(offline);
    setPayOpen(true);
  };

  const openOfflinePayment = async () => {
    if (selectedTable) {
      await odinaAlert('Stolga bog‘langan savdo faqat internet orqali yakunlanadi. Savat saqlanib turadi.');
      return false;
    }
    if (discountCode || roundingTarget !== null) {
      await odinaAlert('Chegirmali savdoni tekshirish uchun internet kerak. Savat saqlanib turadi.', {
        title: 'Internet kerak',
        tone: 'warning',
      });
      return false;
    }

    const shortages = cart
      .filter((item) => productsById[item.product_id]?.track_stock !== false)
      .map((item) => ({
        product_id: item.product_id,
        product_name: item.product_name,
        requested: Number(item.quantity || 0),
        available: Number(stockByProduct[item.product_id] ?? 0),
      }))
      .filter((item) => item.requested > item.available);

    const accepted = await confirmStockWarnings(shortages, settings?.allow_negative_stock !== false);
    if (!accepted) return false;
    openPayment(true);
    return true;
  };

  const openCheckout = async () => {
    if (tableSelectionError || (selectedTable && (!tableShop || (shift && shift.shop_id !== selectedTable.shopId)))) {
      await odinaAlert(tableSelectionError || 'Stol uchun do‘kon va smenani tekshiring.');
      return;
    }
    if (selectedTable && (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false))) {
      await odinaAlert('Stol savdosini internet qaytmaguncha yakunlab bo‘lmaydi. Savat saqlanib turadi.');
      return;
    }
    if (!shift) {
      if (!isOnline) {
        void odinaAlert('Smenani ochish uchun internet kerak.');
      } else {
        setOpenShiftOpen(true);
      }
      return;
    }
    if (!cart.length || stockChecking || offlineSyncing || tableLocked) return;
    if (selectedTable && (tableCartDirty || !tableOrder?.id) && !(await saveTableOrder())) return;

    setStockChecking(true);
    try {
      if (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        await openOfflinePayment();
        return;
      }

      if (offlineSales.length) {
        const syncResult = await syncOfflineSales();
        if (syncResult?.remaining > 0) {
          await odinaAlert('Avval qurilmada qolgan savdolarni serverga yuborish kerak.', {
            title: 'Sinxronlash tugamadi',
            details: syncResult?.failed?.message || offlineSyncError || '',
            tone: 'warning',
          });
          return;
        }
      }

      const result = await base44.functions.invoke('complete-sale', {
        action: 'check_stock',
        shift_id: shift.id,
        items: cart.map((item) => ({ product_id: item.product_id, quantity: item.quantity })),
      });
      const payload = result?.data || result;
      const accepted = await confirmStockWarnings(
        payload?.shortages || [],
        payload?.allow_negative_stock,
      );
      if (accepted) openPayment(false);
    } catch (error) {
      if (isRetryableSyncError(error) && !selectedTable) {
        await openOfflinePayment();
        return;
      }
      const payload = error?.response?.data || error?.data || {};
      const details = (payload.shortages || [])
        .map((item) => `${item.product_name}: ${item.available} ta mavjud`)
        .join('\n');
      void odinaAlert((payload.error || error?.message || 'Qoldiqni tekshirib bo‘lmadi.') + (details ? '\n\n' + details : ''));
    } finally {
      setStockChecking(false);
    }
  };

  const closePayment = () => {
    if (paying) return;
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
    setCheckoutOffline(false);
    setPayOpen(false);
  };

  const finishQueuedSale = (record) => {
    setLastSale(record.local_sale);
    setPayOpen(false);
    setReceiptOpen(true);
    setCheckoutOffline(false);
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
    resetCart();
  };

  const applyCompletedSale = (payload) => {
    setLastSale(payload.sale);
    if (payload.shift) setShift(payload.shift);
    if (payload.stock_updates?.length) {
      const updatedByProduct = Object.fromEntries(payload.stock_updates.map((item) => [item.product_id, item.quantity]));
      const saleShopId = payload.sale?.shop_id || shift.shop_id;
      setProductStock((current) => {
        const existingIds = new Set(current.map((stock) => `${stock.location_id}:${stock.product_id}`));
        const changed = current.map((stock) => (
          stock.location_id === saleShopId && Object.prototype.hasOwnProperty.call(updatedByProduct, stock.product_id)
            ? { ...stock, quantity: updatedByProduct[stock.product_id] }
            : stock
        ));
        for (const item of payload.stock_updates) {
          const key = `${saleShopId}:${item.product_id}`;
          if (!existingIds.has(key)) {
            changed.push({ location_id: saleShopId, product_id: item.product_id, quantity: item.quantity });
          }
        }
        return changed;
      });
    }
    setPayOpen(false);
    setReceiptOpen(true);
    setCheckoutOffline(false);
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
    resetCart();
    setTableOrder(null);
    base44.functions.invoke('waste-ledger', { action: 'get_alerts' })
      .then((result) => setWasteAlerts((result?.data || result)?.expired_items || []))
      .catch(() => {});
  };

  const completeSale = async (payments) => {
    setPaying(true);
    const idempotencyKey = checkoutRequestKeyRef.current || createSaleIdempotencyKey();
    checkoutRequestKeyRef.current = idempotencyKey;
    const recordedAt = checkoutRecordedAtRef.current || new Date().toISOString();
    checkoutRecordedAtRef.current = recordedAt;
    let pendingRecord = null;

    try {
      if (selectedTable && (tableCartDirty || !tableOrder?.id || tableOrder.state !== 'occupied')) {
        throw new Error('Buyurtma serverda saqlanganini tekshiring. To‘lovni qayta oching.');
      }
      if (!selectedTable && !discountCode && roundingTarget === null) {
        pendingRecord = buildPendingSale({
          idempotencyKey,
          recordedAt,
          shift,
          user,
          shop: shops.find((shop) => shop.id === shift.shop_id),
          cart,
          payments,
        });
      }

      if (checkoutOffline || !isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        if (selectedTable) throw new Error('Stol savdosini internet orqali tasdiqlash kerak. Savat saqlanib turadi.');
        if (!pendingRecord) {
          throw new Error('Chegirmali savdoni offline saqlab bo‘lmaydi. Internetni kuting.');
        }
        await enqueueOfflineSale(pendingRecord);
        finishQueuedSale(pendingRecord);
        return;
      }

      const request = pendingRecord?.request || {
        action: 'complete_sale',
        shift_id: shift.id,
        ...(selectedTable ? { table_shop_id: selectedTable.shopId, table_number: selectedTable.number,
          table_order_id: tableOrder?.id, table_order_revision: tableOrder?.revision } : {}),
        items: cart.map((item) => ({
          product_id: item.product_id,
          quantity: item.quantity,
        })),
        discount_code: discountCode || undefined,
        rounding_total: adjustmentMode === 'rounding' ? roundingTarget : undefined,
        manual_discount_amount: adjustmentMode === 'manual' ? subtotal - roundingTarget : undefined,
        owner_pin: discountPct === 100 && discountOwnerPin ? discountOwnerPin : undefined,
        payments,
        idempotency_key: idempotencyKey,
        recorded_at: recordedAt,
      };

      try {
        const result = await base44.functions.invoke('complete-sale', request);
        const payload = result?.data || result;
        if (!payload?.sale) throw new Error(payload?.error || 'Savdoni yakunlab bo‘lmadi.');
        applyCompletedSale(payload);
      } catch (error) {
        if (!pendingRecord || !isRetryableSyncError(error)) throw error;
        await enqueueOfflineSale(pendingRecord);
        finishQueuedSale(pendingRecord);
      }
    } catch (error) {
      const message = syncErrorMessage(error);
      const discountHint = (discountCode || roundingTarget !== null || selectedTable) && isRetryableSyncError(error)
        ? ' Natija noaniq bo‘lishi mumkin. To‘lov oynasini yopmang; aloqa qaytgach shu tugmani yana bosing. Avval Savdolar tarixini ham tekshiring.'
        : '';
      void odinaAlert(`Savdoni yakunlab bo‘lmadi: ${message}${discountHint}`);
    } finally {
      setPaying(false);
    }
  };

  const openShift = async ({ shop, starting_cash }) => {
    if (selectedTable && shop?.id !== selectedTable.shopId) {
      void odinaAlert('Stol boshqa do‘konga tegishli. Stolning do‘konida smena oching.');
      return;
    }
    if (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      void odinaAlert('Smenani ochish uchun internet kerak.');
      return;
    }
    setShiftLoading(true);
    try {
      const result = await base44.functions.invoke('complete-sale', {
        action: 'open_shift',
        shop_id: shop?.id,
        starting_cash,
      });
      const payload = result?.data || result;
      if (!payload?.shift) throw new Error(payload?.error || 'Smenani ochib bo‘lmadi.');
      setShift(payload.shift);
      setOpenShiftOpen(false);
    } catch (e) { void odinaAlert('Smenani ochib bo‘lmadi: ' + (e?.message || e)); }
    finally { setShiftLoading(false); }
  };

  const requestCloseShift = async () => {
    if (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      await odinaAlert('Smenani yopishdan oldin internetga ulaning.', {
        title: 'Internet kerak',
        tone: 'warning',
      });
      return;
    }
    if (queuedForCurrentShift.length) {
      const result = await syncOfflineSales();
      if (result?.remaining > 0) {
        await odinaAlert('Qurilmadagi barcha savdolar serverga yuborilmaguncha smenani yopib bo‘lmaydi.', {
          title: 'Navbatdagi savdolar bor',
          details: result?.failed?.message || offlineSyncError || '',
          tone: 'warning',
        });
        return;
      }
    }
    setCloseShiftOpen(true);
  };

  const closeShift = async ({ actual_cash, budget_cash_submitted, cash_left_for_next_shift }) => {
    if (!isOnline || offlineSales.some((record) => record.shift_id === shift?.id)) {
      void odinaAlert('Smenani yopishdan oldin offline savdolarni serverga yuboring.');
      return;
    }
    setShiftLoading(true);
    try {
      const result = await base44.functions.invoke('shift-close-v2', {
        action: 'close_shift',
        shift_id: shift.id,
        actual_cash,
        budget_cash_submitted,
        cash_left_for_next_shift,
      });
      const payload = result?.data || result;
      if (!payload?.shift) throw new Error(payload?.error || 'Smenani yopib bo‘lmadi.');
      window.print();
      setShift(null);
      setCloseShiftOpen(false);
    } catch (e) {
      void odinaAlert('Smenani yopib bo‘lmadi: ' + (e?.response?.data?.error || e?.data?.error || e?.message || e));
    } finally { setShiftLoading(false); }
  };

  const recordCashWithdrawal = async ({ amount, reason, expense_category, recipient_id, recipient_name, owner_pin }) => {
    if (!shift) return;
    if (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      void odinaAlert('Kassadan pul olishni saqlash uchun internet kerak.');
      return;
    }
    setCashWithdrawalLoading(true);
    try {
      const isDebtPayment = expense_category === 'goods_payment';
      const result = await base44.functions.invoke(isDebtPayment ? 'supplier-ledger' : 'complete-sale', isDebtPayment ? {
        action: 'pay_debt',
        shift_id: shift.id,
        supplier_id: recipient_id,
        amount,
        notes: reason,
        owner_pin,
      } : {
        action: 'cash_withdrawal',
        shift_id: shift.id,
        amount,
        reason,
        expense_category,
        recipient_id,
        recipient_name,
      });
      const payload = result?.data || result;
      if (!payload?.shift) throw new Error(payload?.error || 'Pul olishni saqlab bo‘lmadi.');
      setShift(payload.shift);
      if (expense_category === 'goods_payment') {
        setSupplierDebts((current) => ({
          ...current,
          [recipient_id]: Math.max(0, Number(current[recipient_id] || 0) - Number(amount || 0)),
        }));
      }
      setCashWithdrawalOpen(false);
    } catch (e) {
      void odinaAlert('Pul olish amalga oshmadi: ' + (e?.response?.data?.error || e?.data?.error || e?.message || e));
    } finally {
      setCashWithdrawalLoading(false);
    }
  };

  return (
    <div className={`odina-pos flex flex-col w-full max-w-full ${screenMode ? 'h-dvh' : 'h-[calc(100dvh-3.5rem)] lg:h-dvh'} bg-background overflow-x-hidden`}>
      {/* Header */}
      <div className="odina-pos-header flex shrink-0 items-center gap-2 sm:gap-3 px-3 sm:px-6 py-2.5 sm:py-3 border-b border-border bg-card/95 backdrop-blur sticky top-0 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="odina-store-icon w-9 h-9 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center shrink-0">
            <Building2 className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{shift?.shop_name || 'Faol smena yo‘q'}</div>
            <div className="text-xs text-muted-foreground truncate">
              {shift ? `${formatUZS(Number(shift.total_sales || 0) + queuedShiftTotal)} · ${Number(shift.order_count || 0) + queuedForCurrentShift.length} ta buyurtma` : 'Savdoni boshlash uchun smenani oching'}
            </div>
          </div>
        </div>
        <div className="flex-1" />
        {!screenMode && <Button type="button" variant="outline" size="sm" onClick={() => void openTablePicker()}
          aria-label="Stollar xaritasini Kassa ichida ochish"
          className="hidden xl:inline-flex h-11 shrink-0 rounded-xl border-brand-olive/50 bg-brand-olive/10 px-3 font-semibold text-brand-ink hover:bg-brand-olive/20 touch-manipulation">
          <Armchair className="h-4 w-4 sm:mr-1.5" /> <span>Stollar</span>
        </Button>}
        {shift ? (
          <>
            <div className="hidden sm:flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">
              <Clock className="w-3.5 h-3.5" /> Smena ochiq
            </div>
            <Button variant="outline" size="sm" aria-label="Kassadan pul olish" onClick={() => setCashWithdrawalOpen(true)} className="h-10 px-3 touch-manipulation">
              <Banknote className="w-4 h-4 sm:mr-1.5" /> <span className="hidden sm:inline">Pul olish</span>
            </Button>
            <Button variant="outline" size="sm" aria-label="Smenani yopish" onClick={requestCloseShift} disabled={offlineSyncing} className="h-10 px-3 touch-manipulation">
              <Clock className="w-4 h-4 sm:mr-1.5" /> <span className="hidden sm:inline">Smenani yopish</span><span className="sm:hidden">Yopish</span>
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setOpenShiftOpen(true)} className="h-10 bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            Smenani ochish
          </Button>
        )}
      </div>

      {!screenMode && <div className="xl:hidden shrink-0 border-b border-brand-olive/20 bg-brand-olive/5 px-3 py-2 sm:px-5">
        <Button type="button" variant="outline" onClick={() => void openTablePicker()}
          aria-label="Stollar xaritasini Kassa ichida ochish"
          className="w-full min-h-11 rounded-xl border-brand-olive/50 bg-card font-semibold text-brand-ink touch-manipulation">
          <Armchair className="h-4 w-4 mr-2" /> Stollar xaritasini ochish
        </Button>
      </div>}

      <OfflineSalesBanner
        isOnline={isOnline}
        records={offlineSales}
        syncing={offlineSyncing}
        storageError={offlineStorageError}
        syncError={offlineSyncError}
        onRetry={syncOfflineSales}
      />

      {!screenMode && (selectedTable || tableQuery.invalid) && (
        <div className="mx-3 sm:mx-5 mt-3 shrink-0 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-brand-olive/40 bg-brand-olive/10 p-3 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <Armchair className="w-5 h-5 text-brand-ink shrink-0" />
            <div><strong>{selectedTable ? `${selectedTable.number}-stol · ${tableShop?.name || 'Do‘kon'}` : 'Stol tanlanmagan'}</strong>
              <p className="text-xs text-muted-foreground">{tableOrderLoading ? 'Buyurtma yuklanmoqda…' : tableOrder?.state === 'paying' ? 'To‘lov tekshirilmoqda — yangi savdo boshlamang.' : tableOrder ? `Band · to‘lanmagan: ${formatUZS(tableOrder.total)} · ${tableOrder.items?.length || 0} tur` : 'Bo‘sh stol · buyurtma qo‘shib saqlang.'}</p>
              {tableCartDirty && !tableOrderLoading && <p className="text-xs font-semibold text-amber-900">Saqlanmagan o‘zgarishlar bor. Stol almashtirilganda avval serverda saqlanadi.</p>}
              {(tableOrderError || tableSaveError) && <p role="alert" className="text-xs text-destructive">{tableOrderError || tableSaveError}</p>
              {tableSelectionError && <p role="alert" className="text-xs text-destructive">{tableSelectionError}</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(tableOrderError || tableSaveError) && <Button type="button" variant="outline" className="min-h-11" onClick={async () => {
              if (tableCartDirty && !(await odinaConfirm('Saqlanmagan savat o‘chadi. Serverdagi buyurtmani qayta yuklaysizmi?'))) return;
              setTableReload((current) => current + 1);
            }}>Buyurtmani yangilash</Button>}
            <Button type="button" variant="outline" className="min-h-11" onClick={() => void openTablePicker()}><ArrowLeft className="w-4 h-4 mr-1" /> Stollar xaritasi</Button>
          </div>
        </div>
      )}

      {!screenMode && wasteAlerts.length > 0 && (
        <button
          type="button"
          onClick={() => navigate('/waste')}
          className="mx-3 sm:mx-5 mt-3 shrink-0 flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left text-red-900 hover:bg-red-100 transition-colors touch-manipulation"
        >
          <span className="w-9 h-9 rounded-xl bg-red-100 text-red-700 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{wasteAlerts.length} tur mahsulot 3 kundan oshgan</span>
            <span className="block text-xs text-red-700/80 mt-0.5">Ko‘rish va chiqitga chiqarish uchun bosing.</span>
          </span>
          <span className="text-sm font-semibold shrink-0">Ko‘rish →</span>
        </button>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Center: categories + grid */}
        <div className="flex-1 flex min-w-0">
          {/* Category rail */}
          <div className="odina-category-rail hidden md:flex w-44 shrink-0 border-r border-border bg-sidebar/50 flex-col py-3 overflow-y-auto scrollbar-thin">
            <p className="odina-category-title">KATEGORIYALAR</p>
            <CatTab active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }} icon={<Search className="w-4 h-4" />} label="Barchasi" />
            <CatTab active={showFav} onClick={() => setShowFav(true)} icon={<Star className="w-4 h-4" />} label="Sevimlilar" />
            <div className="h-px bg-border my-2 mx-3" />
            {categories.map((c) => (
              <CatTab key={c.id} active={activeCat === c.id && !showFav} onClick={() => { setActiveCat(c.id); setShowFav(false); }} icon={<span className="text-base">{c.icon || '🍰'}</span>} label={c.name} />
            ))}
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            {/* Search + mobile categories */}
            <div className="odina-pos-search px-4 sm:px-5 pt-4 pb-2 space-y-3">
              <div className="odina-catalog-heading">
                <h1>Mahsulotlar</h1>
                {!loadingData && <span>{filtered.length} ta mahsulot</span>}
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input aria-label="Mahsulotlarni qidirish" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mahsulotlarni qidirish…" className="pl-9 h-11 rounded-xl" />
              </div>
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 md:hidden">
                <Chip active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }}>Barchasi</Chip>
                <Chip active={showFav} onClick={() => setShowFav(true)}>★ Sevimlilar</Chip>
                {categories.map((c) => (
                  <Chip key={c.id} active={activeCat === c.id && !showFav} onClick={() => { setActiveCat(c.id); setShowFav(false); }}>{c.name}</Chip>
                ))}
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-4 sm:px-5 pb-28 xl:pb-6">
              {loadingData ? (
                <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
                  {Array.from({ length: 8 }).map((_, i) => <div key={i} className="aspect-[3/4] rounded-2xl bg-secondary animate-pulse" />)}
                </div>
              ) : filtered.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-20">
                  <div className="text-5xl mb-3">🧁</div>
                  <p className="text-sm font-medium text-muted-foreground">Mahsulot topilmadi</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
                  {filtered.map((p) => (
                    <ProductCard
                      key={p.id}
                      product={p}
                      stockQuantity={p.track_stock === false || !shift ? null : Number(stockByProduct[p.id] || 0)}
                      onAdd={addToCart}
                      disabled={tableLocked || paying}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Cart */}
        <div className="odina-cart-wrap hidden xl:flex w-[380px] 2xl:w-[420px] min-w-0 shrink-0 border-l border-border overflow-hidden">
          <Cart
            cart={cart}
            onInc={inc} onDec={dec} onRemove={removeItem} onClear={clearCart}
            subtotal={subtotal} discount={discount} couponDiscount={couponDiscount} discountCode={discountCode}
            onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError}
            roundingTarget={roundingTarget} adjustmentMode={adjustmentMode} roundingError={roundingError}
            onApplyRounding={applyRounding} onApplyManualDiscount={applyManualDiscount}
            onRemoveRounding={() => { setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); }}
            total={total} onCheckout={openCheckout} disabled={!shift || Boolean(tableSelectionError)}
            tableMode={Boolean(selectedTable)} tableDirty={tableCartDirty} tableSaved={Boolean(tableOrder?.id)}
            onSaveTable={() => void saveTableOrder()} savingTable={savingTable} locked={tableLocked || paying}
          />
        </div>
      </div>

      {/* Telefon va iPad uchun doim ko‘rinadigan buyurtma paneli */}
      <div className={`xl:hidden fixed left-0 ${screenMode ? '' : sidebarCollapsed ? 'lg:left-20' : 'lg:left-64'} right-0 bottom-0 z-40 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-card/95 backdrop-blur border-t border-border transition-[left] duration-200`}>
        <Button onClick={() => setMobileCartOpen(true)} className="w-full min-h-14 h-auto py-4 whitespace-normal text-base font-semibold rounded-2xl bg-primary text-primary-foreground hover:bg-primary-strong premium-shadow-lg touch-manipulation">
          Buyurtma · {formatUZS(total)} ({cart.reduce((s, i) => s + i.quantity, 0)} ta)
        </Button>
      </div>

      <Sheet open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <SheetContent side="bottom" className="odina-cart-sheet xl:hidden h-[88dvh] p-0 rounded-t-[28px] overflow-hidden">
          <SheetTitle className="sr-only">Joriy buyurtma</SheetTitle>
          <Cart
            cart={cart}
            onInc={inc} onDec={dec} onRemove={removeItem} onClear={clearCart}
            subtotal={subtotal} discount={discount} couponDiscount={couponDiscount} discountCode={discountCode}
            onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError}
            roundingTarget={roundingTarget} adjustmentMode={adjustmentMode} roundingError={roundingError}
            onApplyRounding={applyRounding} onApplyManualDiscount={applyManualDiscount}
            onRemoveRounding={() => { setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); }}
            total={total} onCheckout={() => { setMobileCartOpen(false); void openCheckout(); }} disabled={!shift || Boolean(tableSelectionError)}
            tableMode={Boolean(selectedTable)} tableDirty={tableCartDirty} tableSaved={Boolean(tableOrder?.id)}
            onSaveTable={() => void saveTableOrder()} savingTable={savingTable} locked={tableLocked || paying}
          />
        </SheetContent>
      </Sheet>

      {!screenMode && <Sheet open={tablePickerOpen} onOpenChange={setTablePickerOpen}>
        <SheetContent side="bottom" className="h-[92dvh] overflow-y-auto rounded-t-[28px] p-4 sm:p-6">
          <SheetTitle className="font-display text-xl font-bold pr-10">Kassa · Stollar xaritasi</SheetTitle>
          <p className="text-sm text-muted-foreground mt-1 mb-4">Stolni tanlang — Kassa o‘sha stol bilan ochiladi. Savat avval saqlanmagan bo‘lsa, almashtirishdan oldin tasdiq so‘raladi.</p>
          {tablePickerLoading ? <div role="status" className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">Stollar yuklanmoqda…</div> : <>
            {tablePickerError && <div role="alert" className="mb-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{tablePickerError}</div>}
            {tablePickerShops.length > 1 && <div role="group" aria-label="Stollar do‘konini tanlash" className="mb-4 flex flex-wrap gap-2">
              {tablePickerShops.map((shop) => <Button key={shop.id} type="button" variant={shop.id === tablePickerShopId ? 'default' : 'outline'}
                onClick={() => setTablePickerShopId(shop.id)} className="min-h-11 rounded-xl">
                {shop.name} · {shop.table_count} stol
              </Button>)}
            </div>}
            {tablePickerShop && tablePickerShop.table_count > 0
              ? <React.Suspense fallback={<div role="status" className="rounded-2xl border bg-card p-8 text-center text-sm text-muted-foreground">Zal xaritasi ochilmoqda…</div>}>
                  <TableFloorplan key={`${tablePickerShop.id}:${tablePickerShop.layout_version}`} shop={tablePickerShop}
                    canManage={false} onOpen={(shopId, number) => void chooseTableInPos(shopId, number)} />
                </React.Suspense>
              : !tablePickerError && <div className="rounded-2xl border border-dashed p-7 text-center text-sm text-muted-foreground">
                  Bu do‘konda stol soni belgilanmagan. «Stollar» sahifasida admin sozlashi mumkin.
                </div>}
          </>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void openTablePicker()} disabled={tablePickerLoading} className="min-h-11 rounded-xl"><RefreshCw className="h-4 w-4 mr-1.5" /> Yangilash</Button>
            {selectedTable && <Button type="button" variant="outline" onClick={async () => {
              if (cart.length && !(await odinaConfirm('Oddiy savdoga o‘tsangiz stolning saqlanmagan savati yo‘qoladi. Davom etasizmi?'))) return;
              setTablePickerOpen(false);
              navigate('/pos');
            }} className="min-h-11 rounded-xl">Oddiy savdoga o‘tish</Button>}
          </div>
        </SheetContent>
      </Sheet>}
      <PaymentModal
        open={payOpen}
        total={total}
        onClose={closePayment}
        onConfirm={completeSale}
        loading={paying}
        offline={checkoutOffline || (!isOnline && !selectedTable)}
      />
      <Receipt open={receiptOpen} sale={lastSale} settings={settings} onClose={() => {
        setReceiptOpen(false);
        if (selectedTable && !lastSale?.offline_pending) {
          navigate('/pos');
          void openTablePicker();
        }
      }} />
      <OpenShiftDialog open={openShiftOpen} shops={shops} user={user} onClose={() => setOpenShiftOpen(false)} onConfirm={openShift} loading={shiftLoading} />
      <CloseShiftDialog open={closeShiftOpen} shift={shift} onClose={() => setCloseShiftOpen(false)} onConfirm={closeShift} loading={shiftLoading} />
      <OwnerPinDialog
        open={discountApprovalOpen}
        title="100% chegirmani tasdiqlash"
        description={pendingDiscountCode ? `${pendingDiscountCode} — 100% chegirma uchun OWNER PIN kiriting.` : ''}
        onClose={() => { setDiscountApprovalOpen(false); setPendingDiscountCode(''); }}
        onConfirm={(pin) => validateDiscount(pendingDiscountCode, pin)}
        loading={discountLoading}
      />
      <CashWithdrawalDialog
        open={cashWithdrawalOpen}
        shift={shift}
        user={user}
        recipients={cashRecipients}
        supplierDebts={supplierDebts}
        onClose={() => setCashWithdrawalOpen(false)}
        onConfirm={recordCashWithdrawal}
        loading={cashWithdrawalLoading}
      />
    </div>
  );
}

function OfflineSalesBanner({ isOnline, records, syncing, storageError, syncError, onRetry }) {
  const failed = records.find((record) => record.status === 'failed');
  const error = storageError || failed?.last_error || syncError;
  if (isOnline && !records.length && !syncing && !error) return null;

  const danger = Boolean(storageError || failed);
  const tone = danger
    ? 'border-red-200 bg-red-50 text-red-900'
    : 'border-amber-200 bg-amber-50 text-amber-900';
  const Icon = !isOnline ? CloudOff : syncing ? RefreshCw : CloudUpload;
  const title = storageError
    ? 'Offline xotira ishlamayapti'
    : !isOnline
      ? `Internet yo‘q${records.length ? ` · ${records.length} ta savdo navbatda` : ''}`
      : syncing
        ? `${records.length} ta savdo yuborilmoqda…`
        : `${records.length} ta savdo serverga yuborilmagan`;
  const description = error
    ? error
    : !isOnline
      ? 'Oddiy savdolar shu qurilmada xavfsiz saqlanadi.'
      : 'Internet ishlayapti. Navbatni qayta yuborishingiz mumkin.';

  return (
    <div className={`mx-3 sm:mx-5 mt-3 shrink-0 flex items-center gap-3 rounded-2xl border px-3.5 py-2.5 ${tone}`}>
      <span className="w-9 h-9 rounded-xl bg-white/60 flex items-center justify-center shrink-0">
        <Icon className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs opacity-80 mt-0.5 truncate">{description}</span>
      </span>
      {isOnline && records.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={syncing}
          onClick={() => { void onRetry(); }}
          className="h-10 shrink-0 bg-white/70"
        >
          <RefreshCw className={`w-4 h-4 sm:mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">Qayta yuborish</span>
        </Button>
      )}
    </div>
  );
}

function CatTab({ active, onClick, icon, label }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={`odina-category-tab flex items-center gap-2.5 px-3 py-3 mx-2 min-h-11 border rounded-xl text-sm font-medium transition-all active:scale-[0.98] touch-manipulation text-left ${active ? 'bg-primary/35 text-brand-ink border-brand-sand' : 'text-muted-foreground hover:bg-secondary border-transparent'}`}>
      <span className="w-5 flex justify-center">{icon}</span>
      <span className="min-w-0 break-words leading-snug">{label}</span>
    </button>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={`whitespace-nowrap min-h-11 px-4 py-2 rounded-full text-sm font-medium transition-all active:scale-[0.98] touch-manipulation ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground/70'}`}>
      {children}
    </button>
  );
}