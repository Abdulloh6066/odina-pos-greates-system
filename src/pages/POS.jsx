import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';
import { AlertTriangle, Search, Star, Clock, Building2, Banknote, CloudOff, CloudUpload, RefreshCw, Armchair, ArrowLeft, CheckCircle2, X, ReceiptText, UtensilsCrossed, Monitor, ListOrdered } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUZS } from '@/lib/pos';
import { priceForShop } from '@/lib/shop-pricing';
import { categoryForShop } from '@/lib/shop-category';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import ProductCard from '@/components/pos/ProductCard';
import ProductOrderDialog from '@/components/pos/ProductOrderDialog';
import usePosProductOrder from '@/hooks/usePosProductOrder';
import { sortByShopOrder } from '@/lib/pos-product-order';
import Cart, { DiscountRow, RoundingRow } from '@/components/pos/Cart';
import PaymentModal from '@/components/pos/PaymentModal';
import SalesHistory from '@/pages/SalesHistory';
import Receipt from '@/components/pos/Receipt';
import ShiftReport from '@/components/pos/ShiftReport';
import StaffOrderTicketModal from '@/components/tables/StaffOrderTicketModal';
import PosTablePicker from '@/components/tables/PosTablePicker';
import { OpenShiftDialog, CloseShiftDialog } from '@/components/pos/ShiftDialog';
import { OwnerPinDialog, CashWithdrawalDialog } from '@/components/pos/KassaActionDialogs';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import useOfflineSaleQueue from '@/hooks/useOfflineSaleQueue';
import CategoryIcon from '@/components/CategoryIcon';
import {
  buildPendingSale,
  createSaleIdempotencyKey,
  isRetryableSyncError,
  syncErrorMessage,
} from '@/lib/offline-sales';

// Temporary business choice: sell through without the negative-stock confirmation.
// Set to true when the owner wants the warning restored.
const SHOW_NEGATIVE_STOCK_CONFIRMATION = false;

export default function POS() {
  const { user, sidebarCollapsed, screenMode, posCompact, togglePosCompact } = useOutletContext();
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
  const selectedTable = tableQuery.selected;
  const posHomePath = screenMode ? '/pos?screen=1' : '/pos';
  const tableKey = selectedTable ? `${selectedTable.shopId}:${selectedTable.number}` : '';
  const priorTableKey = useRef(tableKey);
  const lastSavedOrderRef = useRef(null);

  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);
  const [productStock, setProductStock] = useState([]);
  const [activeCat, setActiveCat] = useState('all');
  const [search, setSearch] = useState('');
  const [showFav, setShowFav] = useState(false);
  const [cart, setCart] = useState([]);
  const [keyboardProductId, setKeyboardProductId] = useState(null);
  const [weightProduct, setWeightProduct] = useState(null);
  const [grams, setGrams] = useState('');
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
  const checkoutCancelledRef = useRef(false);
  const checkoutReadyRef = useRef(false);
  const [salesHistoryOpen, setSalesHistoryOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const saleSubmittingRef = useRef(false);
  const [checkoutOffline, setCheckoutOffline] = useState(false);
  const checkoutRequestKeyRef = useRef('');
  const checkoutRecordedAtRef = useRef('');
  const [receiptPrintSale, setReceiptPrintSale] = useState(null);
  const [shiftReport, setShiftReport] = useState(null);
  const [staffTicketPrompt, setStaffTicketPrompt] = useState(null);
  const [staffTicket, setStaffTicket] = useState(null);
  const [takeawayOrder, setTakeawayOrder] = useState(null);
  const [takeawaySaving, setTakeawaySaving] = useState(false);
  const takeawaySavingRef = useRef(false);
  const takeawayRequestIdRef = useRef('');
  const [openOrdersOpen, setOpenOrdersOpen] = useState(false);
  const [openOrders, setOpenOrders] = useState([]);
  const [openOrdersLoading, setOpenOrdersLoading] = useState(false);
  const [openOrdersError, setOpenOrdersError] = useState('');
  const takeawayDirty = Boolean(takeawayOrder) && JSON.stringify(cart.map(({ product_id, quantity }) => ({ product_id, quantity })))
    !== JSON.stringify((takeawayOrder?.items || []).map(({ product_id, quantity }) => ({ product_id, quantity })));

  const [openShiftOpen, setOpenShiftOpen] = useState(false);
  const [closeShiftOpen, setCloseShiftOpen] = useState(false);
  const [shiftToClose, setShiftToClose] = useState(null);
  const closingShiftRef = useRef(false);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [discountApprovalOpen, setDiscountApprovalOpen] = useState(false);
  const [pendingDiscountCode, setPendingDiscountCode] = useState('');
  const [discountLoading, setDiscountLoading] = useState(false);
  const [cashWithdrawalOpen, setCashWithdrawalOpen] = useState(false);
  const [cashWithdrawalLoading, setCashWithdrawalLoading] = useState(false);
  const cashWithdrawalSubmittingRef = useRef(false);
  const cashWithdrawalRequestRef = useRef(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  // Match the cart's lg:hidden breakpoint, including tablets and window resizing.
  const [compactCartViewport, setCompactCartViewport] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const syncCartViewport = () => {
      setCompactCartViewport(media.matches);
      if (!media.matches) setMobileCartOpen(false);
    };
    syncCartViewport();
    media.addEventListener('change', syncCartViewport);
    return () => media.removeEventListener('change', syncCartViewport);
  }, []);
  const [tablePickerOpen, setTablePickerOpen] = useState(false);
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
    setTakeawayOrder(null);
    takeawayRequestIdRef.current = '';
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

  // Automatically clear an invalid table selection if the cashier changes the active shop.
  useEffect(() => {
    if (!selectedTable) return;
    const activeShopId = shift?.shop_id || user?.shop_id;
    if (activeShopId && selectedTable.shopId !== activeShopId) {
      setCart([]);
      setTableOrder(null);
      setTableOrderLoading(false);
      setTableOrderError('');
      setTableSaveError('');
      setDiscountCode('');
      setDiscountPct(0);
      setRoundingTarget(null);
      setAdjustmentMode(null);
      navigate(posHomePath, { replace: true });
    }
  }, [shift?.shop_id, user?.shop_id, selectedTable?.shopId]);

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
  const tableLocked = takeawaySaving || takeawayOrder?.state === 'paying'
    || (Boolean(selectedTable) && (tableOrderLoading || savingTable
    || Boolean(tableOrderError) || tableOrder?.state === 'paying'));
  // A browser refresh or tab close must warn about edits not yet acknowledged
  // by the server. Saved orders remain available after any reload.
  useEffect(() => {
    if (!(selectedTable && tableCartDirty) && !takeawayDirty) return undefined;
    const warnUnsaved = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warnUnsaved);
    return () => window.removeEventListener('beforeunload', warnUnsaved);
  }, [tableKey, tableCartDirty, takeawayDirty]);
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
        items: cart.map((row) => ({
          product_id: row.product_id,
          quantity: row.quantity,
          variant_name: row.variant_name || row.variant || '',
          notes: row.notes || '',
        })),
        opened_by_name: user?.name || user?.full_name || '',
      });
      const result = response?.data || response;
      if (!result?.ok || !result.order?.id) throw new Error(result?.error || 'Buyurtma saqlangani tasdiqlanmadi.');
      lastSavedOrderRef.current = result.order;
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

  const saveTakeawayOrder = async () => {
    if (takeawaySavingRef.current || selectedTable || !cart.length || !shift) return null;
    if (!isOnline || navigator.onLine === false) {
      void odinaAlert('Buyurtmani saqlash uchun internet kerak. Savatingiz saqlanib turadi.');
      return null;
    }
    if (takeawayOrder && !takeawayDirty) return takeawayOrder;
    takeawaySavingRef.current = true;
    setTakeawaySaving(true);
    const orderId = takeawayOrder?.id || takeawayRequestIdRef.current || createSaleIdempotencyKey();
    takeawayRequestIdRef.current = orderId;
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'save_takeaway_order', shop_id: shift.shop_id, shift_id: shift.id,
        order_id: orderId, expected_revision: takeawayOrder?.revision || 0,
        items: cart.map((row) => ({ product_id: row.product_id, quantity: row.quantity,
          variant_name: row.variant_name || row.variant || '', notes: row.notes || '' })),
      });
      const result = response?.data || response;
      if (!result?.ok || !result.order?.id) throw new Error(result?.error || 'Buyurtma saqlanmadi.');
      setTakeawayOrder(result.order);
      setCart(result.order.items);
      return result.order;
    } catch (error) {
      void odinaAlert(error?.response?.data?.error || error?.message || 'Buyurtma saqlanmadi. Qayta urinib ko‘ring.');
      return null;
    } finally {
      takeawaySavingRef.current = false;
      setTakeawaySaving(false);
    }
  };

  const showTakeawayTicket = async () => {
    if (paying || payOpen || stockChecking) return;
    const saved = await saveTakeawayOrder();
    if (!saved) return;
    setMobileCartOpen(false);
    setStaffTicket({ mode: 'takeaway', order: saved, shop: shops.find((row) => row.id === shift.shop_id) });
    setTakeawayOrder(null);
    resetCart();
  };

  const loadOpenOrders = async () => {
    const shopId = shift?.shop_id || user?.shop_id;
    if (!shopId) { void odinaAlert('Avval do‘kon smenasini oching.'); return; }
    setOpenOrdersOpen(true);
    setMobileCartOpen(false);
    setOpenOrdersLoading(true);
    setOpenOrdersError('');
    setOpenOrders([]);
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'list_takeaway_orders', shop_id: shopId,
      });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Buyurtmalar yuklanmadi.');
      setOpenOrders(result.orders || []);
    } catch (error) {
      setOpenOrdersError(error?.response?.data?.error || error?.message || 'Buyurtmalar yuklanmadi.');
    } finally { setOpenOrdersLoading(false); }
  };

  const openTakeaway = async (order) => {
    if (paying || payOpen || stockChecking || takeawaySavingRef.current || savingTableRef.current) return;
    if (cart.length && !(await odinaConfirm({
      title: 'Buyurtmani ochish',
      description: 'Joriy savat o‘rniga saqlangan buyurtma ochiladi. Saqlanmagan o‘zgarishlar bekor qilinadi. Davom etasizmi?',
      confirmLabel: 'Ochish',
    }))) return;
    setOpenOrdersLoading(true);
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'get_takeaway_order', shop_id: shift?.shop_id || user?.shop_id, order_id: order.id,
      });
      const result = response?.data || response;
      if (!result?.ok || !result.order) throw new Error('Buyurtma yopilgan. Ro‘yxatni yangilang.');
      resetCart();
      setTakeawayOrder(result.order);
      setCart(result.order.items);
      setOpenOrdersOpen(false);
      setMobileCartOpen(window.matchMedia('(max-width: 1023px)').matches);
    } catch (error) {
      setOpenOrdersError(error?.response?.data?.error || error?.message || 'Buyurtma ochilmadi.');
    } finally { setOpenOrdersLoading(false); }
  };

  const leaveTakeaway = async () => {
    if (takeawaySavingRef.current || paying || payOpen || stockChecking) return;
    if (takeawayDirty && !(await saveTakeawayOrder())) return;
    setTakeawayOrder(null);
    resetCart();
  };

  const reconcileTakeaway = async (order) => {
    setOpenOrdersLoading(true);
    setOpenOrdersError('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'reconcile_takeaway_payment', shop_id: shift?.shop_id || user?.shop_id, order_id: order.id,
      });
      const result = response?.data || response;
      if (!result?.ok || !result.released) throw new Error(result?.error || 'To‘lov tasdiqlanmadi.');
      if (takeawayOrder?.id === order.id) { setTakeawayOrder(null); resetCart(); }
      await loadOpenOrders();
    } catch (error) {
      setOpenOrdersError(error?.response?.data?.error || error?.message || 'To‘lovni tekshirib bo‘lmadi.');
    } finally { setOpenOrdersLoading(false); }
  };

  const reconcileTablePayment = async () => {
    if (!selectedTable || tableOrder?.state !== 'paying') return;
    if (!isOnline) { void odinaAlert('To‘lovni tekshirish uchun internet kerak.'); return; }
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'reconcile_table_payment', shop_id: selectedTable.shopId, table_number: selectedTable.number,
      });
      const result = response?.data || response;
      if (!result?.ok || !result?.released) throw new Error(result?.error || 'Stolni bo‘shatish tasdiqlanmadi.');
      setTableReload((current) => current + 1);
      setTableSaveError('');
      void odinaAlert('To‘lov Savdolar tarixida tasdiqlandi. Stol endi bo‘sh.');
    } catch (error) {
      setTableSaveError(error?.response?.data?.error || error?.data?.error || error?.message || 'To‘lovni tasdiqlab bo‘lmadi.');
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
    const categoryPriority = {
      '15 somlik': 1,
      '18 somlik': 2,
      'aralash': 3,
      'mini/tart': 4,
      'pishiriqlar': 5,
      'tortlar': 6,
    };
    const activeCategories = (cats || []).filter((c) => c.active);
    const normalizeCategoryName = (name) => String(name || '').trim().toLowerCase();
    const categoryByName = new Map(activeCategories.map((c) => [normalizeCategoryName(c.name), c]));
    const pairedCategories = {
      'kofe/issiq&kofe/ice': 'kofe/ice',
      'limonadlar&matcha/anchan': 'matcha anchan',
      'milkshake&smuzi': 'smuzi',
    };
    const hiddenCategoryIds = new Set();
    const displayCategories = activeCategories.map((category) => {
      const paired = categoryByName.get(pairedCategories[normalizeCategoryName(category.name)]);
      if (paired) hiddenCategoryIds.add(paired.id);
      return {
        ...category,
        sourceCategoryIds: paired ? [category.id, paired.id] : [category.id],
      };
    });
    setCategories(
      displayCategories
        .filter((c) => !hiddenCategoryIds.has(c.id))
        .sort((a, b) => {
          const aName = normalizeCategoryName(a.name);
          const bName = normalizeCategoryName(b.name);
          const aPriority = categoryPriority[aName] ?? 100;
          const bPriority = categoryPriority[bName] ?? 100;
          return aPriority - bPriority;
        }),
    );
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

  // Show the current shop's floor plan over Kassa. Save pending table edits
  // before switching so an unpaid order cannot silently lose its cart.
  const goToTables = async () => {
    if (savingTableRef.current || paying || payOpen || stockChecking || tableOrderLoading) return;
    if (selectedTable && tableOrderError) {
      void odinaAlert('Stol buyurtmasi yuklanmagan. Avval buyurtmani yangilang; saqlanmagan mahsulotlar yo‘qolmasligi kerak.');
      return;
    }
    if (selectedTable && tableCartDirty && !(await saveTableOrder())) return;
    if (takeawayDirty && !(await saveTakeawayOrder())) return;
    setMobileCartOpen(false);
    setTablePickerOpen(true);
  };

  const selectTableFromPicker = async (shopId, number, payDirect) => {
    if (!selectedTable && cart.length && !(await odinaConfirm({
      title: 'Savatni almashtirish',
      description: 'Joriy savatda saqlanmagan mahsulotlar bor. Stolga o‘tsangiz bu savat tozalanadi. Davom etasizmi?',
      confirmLabel: 'Stolga o‘tish',
      tone: 'warning',
    }))) {
      setTablePickerOpen(true);
      return;
    }
    setTablePickerOpen(false);
    setMobileCartOpen(false);
    autoPayProcessedRef.current = false;
    const query = new URLSearchParams({
      ...(screenMode ? { screen: '1' } : {}),
      table_shop: shopId,
      table_number: String(number),
      ...(payDirect ? { action: 'pay' } : {}),
    });
    navigate(`/pos?${query}`);
  };

  // Deselect the table immediately without full page reload.
  // Existing saved orders on the server remain intact and are not deleted or marked paid.
  const cancelTableSelection = async () => {
    if (savingTableRef.current || tableOrderLoading) return;
    if (tableCartDirty) {
      const confirmed = await odinaConfirm({
        title: 'Stol tanlovini bekor qilish',
        description: 'Savatda saqlanmagan o‘zgarishlar bor. Stol tanlovini bekor qilsangiz, buyurtma saqlanmagan o‘zgarishlarsiz serverdagi asl holatida qoladi. Davom etasizmi?',
        confirmLabel: 'Stolni bekor qilish',
        tone: 'warning',
      });
      if (!confirmed) return;
    }
    resetCart();
    setTableOrder(null);
    setTableOrderLoading(false);
    setTableOrderError('');
    setTableSaveError('');
    setDiscountCode('');
    setDiscountPct(0);
    setDiscountOwnerPin('');
    setRoundingTarget(null);
    setAdjustmentMode(null);
    setMobileCartOpen(false);
    navigate(posHomePath, { replace: true });
  };

  // This button finishes only the unpaid order's SAVE, never its payment.
  // Leave this table only after the server confirms the write; a failed save
  // keeps the cart on screen for retry without creating a new sale.
  const saveAndStartNextOrder = async () => {
    if (!selectedTable || tableOrderLoading || savingTableRef.current || paying || payOpen || stockChecking
      || tableOrderError || tableOrder?.state === 'paying') return;
    if (tableCartDirty && !(await saveTableOrder())) return;
    if (!tableCartDirty && !tableOrder?.id) return;
    const savedNumber = selectedTable.number;
    const savedShopId = selectedTable.shopId;
    const savedShop = tableShop;
    resetCart();
    setTableOrder(null);
    setTableSaveError('');
    setActiveCat('all');
    setShowFav(false);
    setSearch('');
    setMobileCartOpen(false);
    navigate(posHomePath, { replace: true, state: { savedTableNumber: savedNumber, savedShopId } });
    setStaffTicket({ mode: 'table', shop: savedShop, shopId: savedShopId, tableNumber: savedNumber });
  };

  const tableShop = selectedTable ? shops.find((shop) => shop.id === selectedTable.shopId) : null;
  const tableSelectionError = tableQuery.invalid
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
      || reduction <= 0) {
      setRoundingError(mode === 'manual'
        ? 'Chegirma musbat bo‘lsin va yakuniy summa kamida 1 so‘m qolsin.'
        : 'Yaxlitlash summasi noto‘g‘ri. Yakuniy summa kamida 1 so‘m bo‘lsin.');
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

  const openWeight = (product, editing = false) => {
    if (tableLocked || paying || payOpen || stockChecking) return;
    const existing = cart.find((row) => row.product_id === (product.id || product.product_id));
    setWeightProduct({ ...product, id: product.id || product.product_id,
      name: product.name || product.product_name, price: existing?.price ?? product.price, editing });
    setGrams(editing ? String(existing?.quantity || '') : '');
  };
  const saveWeight = () => {
    const quantity = Number(grams);
    if (!weightProduct || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000
      || tableLocked || paying || payOpen || stockChecking) return;
    const product = weightProduct;
    setCart((rows) => {
      const existing = rows.find((row) => row.product_id === product.id);
      const combined = product.editing ? quantity : quantity + (existing?.quantity || 0);
      if (combined > 1000000) return rows;
      const row = { ...existing, product_id: product.id, product_name: product.name,
        image_url: product.image_url, price: product.price, sale_unit: 'gram',
        quantity: combined, subtotal: Math.round(product.price * combined / 1000) };
      return existing ? rows.map((item) => item.product_id === product.id ? row : item) : [...rows, row];
    });
    setWeightProduct(null);
  };
  const addToCart = (product) => {
    if (tableLocked || paying || payOpen || stockChecking) return;
    setKeyboardProductId(product.id);
    if (product.sale_unit === 'gram') { openWeight(product); return; }
    setCart((prev) => {
      const existing = prev.find((i) => i.product_id === product.id);
      if (existing) {
        return prev.map((i) => i.product_id === product.id ? { ...i, quantity: i.quantity + 1, subtotal: i.subtotal + i.price } : i);
      }
      return [...prev, { product_id: product.id, product_name: product.name, image_url: product.image_url, price: product.price, sale_unit: 'piece', quantity: 1, subtotal: product.price }];
    });
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const increase = event.key === '+' || event.key === 'Add' || event.code === 'NumpadAdd' || event.code === 'Equal';
      const decrease = event.key === '-' || event.key === 'Subtract' || event.code === 'NumpadSubtract' || event.code === 'Minus';
      if (!increase && !decrease) return;
      const target = event.target;
      if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="spinbutton"]')) return;
      if (tableLocked || paying || payOpen || stockChecking || !cart.length) return;
      // The mobile cart is itself a dialog; every other open dialog blocks shortcuts.
      if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
        .some((node) => node.getAttribute('data-state') !== 'closed' && !node.classList.contains('odina-cart-sheet')
          && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')) return;
      const item = cart.find((row) => row.product_id === keyboardProductId) || cart[cart.length - 1];
      event.preventDefault();
      if (increase) inc(item); else dec(item);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  // Keep the final row visible until the cashier confirms and the server acknowledges cancellation.
  const cancelLastTableItem = async () => {
    if (!selectedTable || savingTableRef.current || tableLocked || paying || payOpen || stockChecking) return;
    const cancellingTableKey = tableKey;
    savingTableRef.current = true;
    setSavingTable(true);
    setTableSaveError('');
    try {
      const confirmed = await odinaConfirm({
        title: 'Stol buyurtmasi bekor qilinsinmi?',
        description: 'Oxirgi mahsulot olib tashlanadi va stol bo‘shaydi. Pul tushumi yozilmaydi.',
        confirmLabel: 'Ha, bekor qilish',
        cancelLabel: 'Yo‘q, qolsin',
        tone: 'warning',
      });
      if (!confirmed) return;
      let result = null;
      if (tableOrder?.id) {
        if (!shift || shift.shop_id !== selectedTable.shopId) throw new Error('Bekor qilish uchun shu do‘kondagi smenani oching.');
        if (!isOnline || navigator.onLine === false) throw new Error('Internet yo‘q. Buyurtma bekor qilinmadi; mahsulot savatda qoldi.');
        const response = await base44.functions.invoke('restaurant-tables', {
          action: 'cancel_table_order', shop_id: selectedTable.shopId,
          table_number: selectedTable.number, shift_id: shift.id,
          table_order_id: tableOrder.id, expected_revision: tableOrder.revision, confirm_cancel: true,
        });
        result = response?.data || response;
        if (!result?.ok) throw new Error(result?.error || 'Buyurtma bekor qilingani tasdiqlanmadi.');
      }
      if (priorTableKey.current !== cancellingTableKey) return;
      resetCart();
      setTableOrder(null);
      lastSavedOrderRef.current = null;
      setMobileCartOpen(false);
      checkoutRequestKeyRef.current = '';
      checkoutRecordedAtRef.current = '';
      navigate(posHomePath, { replace: true });
      if (result?.audit_warning) {
        void odinaAlert('Stol bo‘shatildi. Buyurtma nusxasi va bekor qilish so‘rovi tarixda saqlandi, yakuniy tarix yozuvi tasdiqlanmadi.');
      } else if (result?.already_closed) {
        void odinaAlert('Buyurtma allaqachon yopilgan. Stol holati yangilandi.');
      }
    } catch (error) {
      const message = error?.response?.data?.error || error?.message || 'Buyurtma bekor qilinmadi.';
      setTableSaveError(message);
      void odinaAlert(message);
    } finally {
      savingTableRef.current = false;
      setSavingTable(false);
    }
  };

  const inc = (item) => { if (item.sale_unit === 'gram') { openWeight(item, true); return; } if (!tableLocked && !paying) setCart((p) => p.map((i) => i.product_id === item.product_id ? { ...i, quantity: i.quantity + 1, subtotal: i.subtotal + i.price } : i)); };
  const dec = (item) => {
    if (tableLocked || paying || payOpen || stockChecking || savingTableRef.current) return;
    if (item.sale_unit === 'gram') { openWeight(item, true); return; }
    if (selectedTable && cart.length === 1 && cart[0].product_id === item.product_id && item.quantity <= 1) {
      void cancelLastTableItem();
      return;
    }
    setCart((p) => p.flatMap((i) => {
      if (i.product_id !== item.product_id) return [i];
      const q = i.quantity - 1;
      return q <= 0 ? [] : [{ ...i, quantity: q, subtotal: q * i.price }];
    }));
  };
  const removeItem = (item) => {
    if (tableLocked || paying || payOpen || stockChecking || savingTableRef.current) return;
    if (selectedTable && cart.length === 1 && cart[0].product_id === item.product_id) {
      void cancelLastTableItem();
      return;
    }
    setCart((p) => p.filter((i) => i.product_id !== item.product_id));
  };
  const resetCart = () => { takeawayRequestIdRef.current = ''; setCart([]); setDiscountCode(''); setDiscountPct(0); setDiscountError(''); setDiscountOwnerPin(''); setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); };
  const clearCart = () => { if (!tableLocked && !paying && (!selectedTable || !tableOrder) && !takeawayOrder) resetCart(); }; 

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

  const catalogShopId = shift?.shop_id || user?.shop_id;
  const { order: shopProductOrder, accept: acceptProductOrder } = usePosProductOrder(catalogShopId, user?.id);
  const [productOrderOpen, setProductOrderOpen] = useState(false);
  const canEditProductOrder = ['admin', 'manager'].includes(user?.role);

  const filtered = useMemo(() => {
    const shopId = shift?.shop_id || user?.shop_id;
    let list = products.filter((product) => !product.available_shop_ids?.length || product.available_shop_ids.includes(shopId)).map((product) => ({ ...product, price: priceForShop(product, shopId) }));
    if (!showFav && activeCat !== 'all') {
      const selectedCategory = categories.find((c) => c.id === activeCat);
      const sourceIds = selectedCategory?.sourceCategoryIds || [activeCat];
      list = list.filter((p) => sourceIds.includes(categoryForShop(p, shopId)));
    }
    if (showFav) list = list.filter((p) => p.is_favorite || (shopId && p.favorite_shop_ids?.includes(shopId)));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    // Keep related variants immediately before their configured original.
    for (const product of [...list]) {
      if (!product.display_before_product_id || product.display_before_product_id === product.id) continue;
      if (!list.some((row) => row.id === product.display_before_product_id)) continue;
      list = list.filter((row) => row.id !== product.id);
      const targetIndex = list.findIndex((row) => row.id === product.display_before_product_id);
      list.splice(targetIndex, 0, product);
    }
    const activeCategory = categories.find((c) => c.id === activeCat);
    if (activeCategory?.name?.trim().toLowerCase() === 'tortlar') {
      list = [...list].sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
    }
    return sortByShopOrder(list, shopProductOrder);
  }, [products, categories, activeCat, showFav, search, shift?.shop_id, user?.shop_id, shopProductOrder]);

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
    if (!SHOW_NEGATIVE_STOCK_CONFIRMATION) return true;
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
    if (checkoutCancelledRef.current) return;
    checkoutReadyRef.current = true;
    checkoutRequestKeyRef.current = createSaleIdempotencyKey();
    checkoutRecordedAtRef.current = new Date().toISOString();
    setCheckoutOffline(offline);
    setPayOpen(true);
  };

  const openOfflinePayment = async () => {
    if (selectedTable || takeawayOrder || takeawayRequestIdRef.current) {
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
    if ((selectedTable || takeawayOrder || takeawayRequestIdRef.current) && (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false))) {
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
    if (!cart.length || payOpen || stockChecking || offlineSyncing || tableLocked) return;
    if (total <= 0 && !(discountPct === 100 && subtotal > 0)) {
      await odinaAlert('To‘lov summasi 0 UZS. Mahsulot narxini yoki savatni tekshiring.', {
        title: 'Savdoni yakunlab bo‘lmaydi',
        tone: 'danger',
      });
      return;
    }
    checkoutCancelledRef.current = false;
    checkoutReadyRef.current = false;
    setStockChecking(true);
    setCheckoutOffline(false);
    setPayOpen(true);
    try {
      if (selectedTable && (tableCartDirty || !tableOrder?.id) && !(await saveTableOrder())) return;
      const savedTakeaway = takeawayOrder || takeawayRequestIdRef.current ? await saveTakeawayOrder() : null;
      if ((takeawayOrder || takeawayRequestIdRef.current) && !savedTakeaway) return;
      if (checkoutCancelledRef.current) return;
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
        ...(savedTakeaway ? { takeaway_order_id: savedTakeaway.id, takeaway_order_revision: savedTakeaway.revision } : {}),
        ...(selectedTable ? { table_shop_id: selectedTable.shopId,
          table_number: selectedTable.number,
          table_order_id: tableOrder?.id, table_order_revision: tableOrder?.revision } : {}),
        items: cart.map((item) => ({ product_id: item.product_id, quantity: item.quantity })),
      });
      if (checkoutCancelledRef.current) return;
      const payload = result?.data || result;
      const accepted = await confirmStockWarnings(
        payload?.shortages || [],
        payload?.allow_negative_stock,
      );
      if (accepted) openPayment(false);
    } catch (error) {
      if (checkoutCancelledRef.current) return;
      if (isRetryableSyncError(error) && !selectedTable && !takeawayOrder && !takeawayRequestIdRef.current) {
        await openOfflinePayment();
        return;
      }
      const payload = error?.response?.data || error?.data || {};
      const details = (payload.shortages || [])
        .map((item) => `${item.product_name}: ${item.available} ta mavjud`)
        .join('\n');
      void odinaAlert((payload.error || error?.message || 'Qoldiqni tekshirib bo‘lmadi.') + (details ? '\n\n' + details : ''));
    } finally {
      if (!checkoutReadyRef.current || checkoutCancelledRef.current) setPayOpen(false);
      setStockChecking(false);
    }
  };

  const closePayment = () => {
    checkoutCancelledRef.current = true;
    checkoutReadyRef.current = false;
    setPayOpen(false);
    if (paying) return;
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
    setCheckoutOffline(false);
  };

  const autoPayProcessedRef = useRef(false);
  useEffect(() => {
    autoPayProcessedRef.current = false;
  }, [tableKey]);

  useEffect(() => {
    if (autoPayProcessedRef.current) return;
    const query = new URLSearchParams(location.search);
    if (
      query.get('action') === 'pay' &&
      selectedTable &&
      !tableOrderLoading &&
      tableOrder?.id &&
      tableOrder.state === 'occupied' &&
      cart.length > 0
    ) {
      autoPayProcessedRef.current = true;
      void openCheckout();
    }
  }, [selectedTable, tableOrderLoading, tableOrder?.id, tableOrder?.state, cart.length, location.search]);

  const finishSalePresentation = (sale) => {
    setReceiptPrintSale(null);
    if (sale?.items?.length && !sale?.table_number_snapshot && !sale?.table_order_id_snapshot) {
      setStaffTicketPrompt(sale);
    } else if (selectedTable && !sale?.offline_pending) {
      navigate(posHomePath, { replace: true });
      setTablePickerOpen(true);
    }
  };

  const presentCompletedSale = (sale, printReceipt) => {
    checkoutCancelledRef.current = true;
    checkoutReadyRef.current = false;
    if (printReceipt) setReceiptPrintSale(sale);
    else finishSalePresentation(sale);
  };

  const finishQueuedSale = (record, printReceipt) => {
    setPayOpen(false);
    setCheckoutOffline(false);
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
    resetCart();
    presentCompletedSale(record.local_sale, printReceipt);
  };

  const applyCompletedSale = (payload, printReceipt) => {
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
    setCheckoutOffline(false);
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
    resetCart();
    setTableOrder(null);
    setTakeawayOrder(null);
    presentCompletedSale(payload.sale, printReceipt);
    if (payload.table_released === false) {
      void odinaAlert('Savdo yozildi, lekin ochiq buyurtmani yopish tasdiqlanmadi. Qayta pul olmang! Ochiq buyurtmalar yoki Stollar ichida «To‘lovni tekshirish» orqali yakunlang.');
    }
    base44.functions.invoke('waste-ledger', { action: 'get_alerts' })
      .then((result) => setWasteAlerts((result?.data || result)?.expired_items || []))
      .catch(() => {});
  };

  const completeSale = async (payments, printReceipt = true) => {
    if (saleSubmittingRef.current || !cart.length || stockChecking || discountLoading || !checkoutReadyRef.current) return;
    saleSubmittingRef.current = true;
    let saleCommitted = false;
    setMobileCartOpen(false);
    // Close the payment dialog before the async request so a cleared cart can
    // never leave a stale 0 UZS payment window on screen after a successful sale.
    setPayOpen(false);
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
      if (takeawayOrder && (takeawayDirty || takeawayOrder.state !== 'occupied')) {
        throw new Error('Buyurtmani saqlang va to‘lovni qayta oching.');
      }
      if (!selectedTable && !takeawayOrder && !takeawayRequestIdRef.current && !discountCode && roundingTarget === null) {
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
        if (selectedTable || takeawayOrder || takeawayRequestIdRef.current) throw new Error('Saqlangan buyurtmani internet orqali to‘lash kerak. Savat saqlanib turadi.');
        if (!pendingRecord) {
          throw new Error('Chegirmali savdoni offline saqlab bo‘lmaydi. Internetni kuting.');
        }
        await enqueueOfflineSale(pendingRecord);
        saleCommitted = true;
        finishQueuedSale(pendingRecord, printReceipt);
        return;
      }

      const request = pendingRecord?.request || {
        action: 'complete_sale',
        shift_id: shift.id,
        ...(takeawayOrder ? { takeaway_order_id: takeawayOrder.id, takeaway_order_revision: takeawayOrder.revision } : {}),
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
        saleCommitted = true;
        applyCompletedSale(payload, printReceipt);
      } catch (error) {
        if (saleCommitted || !pendingRecord || !isRetryableSyncError(error)) throw error;
        await enqueueOfflineSale(pendingRecord);
        saleCommitted = true;
        finishQueuedSale(pendingRecord, printReceipt);
      }
    } catch (error) {
      if (saleCommitted) {
        setPayOpen(false);
        console.error('Completed sale presentation failed:', error);
        void odinaAlert('Savdo saqlandi. Chek oynasini ochishda xato yuz berdi. Qayta pul olmang; Savdolar tarixidan tekshiring.');
        return;
      }
      setPayOpen(true);
      const message = syncErrorMessage(error);
      const discountHint = (discountCode || roundingTarget !== null || selectedTable || takeawayOrder) && isRetryableSyncError(error)
        ? ' Natija noaniq bo‘lishi mumkin. To‘lov oynasi qayta ochildi; avval Savdolar tarixini tekshiring, keyin kerak bo‘lsa shu tugmani yana bosing.'
        : '';
      void odinaAlert(`Savdoni yakunlab bo‘lmadi: ${message}${discountHint}`);
    } finally {
      saleSubmittingRef.current = false;
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
    if (!shift?.id) {
      await loadAll().catch(() => {});
      void odinaAlert('Ochiq smena topilmadi. Kassani yangilab, qayta urinib ko‘ring.');
      return;
    }
    try {
      const currentShift = await base44.entities.Shift.get(shift.id);
      if (!currentShift || currentShift.status !== 'open') {
        await loadAll().catch(() => {});
        void odinaAlert('Bu smena allaqachon yopilgan yoki boshqa joyda o‘zgargan. Kassani yangilang.');
        return;
      }
      setShift(currentShift);
      setShiftToClose(currentShift);
      setCloseShiftOpen(true);
    } catch (error) {
      void odinaAlert('Smenani tekshirib bo‘lmadi: ' + (error?.message || error));
    }
  };

  const closeShift = async ({ actual_cash, budget_cash_submitted, cash_left_for_next_shift }) => {
    if (closingShiftRef.current) return;
    const shiftId = shiftToClose?.id;
    if (!shiftId) {
      setCloseShiftOpen(false);
      await loadAll().catch(() => {});
      void odinaAlert('Smena ma’lumoti yangilandi. Qayta ochib, yopishni tasdiqlang.');
      return;
    }
    if (!isOnline || offlineSales.some((record) => record.shift_id === shiftId)) {
      void odinaAlert('Smenani yopishdan oldin offline savdolarni serverga yuboring.');
      return;
    }
    closingShiftRef.current = true;
    setShiftLoading(true);
    try {
      const result = await base44.functions.invoke('shift-close-v2', {
        action: 'close_shift',
        shift_id: shiftId,
        actual_cash,
        budget_cash_submitted,
        cash_left_for_next_shift,
      });
      const payload = result?.data || result;
      if (!payload?.shift) throw new Error(payload?.error || 'Smenani yopib bo‘lmadi.');
      setShiftReport(payload.shift);
      setShift(null);
      setCloseShiftOpen(false);
      setShiftToClose(null);
    } catch (e) {
      const message = e?.response?.data?.error || e?.data?.error || e?.message || String(e);
      if (e?.response?.status === 409) {
        setCloseShiftOpen(false);
        setShiftToClose(null);
        await loadAll().catch(() => {});
      }
      void odinaAlert('Smenani yopib bo‘lmadi: ' + message);
    } finally {
      closingShiftRef.current = false;
      setShiftLoading(false);
    }
  };

  const recordCashWithdrawal = async ({ amount, reason, expense_category, recipient_id, recipient_name, owner_pin }) => {
    if (!shift || cashWithdrawalSubmittingRef.current) return;
    if (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      void odinaAlert('Kassadan pul olishni saqlash uchun internet kerak.');
      return;
    }
    const isDebtPayment = expense_category === 'goods_payment';
    const fingerprint = JSON.stringify([shift.id, amount, reason, expense_category, recipient_id || '', recipient_name || '']);
    if (cashWithdrawalRequestRef.current && cashWithdrawalRequestRef.current.fingerprint !== fingerprint) {
      void odinaAlert('Avvalgi pul operatsiyasi natijasini tekshiring. Uni boshqa summa bilan takrorlamang; avvalgi summa va izoh bilan qayta tekshiring.');
      return;
    }
    if (!isDebtPayment && !cashWithdrawalRequestRef.current) {
      cashWithdrawalRequestRef.current = { key: createSaleIdempotencyKey(), fingerprint };
    }
    cashWithdrawalSubmittingRef.current = true;
    setCashWithdrawalLoading(true);
    try {
      const result = await base44.functions.invoke(isDebtPayment ? 'supplier-ledger' : 'complete-sale', isDebtPayment ? {
        action: 'pay_debt',
        shift_id: shift.id,
        supplier_id: recipient_id,
        amount,
        notes: reason,
        owner_pin,
      } : {
        action: 'cash_withdrawal',
        idempotency_key: cashWithdrawalRequestRef.current.key,
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
      cashWithdrawalRequestRef.current = null;
      setCashWithdrawalOpen(false);
    } catch (e) {
      const pending = e?.response?.data?.operation_pending || e?.data?.operation_pending;
      if (!pending && !isRetryableSyncError(e)) cashWithdrawalRequestRef.current = null;
      void odinaAlert('Pul olish natijasini tekshiring: ' + (e?.response?.data?.error || e?.data?.error || e?.message || e));
    } finally {
      cashWithdrawalSubmittingRef.current = false;
      setCashWithdrawalLoading(false);
    }
  };

  return (
    <div className={`odina-pos ${posCompact ? 'odina-pos-compact' : ''} flex flex-col w-full max-w-full ${screenMode ? 'h-dvh' : 'h-[calc(100dvh-3.5rem)] lg:h-dvh'} bg-background overflow-x-hidden`}>
      {productOrderOpen && canEditProductOrder && catalogShopId && <ProductOrderDialog
        key={catalogShopId} shopId={catalogShopId}
        shopName={shops.find(shop => shop.id === catalogShopId)?.name || shift?.shop_name || user?.shop_name || 'Do‘kon'}
        products={products} categories={categories} initialCategory={showFav ? 'all' : activeCat}
        onClose={() => setProductOrderOpen(false)} onSaved={acceptProductOrder} />}
      {/* Header */}
      <div className="odina-pos-header flex shrink-0 items-center gap-2 sm:gap-3 px-3 sm:px-6 py-2.5 sm:py-3 border-b border-border bg-card/95 backdrop-blur sticky top-0 z-20">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="odina-store-icon w-9 h-9 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center shrink-0">
            <Building2 className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{shift?.shop_name || 'Faol smena yo‘q'}</div>
            <div className="text-xs text-muted-foreground truncate">
              {shift ? `${Number(shift.order_count || 0) + queuedForCurrentShift.length} ta buyurtma` : 'Savdoni boshlash uchun smenani oching'}
            </div>
          </div>
        </div>
        <div className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={togglePosCompact}
          aria-pressed={Boolean(posCompact)} aria-label="Ixcham kassa ko‘rinishi"
          title={posCompact ? 'Oddiy ko‘rinishga qaytish' : 'Ixcham ko‘rinishga o‘tish'}
          className="hidden lg:inline-flex h-11 shrink-0 rounded-xl px-3 touch-manipulation">
          {posCompact ? 'Ixcham ✓' : 'Ixcham'}
        </Button>
        {canEditProductOrder && <Button type="button" variant="outline" size="icon"
          title={catalogShopId ? 'Mahsulotlar tartibini tahrirlash' : 'Avval do‘kon smenasini oching'}
          aria-label="Mahsulotlar tartibini tahrirlash" disabled={!catalogShopId || loadingData}
          onClick={() => setProductOrderOpen(true)} className="h-11 w-10 shrink-0 rounded-xl touch-manipulation">
          <ListOrdered className="h-4 w-4" />
        </Button>}
        {!screenMode && <Button asChild variant="outline" size="sm"
          className="inline-flex h-10 w-10 shrink-0 rounded-xl border-brand-olive/50 bg-brand-olive/10 px-0 font-semibold text-brand-ink hover:bg-brand-olive/20 touch-manipulation">
          <a href={`${window.location.origin}/pos?screen=1`} target="_blank" rel="noopener noreferrer" aria-label="Ekranlar — kassani yangi oynada ochish" title="Ekranlar">
            <Monitor className="h-4 w-4" />
          </a>
        </Button>}
        <Button type="button" variant="outline" size="sm" onClick={() => void goToTables()}
          aria-label="Stollar sahifasini ochish" title="Stollar"
          className="inline-flex h-10 w-10 shrink-0 rounded-xl border-brand-olive/50 bg-brand-olive/10 px-0 font-semibold text-brand-ink hover:bg-brand-olive/20 touch-manipulation">
          <Armchair className="h-4 w-4" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setSalesHistoryOpen(true)}
          aria-label="Savdolar tarixini ochish" title="Savdolar tarixi"
          className="inline-flex h-10 w-10 shrink-0 rounded-xl px-0 font-semibold touch-manipulation">
          <ReceiptText className="h-4 w-4" />
        </Button>
        {shift ? (
          <>

            <Button variant="outline" size="sm" aria-label="Kassadan pul olish" title="Pul olish" onClick={() => setCashWithdrawalOpen(true)} className="h-10 w-10 shrink-0 rounded-xl p-0 touch-manipulation">
              <Banknote className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" aria-label="Smenani yopish" title="Smenani yopish" onClick={requestCloseShift} disabled={offlineSyncing} className="h-10 w-10 shrink-0 rounded-xl p-0 touch-manipulation">
              <Clock className="w-4 h-4" />
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => setOpenShiftOpen(true)} className="h-10 bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            Smenani ochish
          </Button>
        )}
      </div>


      {!selectedTable && Number.isInteger(location.state?.savedTableNumber) && (
        <div role="status" className="mx-3 sm:mx-5 mt-3 flex shrink-0 items-center gap-3 rounded-2xl border border-brand-olive/40 bg-brand-olive/10 px-4 py-3 text-sm">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-ink" aria-hidden="true" />
          <p className="flex-1"><strong>{location.state.savedTableNumber}-stol buyurtmasi saqlandi.</strong> To‘lov olinmadi. Kassa yangi buyurtmaga tayyor.</p>
          <Button type="button" variant="outline" onClick={() => setStaffTicket({
            mode: 'table', shopId: location.state.savedShopId || shift?.shop_id,
            shop: shops.find((item) => item.id === (location.state.savedShopId || shift?.shop_id)),
            tableNumber: location.state.savedTableNumber,
          })} className="min-h-11 shrink-0 rounded-xl text-xs font-semibold">
            <ReceiptText className="h-4 w-4 mr-1.5" /> Xizmat cheki
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Saqlash xabarini yopish"
            onClick={() => navigate(posHomePath, { replace: true, state: null })} className="h-11 w-11 shrink-0 rounded-xl"><X className="h-4 w-4" /></Button>
        </div>
      )}

      <OfflineSalesBanner
        isOnline={isOnline}
        records={offlineSales}
        syncing={offlineSyncing}
        storageError={offlineStorageError}
        syncError={offlineSyncError}
        onRetry={syncOfflineSales}
      />

      {(selectedTable || tableQuery.invalid) && (
        <div className="mx-3 sm:mx-5 mt-3 shrink-0 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-brand-olive/40 bg-brand-olive/10 p-3 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <Armchair className="w-5 h-5 text-brand-ink shrink-0" />
            <div><strong>{selectedTable ? `${selectedTable.number}-stol · ${tableShop?.name || 'Do‘kon'}` : 'Stol tanlanmagan'}</strong>
              <p className="text-xs text-muted-foreground">{tableOrderLoading ? 'Buyurtma yuklanmoqda…' : tableOrder?.state === 'paying' ? 'To‘lov tekshirilmoqda — yangi savdo boshlamang.' : tableOrder ? `Band · to‘lanmagan: ${formatUZS(tableOrder.total)} · ${tableOrder.items?.length || 0} tur` : 'Bo‘sh stol · buyurtma qo‘shib saqlang.'}</p>
              {tableCartDirty && !tableOrderLoading && <p className="text-xs font-semibold text-amber-900">Saqlanmagan o‘zgarishlar bor. Stol almashtirilganda avval serverda saqlanadi.</p>}
              {(tableOrderError || tableSaveError) && <p role="alert" className="text-xs text-destructive">{tableOrderError || tableSaveError}</p>}
              {tableSelectionError && <p role="alert" className="text-xs text-destructive">{tableSelectionError}</p>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void cancelTableSelection()}
              className="min-h-11 rounded-xl border-destructive/40 text-destructive hover:bg-destructive/10 font-semibold px-3.5 touch-manipulation"
              aria-label="Stolni bekor qilish"
            >
              <X className="w-4 h-4 mr-1.5" /> Stolni bekor qilish
            </Button>
            {tableCartDirty && !tableOrderLoading && <Button type="button" variant="outline" className="min-h-11" onClick={() => {
              setCart(tableOrder?.items || []);
              setTableSaveError('');
              setDiscountCode(''); setDiscountPct(0); setRoundingTarget(null); setAdjustmentMode(null);
            }}>Saqlangan holatga qaytish</Button>}
            {tableOrder?.items?.length > 0 && !tableCartDirty && <Button type="button" variant="outline"
              onClick={() => setStaffTicket({ mode: 'table', shop: tableShop, shopId: selectedTable.shopId, tableNumber: selectedTable.number })}
              className="min-h-11 rounded-xl font-semibold text-brand-ink">
              <ReceiptText className="h-4 w-4 mr-1.5" /> Xizmat cheki
            </Button>}
            {tableOrder?.state === 'paying' && <Button type="button" variant="outline" className="min-h-11 border-amber-500" onClick={() => void reconcileTablePayment()}>To‘lovni tekshirish</Button>}
            {(tableOrderError || tableSaveError) && <Button type="button" variant="outline" className="min-h-11" onClick={async () => {
              if (tableCartDirty && !(await odinaConfirm('Saqlanmagan savat o‘chadi. Serverdagi buyurtmani qayta yuklaysizmi?'))) return;
              setTableReload((current) => current + 1);
            }}>Buyurtmani yangilash</Button>}
            {Boolean(selectedTable && (tableOrder?.items?.length || cart.length)) && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 rounded-xl border-brand-olive/50 bg-card text-brand-ink font-semibold touch-manipulation"
                onClick={() => setStaffTicket({
                  mode: 'table',
                  shop: tableShop,
                  shopId: selectedTable.shopId,
                  tableNumber: selectedTable.number,
                  order: tableOrder,
                })}
              >
                <UtensilsCrossed className="w-4 h-4 mr-1.5" /> Xizmat cheki
              </Button>
            )}
            <Button type="button" variant="outline" className="min-h-11" onClick={() => void goToTables()}><ArrowLeft className="w-4 h-4 mr-1" /> Stollar xaritasi</Button>
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
          <div className="odina-category-rail hidden md:flex w-36 shrink-0 border-r border-border bg-sidebar/50 flex-col py-3 overflow-y-auto scrollbar-thin">
            <p className="odina-category-title">KATEGORIYALAR</p>
            <CatTab active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }} icon={<Search className="w-4 h-4" />} label="Barchasi" />
            <CatTab active={showFav} onClick={() => setShowFav(true)} icon={<Star className="w-4 h-4" />} label="Sevimlilar" />
            <div className="h-px bg-border my-2 mx-3" />
            {categories.map((c) => (
              <CatTab key={c.id} active={activeCat === c.id && !showFav} onClick={() => { setActiveCat(c.id); setShowFav(false); }} icon={<CategoryIcon icon={c.icon} className="text-base" imgClassName="w-5 h-5" />} label={c.name.replaceAll('&', ' & ')} />
            ))}
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            {/* Search + mobile categories */}
            <div className="odina-pos-search px-4 sm:px-5 pt-4 pb-2 space-y-3">
              <div className="odina-catalog-toolbar">
                <h1>Mahsulotlar</h1>
                <div className="odina-catalog-search relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input aria-label="Mahsulotlarni qidirish" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Mahsulotlarni qidirish…" className="pl-9 h-11 rounded-xl" />
                </div>
                {!loadingData && <span className="odina-catalog-count">{filtered.length} ta mahsulot</span>}
              </div>
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 md:hidden">
                <Chip active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }}>Barchasi</Chip>
                <Chip active={showFav} onClick={() => setShowFav(true)}>★ Sevimlilar</Chip>
                {categories.map((c) => (
                  <Chip key={c.id} active={activeCat === c.id && !showFav} onClick={() => { setActiveCat(c.id); setShowFav(false); }}>{c.name.replaceAll('&', ' & ')}</Chip>
                ))}
              </div>
            </div>

            <div className="odina-product-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-4 sm:px-5 pb-20 lg:pb-6">
              {loadingData ? (
                <div className="odina-product-grid grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5">
                  {Array.from({ length: 8 }).map((_, i) => <div key={i} className="aspect-[3/4] rounded-2xl bg-secondary animate-pulse" />)}
                </div>
              ) : filtered.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-20">
                  <div className="text-5xl mb-3">🧁</div>
                  <p className="text-sm font-medium text-muted-foreground">Mahsulot topilmadi</p>
                </div>
              ) : (
                <div className="odina-product-grid grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2.5">
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
        <div className="odina-cart-wrap hidden lg:flex w-[340px] xl:w-[380px] 2xl:w-[420px] min-w-0 shrink-0 border-l border-border overflow-hidden">
          <Cart
            cart={cart}
            selectedProductId={cart.some((row) => row.product_id === keyboardProductId) ? keyboardProductId : cart[cart.length - 1]?.product_id}
            onSelectItem={(item) => setKeyboardProductId(item.product_id)}
            onInc={inc} onDec={dec} onRemove={removeItem} onClear={clearCart}
            subtotal={subtotal} discount={discount} couponDiscount={couponDiscount} discountCode={discountCode}
            onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError}
            roundingTarget={roundingTarget} adjustmentMode={adjustmentMode} roundingError={roundingError}
            onApplyRounding={applyRounding} onApplyManualDiscount={applyManualDiscount}
            onRemoveRounding={() => { setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); }}
            total={total} onCheckout={openCheckout} disabled={!shift || Boolean(tableSelectionError)}
            takeawayOrder={takeawayOrder} onServiceTicket={!selectedTable ? showTakeawayTicket : undefined}
            onOpenOrders={!selectedTable ? loadOpenOrders : undefined} onLeaveTakeaway={leaveTakeaway}
            savingTakeaway={takeawaySaving}
            tableMode={Boolean(selectedTable)} tableDirty={tableCartDirty} tableSaved={Boolean(tableOrder?.id)}
            onSaveTable={() => void saveAndStartNextOrder()} onCancelTable={() => void cancelTableSelection()} savingTable={savingTable} locked={tableLocked || paying || payOpen || stockChecking}
          />
        </div>
      </div>

      {/* Telefon va iPad uchun doim ko‘rinadigan buyurtma paneli */}
      <div className={`lg:hidden fixed left-0 ${screenMode ? '' : sidebarCollapsed ? 'lg:left-20' : 'lg:left-64'} right-0 bottom-0 z-40 px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] bg-card/95 backdrop-blur border-t border-border transition-[left] duration-200`}>
        <Button onClick={() => setMobileCartOpen(true)} className="w-full min-h-12 h-12 px-4 py-2 whitespace-nowrap text-sm sm:text-base font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong premium-shadow-lg touch-manipulation">
          Buyurtma · {formatUZS(total)} ({cart.reduce((s, i) => s + (i.sale_unit === 'gram' ? 1 : i.quantity), 0)} ta)
        </Button>
      </div>

      <Sheet open={mobileCartOpen && compactCartViewport} onOpenChange={setMobileCartOpen}>
        <SheetContent side="bottom" className="odina-cart-sheet lg:hidden h-[88dvh] p-0 rounded-t-[28px] overflow-hidden">
          <SheetTitle className="sr-only">Joriy buyurtma</SheetTitle>
          <Cart
            cart={cart}
            selectedProductId={cart.some((row) => row.product_id === keyboardProductId) ? keyboardProductId : cart[cart.length - 1]?.product_id}
            onSelectItem={(item) => setKeyboardProductId(item.product_id)}
            onInc={inc} onDec={dec} onRemove={removeItem} onClear={clearCart}
            subtotal={subtotal} discount={discount} couponDiscount={couponDiscount} discountCode={discountCode}
            onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError}
            roundingTarget={roundingTarget} adjustmentMode={adjustmentMode} roundingError={roundingError}
            onApplyRounding={applyRounding} onApplyManualDiscount={applyManualDiscount}
            onRemoveRounding={() => { setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); }}
            total={total} onCheckout={() => { setMobileCartOpen(false); void openCheckout(); }} disabled={!shift || Boolean(tableSelectionError)}
            takeawayOrder={takeawayOrder} onServiceTicket={!selectedTable ? showTakeawayTicket : undefined}
            onOpenOrders={!selectedTable ? loadOpenOrders : undefined} onLeaveTakeaway={leaveTakeaway}
            savingTakeaway={takeawaySaving}
            tableMode={Boolean(selectedTable)} tableDirty={tableCartDirty} tableSaved={Boolean(tableOrder?.id)}
            onSaveTable={() => void saveAndStartNextOrder()} onCancelTable={() => void cancelTableSelection()} savingTable={savingTable} locked={tableLocked || paying || payOpen || stockChecking}
          />
        </SheetContent>
      </Sheet>

      <Dialog open={openOrdersOpen} onOpenChange={setOpenOrdersOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>Ochiq buyurtmalar · Olib ketish</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">To‘lanmagan buyurtmalar. To‘lov uchun buyurtmani oching.</p>
          <Button variant="outline" onClick={loadOpenOrders} disabled={openOrdersLoading}>Yangilash</Button>
          {openOrdersError && <p role="alert" className="text-sm text-destructive">{openOrdersError}</p>}
          {openOrdersLoading ? <p>Yuklanmoqda…</p> : openOrders.length === 0 && !openOrdersError ? <p>Ochiq buyurtma yo‘q.</p> : (
            <div className="space-y-3">{openOrders.map((order) => (
              <div key={order.id} className="rounded-xl border border-brand-sand/50 p-3 space-y-2">
                <div className="flex justify-between gap-2 font-semibold">
                  <span>Buyurtma #{order.ticket_number}</span><span>{formatUZS(order.total)}</span>
                </div>
                <p className="text-xs text-muted-foreground">{formatUzbekistanDateTime(order.started_at)} · {order.opened_by_name}</p>
                <p className="text-sm break-words">{order.items.map((row) => row.product_name + ' × ' + row.quantity + (row.sale_unit === 'gram' ? ' g' : '')).join(', ')}</p>
                <p className="text-xs font-semibold">{order.state === 'paying' ? 'To‘lov tekshirilmoqda — qayta pul olmang' : 'To‘lanmagan'}</p>
                <div className="flex gap-2">
                  <Button className="min-h-11 flex-1" onClick={() => order.state === 'paying' ? reconcileTakeaway(order) : openTakeaway(order)} disabled={openOrdersLoading}>
                    {order.state === 'paying' ? 'To‘lovni tekshirish' : 'Ochish · To‘lov'}
                  </Button>
                  <Button variant="outline" className="min-h-11" onClick={() => {
                    setOpenOrdersOpen(false);
                    setStaffTicket({ mode: 'takeaway', order, shop: shops.find((row) => row.id === (shift?.shop_id || user?.shop_id)) });
                  }}>Xizmat cheki</Button>
                </div>
              </div>
            ))}</div>
          )}
        </DialogContent>
      </Dialog>
      <PosTablePicker
        open={tablePickerOpen}
        onOpenChange={setTablePickerOpen}
        activeShopId={shift?.shop_id || user?.shop_id}
        onSelect={(shopId, number, payDirect) => { void selectTableFromPicker(shopId, number, payDirect); }}
      />
      <Dialog open={Boolean(weightProduct)} onOpenChange={(open) => !open && setWeightProduct(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{weightProduct?.name} — gramm</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">1 kg: {formatUZS(weightProduct?.price || 0)}</p>
          <Input autoFocus type="number" inputMode="numeric" min="1" max="1000000" step="1"
            aria-label="Og‘irlik (gramm)" placeholder="Masalan: 250" value={grams}
            onChange={(e) => setGrams(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveWeight(); }} />
          <p className="text-lg font-bold">Summa: {formatUZS(Math.round((weightProduct?.price || 0) * (Number(grams) || 0) / 1000))}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWeightProduct(null)}>Bekor qilish</Button>
            <Button onClick={saveWeight} disabled={!Number.isSafeInteger(Number(grams)) || Number(grams) < 1 || Number(grams) > 1000000}>
              {weightProduct?.editing ? 'Saqlash' : 'Qo‘shish'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PaymentModal
        open={payOpen && cart.length > 0 && !paying}
        total={total}
        checking={stockChecking}
        discountPending={discountLoading}
        discountControls={
          <fieldset disabled={paying || stockChecking || discountLoading} className="min-w-0 space-y-2.5 disabled:opacity-60">
            <DiscountRow discountCode={discountCode} discount={couponDiscount}
              onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError} />
            <RoundingRow subtotal={subtotal} discountCode={discountCode}
              roundingTarget={roundingTarget} adjustmentMode={adjustmentMode} roundingError={roundingError}
              onApplyRounding={applyRounding} onApplyManualDiscount={applyManualDiscount}
              onRemoveRounding={() => { setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); }} />
          </fieldset>
        }
        onClose={closePayment}
        onConfirm={completeSale}
        loading={paying}
        offline={checkoutOffline || (!isOnline && !selectedTable && !takeawayOrder)}
        fullDiscount={discountPct === 100 && subtotal > 0 && total === 0}
      />
      <Dialog open={salesHistoryOpen} onOpenChange={setSalesHistoryOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-6xl max-h-[90dvh] flex flex-col overflow-hidden p-4 sm:p-6">
          <DialogHeader className="shrink-0 border-b border-border pb-4 pr-12">
            <DialogTitle className="font-display text-xl flex items-center gap-2">
              <ReceiptText className="h-5 w-5 text-brand-ink" /> Savdolar tarixi
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {salesHistoryOpen && <SalesHistory embedded />}
          </div>
        </DialogContent>
      </Dialog>
      <ShiftReport shift={shiftReport} onAfterPrint={() => setShiftReport(null)} />
      <Receipt
        sale={receiptPrintSale}
        settings={settings}
        print={!!receiptPrintSale}
        onAfterPrint={finishSalePresentation}
      />
      <Dialog open={!!staffTicketPrompt} onOpenChange={(open) => !open && setStaffTicketPrompt(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">
              Olib ketish buyurtmasi uchun xizmat cheki kerakmi?
            </DialogTitle>
          </DialogHeader>
          <DialogFooter className="flex flex-row gap-2">
            <Button type="button" variant="outline" onClick={() => setStaffTicketPrompt(null)}
              className="min-h-11 flex-1">
              Yo‘q
            </Button>
            <Button type="button" onClick={() => {
              const sale = staffTicketPrompt;
              setStaffTicketPrompt(null);
              setStaffTicket({ mode: 'sale', order: sale, autoPrint: true });
            }} className="min-h-11 flex-1 bg-primary text-primary-foreground hover:bg-primary-strong">
              Chop etish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <StaffOrderTicketModal open={!!staffTicket} onClose={() => setStaffTicket(null)}
        mode={staffTicket?.mode} order={staffTicket?.order} shop={staffTicket?.shop}
        shopId={staffTicket?.shopId} tableNumber={staffTicket?.tableNumber} autoPrint={staffTicket?.autoPrint} />
      <OpenShiftDialog open={openShiftOpen} shops={shops} user={user} onClose={() => setOpenShiftOpen(false)} onConfirm={openShift} loading={shiftLoading} />
      <CloseShiftDialog open={closeShiftOpen} shift={shiftToClose} onClose={() => { setCloseShiftOpen(false); setShiftToClose(null); }} onConfirm={closeShift} loading={shiftLoading} />
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