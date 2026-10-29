import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { loadOperationalSettings } from '@/lib/operational-config';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';
import { orderRequestScope, readOrderRequest, retainOrderRequest, clearOrderRequest } from '@/lib/order-request-retry';
import { AlertTriangle, Search, Star, Clock, Building2, Banknote, RefreshCw, Armchair, ArrowLeft, CheckCircle2, X, ReceiptText, UtensilsCrossed, Monitor, ListOrdered } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/use-toast';
import { formatUZS } from '@/lib/pos';
import { fetchCurrentPosShift, openPosShift, invokePosRead } from '@/lib/current-pos-shift';
import { priceForShop } from '@/lib/shop-pricing';
import { canPreviewBurgerFries, repriceBurgerCartForShop, saleLineKey, friesOptionFields, friesSurcharge, burgerOptionName, FRIES_SURCHARGE } from '@/lib/burger-fries';
import { categoryForShop, catalogForShop } from '@/lib/shop-category';
import { formatUzbekistanDateTime } from '@/lib/uzbekistan-time';
import ProductGrid from '@/components/pos/ProductGrid';
import PaymentSavingStatus from '@/components/pos/PaymentSavingStatus';
import CheckoutTimingStatus from '@/components/pos/CheckoutTimingStatus';
import CheckoutTimingHistory from '@/components/pos/CheckoutTimingHistory';
import useCheckoutTiming from '@/hooks/useCheckoutTiming';
import { createCheckoutTimingEventId, reportCheckoutTiming, flushCheckoutTimings } from '@/lib/checkout-timing-outbox';
import useStableEvent from '@/hooks/use-stable-event';
import { mergePosStockEvent } from '@/lib/pos-stock-events';
import ProductOrderDialog from '@/components/pos/ProductOrderDialog';
import usePosProductOrder from '@/hooks/usePosProductOrder';
import { sortByShopOrder } from '@/lib/pos-product-order';
import { preloadPosThumbnails } from '@/lib/pos-thumbnail-preload';
import Cart, { DiscountRow, RoundingRow } from '@/components/pos/Cart';
import PaymentModal from '@/components/pos/PaymentModal';
import TakeawayCancelAction from '@/components/pos/TakeawayCancelAction';
import SalesHistory from '@/pages/SalesHistory';
import Receipt from '@/components/pos/Receipt';
import ShiftReport from '@/components/pos/ShiftReport';
import StaffOrderTicketModal from '@/components/tables/StaffOrderTicketModal';
import { isStaffTicketEnabled } from '@/lib/staff-order-ticket';
import PosTablePicker from '@/components/tables/PosTablePicker';
import { OpenShiftDialog, CloseShiftDialog } from '@/components/pos/ShiftDialog';
import { OwnerPinDialog, CashWithdrawalDialog } from '@/components/pos/KassaActionDialogs';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import useOfflineSaleQueue from '@/hooks/useOfflineSaleQueue';
import { canQueuePosSale, isPosNetworkError } from '@/lib/pos-network';
import { readPosRestart, savePosRestart, readShiftRestart, saveShiftRestart, restartCatalog, restartRead } from '@/lib/offline-restart';
import OfflineRestartStatus from '@/components/pos/OfflineRestartStatus';
import OfflineSalesBanner from '@/components/pos/OfflineSalesBanner';
import CategoryIcon from '@/components/CategoryIcon';
import '@/components/pos/pos-workbench.css';
import {
  POS_CHECKOUT_RESPONSE_BUDGET_MS,
  POS_PROTECTED_CHECKOUT_RESPONSE_BUDGET_MS,
  buildPendingSale,
  createSaleIdempotencyKey,
  isRetryableSyncError,
  syncErrorMessage,
  startSaleRequest,
  waitForSaleResponse,
  releaseSaleRequest,
} from '@/lib/offline-sales';

// Temporary business choice: sell through without the negative-stock confirmation.
// Set to true when the owner wants the warning restored.
const SHOW_NEGATIVE_STOCK_CONFIRMATION = false;

export default function POS() {
  const { user, sidebarCollapsed, screenMode, posCompact, togglePosCompact, adminShopScope } = useOutletContext();
  const shopScope = user?.role === 'admin' && adminShopScope?.isAdmin ? adminShopScope : null;
  const scopedShopId = shopScope?.specificShopId || '';
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
  const [isDelivery, setIsDelivery] = useState(false);
  const [keyboardProductId, setKeyboardProductId] = useState(null);
  const [weightProduct, setWeightProduct] = useState(null);
  const [burgerProduct, setBurgerProduct] = useState(null);
  const [grams, setGrams] = useState('');
  const [shops, setShops] = useState([]);
  const [shift, setShift] = useState(null);
  const scopedShop = shopScope?.shops?.find((row) => row.id === scopedShopId);
  const posScopeReadOnly = Boolean(shopScope && (!shopScope.ready || !scopedShopId
    || !scopedShop || scopedShop.location_type === 'production' || scopedShop.allows_pos === false
    || (shift && shift.shop_id !== scopedShopId)));
  const [shiftReadState, setShiftReadState] = useState('loading');
  const shiftMutationRef = useRef(0);
  const shiftReadGenerationRef = useRef(0);
  const [settings, setSettings] = useState(null);
  const [cashRecipients, setCashRecipients] = useState([]);
  const [supplierDebts, setSupplierDebts] = useState({});
  const [cashDataLoading, setCashDataLoading] = useState(true);
  const [cashDataError, setCashDataError] = useState('');
  const loadGenerationRef = useRef(0);
  const wasteAlertGenerationRef = useRef(0);
  const [loadingData, setLoadingData] = useState(true);
  const [restartSaved, setRestartSaved] = useState(false);
  const [restartError, setRestartError] = useState('');
  const [catalogOffline, setCatalogOffline] = useState(false);
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
  const [checkoutTimingHistoryOpen, setCheckoutTimingHistoryOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const { timing: lastCheckoutTiming, recordTiming: recordCheckoutTiming } = useCheckoutTiming(user?.id, shift?.shop_id, shift?.id);
  const timingUserRef = useRef(user?.id || '');
  timingUserRef.current = user?.id || '';
  useEffect(() => {
    const actorId = user?.id || '';
    timingUserRef.current = actorId;
    if (!actorId) return;
    const flush = async () => {
      try {
        let result;
        do {
          result = await flushCheckoutTimings({ userId: actorId,
            send: body => base44.functions.invoke('checkout-timing', body),
            isCurrentUser: () => timingUserRef.current === actorId });
        } while (result?.hasMore && timingUserRef.current === actorId);
      } catch { console.warn('Checkout timing history upload is pending.'); }
    };
    void flush();
    window.addEventListener('online', flush);
    return () => { timingUserRef.current = ''; window.removeEventListener('online', flush); };
  }, [user?.id]);
  const saleSubmittingRef = useRef(false);
  const [checkoutOffline, setCheckoutOffline] = useState(false);
  const checkoutRequestKeyRef = useRef('');
  const checkoutRecordedAtRef = useRef('');
  const checkoutAttemptRef = useRef(null);
  const checkoutSessionRef = useRef({ userId: user?.id });
  if (checkoutSessionRef.current.userId !== user?.id) checkoutSessionRef.current = { userId: user?.id };
  const reconciledSaleKeysRef = useRef(new Set());
  const stockReadGenerationRef = useRef(0);
  const confirmedStockRef = useRef(new Map());
  const confirmedStockReadsRef = useRef(new Map());
  const latestStockSaleRef = useRef(new Map());
  const stockUserRef = useRef(user?.id);
  stockUserRef.current = user?.id;
  const [confirmedStockReservations, setConfirmedStockReservations] = useState([]);
  const [checkoutRetryPending, setCheckoutRetryPending] = useState(false);
  const [receiptPrintSale, setReceiptPrintSale] = useState(null);
  const [shiftReport, setShiftReport] = useState(null);
  const [staffTicket, setStaffTicket] = useState(null);
  const [takeawayOrder, setTakeawayOrder] = useState(null);
  const [takeawaySaving, setTakeawaySaving] = useState(false);
  const takeawaySavingRef = useRef(false);
  const takeawayRequestIdRef = useRef('');
  const [openOrdersOpen, setOpenOrdersOpen] = useState(false);
  const [openOrders, setOpenOrders] = useState([]);
  const [openOrdersLoading, setOpenOrdersLoading] = useState(false);
  const [openOrdersError, setOpenOrdersError] = useState('');
  const [cancellingTakeawayId, setCancellingTakeawayId] = useState('');
  const cancellingTakeawayRef = useRef(false);
  const [takeawayCancelError, setTakeawayCancelError] = useState(null);
  const takeawayDirty = Boolean(takeawayOrder) && (isDelivery !== (takeawayOrder.is_delivery === true)
    || JSON.stringify(cart.map((row) => ({ key: saleLineKey(row), quantity: row.quantity })))
      !== JSON.stringify((takeawayOrder.items || []).map((row) => ({ key: saleLineKey(row), quantity: row.quantity }))));

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
  // Match the cart dock/sheet viewport, including tablets and window resizing.
  const [compactCartViewport, setCompactCartViewport] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1279px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1279px)');
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
  const [verifiedTableShop, setVerifiedTableShop] = useState(null);
  const [tableOrderError, setTableOrderError] = useState('');
  const [tableSaveError, setTableSaveError] = useState('');
  const [savingTable, setSavingTable] = useState(false);
  const savingTableRef = useRef(false);
  const [tableReload, setTableReload] = useState(0);
  const scopeWorkPending = cart.length > 0 || Boolean(selectedTable || takeawayOrder || takeawayRequestIdRef.current)
    || paying || payOpen || stockChecking || savingTable || takeawaySaving || checkoutRetryPending
    || shiftLoading || cashWithdrawalLoading || Boolean(cancellingTakeawayId);
  useEffect(() => shopScope?.registerGuard?.(() => scopeWorkPending
    ? 'Do‘konni almashtirishdan oldin joriy savat yoki ochiq buyurtmani yakunlang yoki saqlab yoping. Amal bajarilayotgan bo‘lsa, tugashini kuting.' : ''),
  [shopScope?.registerGuard, scopeWorkPending]);

  // Do not accidentally carry an unsaved cart from one table to another when
  // only the URL changes and React keeps the POS component mounted.
  useEffect(() => {
    if (priorTableKey.current === tableKey) return;
    priorTableKey.current = tableKey;
    setTakeawayOrder(null);
    takeawayRequestIdRef.current = '';
    setIsDelivery(false);
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
    if (shopScope && selectedTable.shopId !== scopedShopId) {
      setTableOrder(null); setCart([]); setTableOrderLoading(false);
      setTableOrderError('Stol boshqa do‘konga tegishli. Shu do‘konni yuqoridan tanlang.');
      return undefined;
    }
    let active = true;
    setTableOrderLoading(true);
    setTableOrderError('');
    setTableSaveError('');
    base44.functions.invoke('restaurant-tables', {
      action: 'get_table_order', shop_id: selectedTable.shopId, table_number: selectedTable.number,
    }).then(async (response) => {
      if (!active) return;
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Stol buyurtmasi yuklanmadi.');
      // Use the same authorized source that validated and loaded this table.
      // The general Shop list may be stale or omitted by entity read permissions.
      let verifiedShop = result.shop;
      if (!verifiedShop) {
        const statusResponse = await base44.functions.invoke('restaurant-tables', { action: 'status' });
        const status = statusResponse?.data || statusResponse;
        const currentShop = status?.shops?.find((row) => row.id === selectedTable.shopId);
        if (currentShop) verifiedShop = { id: currentShop.id, name: currentShop.name, restaurant_table_count: currentShop.table_count };
      }
      if (!active) return;
      if (verifiedShop?.id !== selectedTable.shopId) throw new Error('Stol do‘konini tekshirib bo‘lmadi. Xaritani yangilang.');
      setVerifiedTableShop({ key: tableKey, shop: verifiedShop });
      setTableOrder(result.order || null);
      setCart(result.order?.items || []);
      setDiscountCode(''); setDiscountPct(0); setDiscountOwnerPin('');
      setRoundingTarget(null); setAdjustmentMode(null);
    }).catch((error) => {
      if (active) setTableOrderError(error?.response?.data?.error || error?.data?.error || error?.message || 'Buyurtmani yuklab bo‘lmadi.');
    }).finally(() => { if (active) setTableOrderLoading(false); });
    return () => { active = false; };
  }, [tableKey, tableReload, scopedShopId, Boolean(shopScope)]);

  const tableCartDirty = Boolean(selectedTable) && (
    cart.length !== (tableOrder?.items?.length || 0)
    || cart.some((row) => {
      const saved = tableOrder?.items?.find((item) => saleLineKey(item) === saleLineKey(row));
      return !saved || saved.quantity !== row.quantity || saved.price !== row.price;
    })
  );
  const tableLocked = posScopeReadOnly || checkoutRetryPending || takeawaySaving || takeawayOrder?.state === 'paying'
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
    if (posScopeReadOnly) return false;
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
          ...friesOptionFields(row),
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
    if (posScopeReadOnly) return null;
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
        is_delivery: isDelivery,
        items: cart.map((row) => ({ product_id: row.product_id, quantity: row.quantity, ...friesOptionFields(row),
          variant_name: row.variant_name || row.variant || '', notes: row.notes || '' })),
      });
      const result = response?.data || response;
      if (!result?.ok || !result.order?.id) throw new Error(result?.error || 'Buyurtma saqlanmadi.');
      setTakeawayOrder(result.order);
      setIsDelivery(result.order.is_delivery === true);
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
    if (!isStaffTicketEnabled(shift?.shop_id || user?.shop_id)) return;
    if (paying || payOpen || stockChecking) return;
    const saved = await saveTakeawayOrder();
    if (!saved) return;
    setMobileCartOpen(false);
    setStaffTicket({ mode: 'takeaway', order: saved, shopId: saved.shop_id || shift.shop_id, shop: shops.find((row) => row.id === (saved.shop_id || shift.shop_id)) });
    setTakeawayOrder(null);
    resetCart();
  };

  const loadOpenOrders = async () => {
    if (posScopeReadOnly) return;
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
    if (posScopeReadOnly) return;
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
      setIsDelivery(result.order.is_delivery === true);
      setCart(result.order.items);
      setOpenOrdersOpen(false);
      setMobileCartOpen(window.matchMedia('(max-width: 1279px)').matches);
    } catch (error) {
      setOpenOrdersError(error?.response?.data?.error || error?.message || 'Buyurtma ochilmadi.');
    } finally { setOpenOrdersLoading(false); }
  };

  const cancelTakeawayOrder = async (order) => {
    const showCancelError = (message) => setTakeawayCancelError({ orderId: order?.id, message });
    if (!order?.id || order.state !== 'occupied' || order.checkout_key
      || cancellingTakeawayRef.current || openOrdersLoading || paying || payOpen || stockChecking
      || takeawaySavingRef.current || savingTableRef.current) return;
    if (!shift || (order.shop_id && order.shop_id !== shift.shop_id)) {
      showCancelError('Bekor qilish uchun shu do‘kondagi smenani oching.');
      return;
    }
    if (!isOnline || navigator.onLine === false) {
      showCancelError('Internet yo‘q. Buyurtma bekor qilinmadi.');
      return;
    }
    cancellingTakeawayRef.current = true;
    takeawaySavingRef.current = true;
    setCancellingTakeawayId(order.id);
    setTakeawaySaving(true);
    setTakeawayCancelError(null);
    setOpenOrdersError('');
    try {
      const response = await base44.functions.invoke('restaurant-tables', {
        action: 'cancel_takeaway_order', shop_id: shift.shop_id, shift_id: shift.id,
        order_id: order.id, expected_revision: order.revision, confirm_cancel: true,
      });
      const result = response?.data || response;
      if (!result?.ok || (!result.cancelled && !result.already_closed)) {
        throw new Error(result?.error || 'Buyurtma bekor qilingani tasdiqlanmadi.');
      }
      setOpenOrders((rows) => rows.filter((row) => row.id !== order.id));
      if (takeawayOrder?.id === order.id) {
        setTakeawayOrder(null);
        resetCart();
        checkoutRequestKeyRef.current = '';
        checkoutRecordedAtRef.current = '';
      }
      if (result.audit_warning) setOpenOrdersError('Buyurtma bekor qilindi. Nusxasi va so‘rov tarixda saqlandi, yakuniy tarix yozuvi tasdiqlanmadi.');
    } catch (error) {
      showCancelError(error?.response?.data?.error || error?.message || 'Buyurtma bekor qilinmadi. Ro‘yxatni yangilab tekshiring.');
    } finally {
      cancellingTakeawayRef.current = false;
      takeawaySavingRef.current = false;
      setCancellingTakeawayId('');
      setTakeawaySaving(false);
    }
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

  const loadCurrentShift = async () => {
    const generation = ++shiftReadGenerationRef.current;
    const mutation = shiftMutationRef.current;
    const ownerId = user?.id;
    const session = checkoutSessionRef.current;
    setShiftReadState('loading');
    try {
      const currentShift = await restartRead(() => fetchCurrentPosShift(base44));
      if (checkoutSessionRef.current !== session || stockUserRef.current !== ownerId || generation !== shiftReadGenerationRef.current
        || mutation !== shiftMutationRef.current) {
        throw new Error('Smena ma’lumoti yangilandi. Tekshiruvni qayta bajaring.');
      }
      saveShiftRestart(user, currentShift);
      setShift(currentShift);
      setShiftReadState('ready');
      return currentShift;
    } catch (error) {
      if (isPosNetworkError(error) && checkoutSessionRef.current === session
        && generation === shiftReadGenerationRef.current && mutation === shiftMutationRef.current) {
        const cached = readShiftRestart(user);
        if (cached?.shift?.status === 'open' && cached.shift.user_id === user.id
          && (user.role === 'admin' || cached.shift.shop_id === user.shop_id)) {
          setShift(cached.shift);
          setShiftReadState('ready');
          return cached.shift;
        }
      }
      // A stale read cannot undo a confirmed sale, withdrawal or shift close.
      if (checkoutSessionRef.current === session && stockUserRef.current === ownerId && generation === shiftReadGenerationRef.current
        && mutation === shiftMutationRef.current) setShiftReadState('error');
      throw error;
    }
  };

  const loadCashData = async (generation = loadGenerationRef.current) => {
    setCashDataLoading(true);
    setCashDataError('');
    try {
      const [recipientList, response] = await Promise.all([
        base44.entities.CashRecipient.list('name', 500),
        base44.functions.invoke('supplier-ledger', { action: 'get_debts' }),
      ]);
      if (generation !== loadGenerationRef.current) return;
      const payload = response?.data || response;
      setCashRecipients((recipientList || []).filter((recipient) => recipient.active !== false));
      setSupplierDebts(payload?.debts || {});
    } catch (error) {
      if (generation === loadGenerationRef.current) setCashDataError('Yetkazib beruvchilar ma’lumoti yuklanmadi. Qayta urinib ko‘ring.');
    } finally {
      if (generation === loadGenerationRef.current) setCashDataLoading(false);
    }
  };

  const loadWasteAlerts = async (generation = loadGenerationRef.current) => {
    const alertGeneration = ++wasteAlertGenerationRef.current;
    try {
      const response = await base44.functions.invoke('waste-ledger', { action: 'get_alerts' });
      if (generation !== loadGenerationRef.current || alertGeneration !== wasteAlertGenerationRef.current) return;
      const payload = response?.data || response;
      setWasteAlerts(payload?.expired_items || []);
    } catch { /* Keep the last known alerts when a background refresh fails. */ }
  };

  const loadAll = async ({ showLoading = true } = {}) => {
    const generation = ++loadGenerationRef.current;
    const stockGeneration = stockReadGenerationRef.current;
    if (showLoading) setLoadingData(true);
    try {
      const shiftRead = loadCurrentShift().catch(() => null);
      let catalog;
      let fromCache = false;
      try {
        const [cats, prods, shopList, operationalSettings, stockList] = await restartRead(() => Promise.all([
          base44.entities.Category.list(), base44.entities.Product.list(), base44.entities.Shop.list(),
          loadOperationalSettings(base44), base44.entities.ProductStock.list('-updated_at', 500),
        ]));
        catalog = { cats, prods, shopList, operationalSettings, stockList };
      } catch (error) {
        if (!isPosNetworkError(error)) throw error;
        catalog = readPosRestart(user);
        if (!catalog) throw new Error('Offline katalog topilmadi yoki muddati tugagan. Internet borida Kassani oching.');
        fromCache = true;
      }
      await shiftRead;
      const { cats, prods, shopList, operationalSettings, stockList } = catalog;
      if (generation !== loadGenerationRef.current) return;
      setCatalogOffline(fromCache);
      const saved = fromCache || savePosRestart(user, restartCatalog(catalog));
      setRestartSaved(saved);
      setRestartError(saved ? '' : 'Kassa nusxasi qurilmaga saqlanmadi. Offline qayta ochish tayyor emas.');
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
      if (stockGeneration === stockReadGenerationRef.current) {
        setProductStock((current) => mergeUnreservedStock(current, stockList || []));
      }
      setShops((shopList || []).filter((shop) => shop.active !== false && shop.allows_pos !== false));
      setSettings(operationalSettings);
      // Auxiliary data never holds the product grid behind a loading screen.
      if (!fromCache) { void loadCashData(generation); void loadWasteAlerts(generation); }
    } catch (error) {
      if (generation === loadGenerationRef.current) setRestartError(syncErrorMessage(error));
      throw error;
    } finally {
      if (generation === loadGenerationRef.current) setLoadingData(false);
    }
  };

  const confirmQueuedSale = useStableEvent((payload, key, record, confirmationTiming) => {
    // This callback follows the server's final sale acknowledgment. Timing
    // never invokes checkout again or changes the already-committed sale.
    const known = Number.isFinite(confirmationTiming?.totalMs) && confirmationTiming.totalMs >= 0;
    const outcome = payload.already_processed ? 'rechecked' : 'confirmed';
    try {
      if (record.user_id === user?.id && record.shift_id === shift?.id) {
        recordCheckoutTiming({ requestKey: key, onlyIfCurrent: true,
          totalMs: known ? confirmationTiming.totalMs : 0, durationKnown: known, outcome });
      }
      if (known && confirmationTiming.totalMs <= 86400000) {
        void reportCheckoutTiming({ event_id: `ct-server-${key}`, actor_id: record.user_id,
          shift_id: record.shift_id, request_key: key, sale_id: payload.sale.id,
          total_ms: confirmationTiming.totalMs, api_round_trip_ms: confirmationTiming.apiRoundTripMs,
          outcome, client_completed_at: confirmationTiming.completedAt }, {
          send: body => base44.functions.invoke('checkout-timing', body),
          isCurrentUser: () => timingUserRef.current === record.user_id,
        }).catch(() => console.warn('Server confirmation timing upload is pending.'));
      }
    } catch { /* Diagnostics cannot prevent stock reconciliation. */ }
    return reconcileCompletedSale(payload, key, record);
  });

  const {
    isOnline: queueOnline,
    browserOnline,
    connectionPaused,
    authorizationBlocked: queueAuthorizationError,
    reportRequestSuccess,
    reportRequestError,
    records: offlineSales,
    syncing: offlineSyncing,
    storageError: offlineStorageError,
    syncError: offlineSyncError,
    enqueue: enqueueOfflineSale,
    syncNow: syncOfflineSales,
  } = useOfflineSaleQueue(user?.id, () => loadAll({ showLoading: false }).catch(() => {}), (currentShift) => {
    saveShiftRestart(user, currentShift);
    shiftMutationRef.current++;
    setShift(currentShift);
    setShiftReadState('ready');
  }, confirmQueuedSale);
  const isOnline = queueOnline && !catalogOffline;
  const queueEligible = canQueuePosSale({ selectedTable, takeawayOrder,
    takeawayRequestId: takeawayRequestIdRef.current, discountCode, roundingTarget });

  useEffect(() => {
    if (user) void loadAll().catch(() => {});
    return () => { loadGenerationRef.current++; wasteAlertGenerationRef.current++; };
  }, [user]);

  useEffect(() => {
    const refreshOnline = () => { void loadAll({ showLoading: false }).catch(() => {}); };
    const refreshStale = () => { if (catalogOffline && navigator.onLine !== false) refreshOnline(); };
    window.addEventListener('online', refreshOnline);
    window.addEventListener('focus', refreshStale);
    return () => { window.removeEventListener('online', refreshOnline); window.removeEventListener('focus', refreshStale); };
  }, [user?.id, catalogOffline]);

  useEffect(() => {
    if (!user) return undefined;

    const unsubscribe = base44.entities.ProductStock.subscribe((event) => {
      stockReadGenerationRef.current++;
      setProductStock((current) => mergeUnreservedStock(current, mergePosStockEvent(current, event)));
    });

    return () => unsubscribe?.();
  }, [user?.id]);

  // Show the current shop's floor plan over Kassa. Save pending table edits
  // before switching so an unpaid order cannot silently lose its cart.
  const goToTables = async () => {
    if (posScopeReadOnly) return;
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
    if (shopScope && shopId !== scopedShopId) {
      void odinaAlert('Stol uchun do‘konni avval umumiy do‘kon tanlovidan almashtiring.');
      return;
    }
    if (posScopeReadOnly) return;
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
    if (isStaffTicketEnabled(savedShopId)) setStaffTicket({ mode: 'table', shop: savedShop, shopId: savedShopId, tableNumber: savedNumber });
  };

  const tableShop = selectedTable
    ? (verifiedTableShop?.key === tableKey ? verifiedTableShop.shop : shops.find((shop) => shop.id === selectedTable.shopId))
    : null;
  const tableSelectionError = tableQuery.invalid
    ? 'Stol havolasi noto‘g‘ri. Xaritadan qayta tanlang.'
    : selectedTable && !loadingData && !tableOrderLoading && !tableOrderError && (!tableShop
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
  const addToCart = useStableEvent((product) => {
    if (tableLocked || paying || payOpen || stockChecking) return;
    if (canPreviewBurgerFries(product.id, catalogShopId)) {
      setBurgerProduct({ ...product, shopId: catalogShopId });
      return;
    }
    setKeyboardProductId(product.id);
    if (product.sale_unit === 'gram') { openWeight(product); return; }
    setCart((prev) => {
      const existing = prev.find((i) => i.product_id === product.id);
      if (existing) {
        return prev.map((i) => i.product_id === product.id ? { ...i, quantity: i.quantity + 1, subtotal: i.subtotal + i.price } : i);
      }
      return [...prev, { product_id: product.id, product_name: product.name, image_url: product.image_url, price: product.price, sale_unit: 'piece', quantity: 1, subtotal: product.price }];
    });
  });

  const saveBurgerChoice = (option) => {
    if (!burgerProduct || !['with', 'without'].includes(option) || tableLocked || paying || payOpen || stockChecking
      || burgerProduct.shopId !== catalogShopId) return;
    const product = burgerProduct;
    const row = { product_id: product.id, product_name: burgerOptionName(product.name, option),
      image_url: product.image_url, price: product.price + friesSurcharge({ fries_option: option }),
      sale_unit: 'piece', quantity: 1, fries_option: option };
    row.subtotal = row.price;
    const key = saleLineKey(row);
    setKeyboardProductId(key);
    setCart((prev) => {
      const existing = prev.find((item) => saleLineKey(item) === key);
      return existing ? prev.map((item) => saleLineKey(item) === key
        ? { ...item, quantity: item.quantity + 1, subtotal: (item.quantity + 1) * item.price } : item) : [...prev, row];
    });
    setBurgerProduct(null);
  };
  useEffect(() => { setBurgerProduct(null); }, [tableKey, shift?.shop_id, user?.shop_id]);
  // Pre-shift preview uses catalogue prices; apply Branch prices when its shift opens.
  // Server-saved unpaid orders keep their original immutable price snapshots.
  useEffect(() => {
    if (!shift?.shop_id || selectedTable || takeawayOrder) return;
    setCart((rows) => repriceBurgerCartForShop(rows, products, shift.shop_id));
  }, [shift?.shop_id, products, tableKey, takeawayOrder]);

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
      const item = cart.find((row) => saleLineKey(row) === keyboardProductId) || cart[cart.length - 1];
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

  const inc = (item) => { if (item.sale_unit === 'gram') { openWeight(item, true); return; } if (!tableLocked && !paying) setCart((p) => p.map((i) => saleLineKey(i) === saleLineKey(item) ? { ...i, quantity: i.quantity + 1, subtotal: i.subtotal + i.price } : i)); };
  const dec = (item) => {
    if (tableLocked || paying || payOpen || stockChecking || savingTableRef.current) return;
    if (item.sale_unit === 'gram') { openWeight(item, true); return; }
    if (selectedTable && cart.length === 1 && saleLineKey(cart[0]) === saleLineKey(item) && item.quantity <= 1) {
      void cancelLastTableItem();
      return;
    }
    setCart((p) => p.flatMap((i) => {
      if (saleLineKey(i) !== saleLineKey(item)) return [i];
      const q = i.quantity - 1;
      return q <= 0 ? [] : [{ ...i, quantity: q, subtotal: q * i.price }];
    }));
  };
  const removeItem = (item) => {
    if (tableLocked || paying || payOpen || stockChecking || savingTableRef.current) return;
    if (selectedTable && cart.length === 1 && saleLineKey(cart[0]) === saleLineKey(item)) {
      void cancelLastTableItem();
      return;
    }
    setCart((p) => p.filter((i) => saleLineKey(i) !== saleLineKey(item)));
  };
  const changeDelivery = (value) => {
    if (selectedTable || tableLocked || paying || payOpen || stockChecking || savingTableRef.current) return;
    setIsDelivery(value === true);
  };
  const resetCart = () => { takeawayRequestIdRef.current = ''; setIsDelivery(false); setCart([]); setDiscountCode(''); setDiscountPct(0); setDiscountError(''); setDiscountOwnerPin(''); setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); };
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

  const catalogShopId = shopScope ? scopedShopId : shift?.shop_id || user?.shop_id;
  const { categories: visibleCategories, products: catalogProducts } = useMemo(
    () => shopScope && !catalogShopId ? { categories, products } : catalogForShop(products, categories, catalogShopId),
    [products, categories, catalogShopId, Boolean(shopScope)],
  );
  // Kassa chizilgach, do‘kondagi kichik rasmlar bo‘sh vaqtda jimgina keshlanadi.
  useEffect(() => {
    if (loadingData) return undefined;
    return preloadPosThumbnails(catalogProducts);
  }, [catalogProducts, loadingData]);
  useEffect(() => {
    if (activeCat !== 'all' && categories.length && !visibleCategories.some(c => c.id === activeCat)) setActiveCat('all');
  }, [activeCat, categories.length, visibleCategories]);
  const { order: shopProductOrder, accept: acceptProductOrder } = usePosProductOrder(catalogShopId, user?.id);
  const [productOrderOpen, setProductOrderOpen] = useState(false);
  const canEditProductOrder = ['admin', 'manager'].includes(user?.role) && (!shopScope || Boolean(shopScope.ready && scopedShopId));

  const filtered = useMemo(() => {
    const shopId = catalogShopId;
    let list = catalogProducts.map((product) => ({ ...product, price: priceForShop(product, shopId) }));
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
  }, [catalogProducts, categories, activeCat, showFav, search, catalogShopId, shopProductOrder]);

  const queuedForCurrentShift = useMemo(
    () => offlineSales.filter((record) => record.shift_id === shift?.id && record.status !== 'confirmed'),
    [offlineSales, shift?.id],
  );
  const scopeQueuePending = offlineSyncing || offlineSales.some((record) => record.status !== 'confirmed');
  useEffect(() => shopScope?.registerGuard?.(() => scopeQueuePending
    ? 'Do‘konni almashtirishdan oldin qurilmadagi navbatdagi savdolar yuborilishini kuting.' : ''),
  [shopScope?.registerGuard, scopeQueuePending]);
  const queuedShiftTotal = useMemo(
    () => queuedForCurrentShift.reduce((sum, record) => sum + Number(record.local_sale?.total || 0), 0),
    [queuedForCurrentShift],
  );
  const queuedQuantityByProduct = useMemo(() => {
    const quantities = {};
    for (const record of [...queuedForCurrentShift, ...confirmedStockReservations.filter((row) => row.shift_id === shift?.id)]) {
      for (const item of record.request?.items || []) {
        quantities[item.product_id] = Number(quantities[item.product_id] || 0) + Number(item.quantity || 0);
      }
    }
    return quantities;
  }, [queuedForCurrentShift, confirmedStockReservations, shift?.id]);
  const productsById = useMemo(
    () => Object.fromEntries(products.map((product) => [product.id, product])),
    [products],
  );

  const stockByProduct = useMemo(() => {
    const locationId = catalogShopId;
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
  }, [productStock, queuedQuantityByProduct, catalogShopId]);

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
    if (!checkoutAttemptRef.current?.uncertain) {
      checkoutRequestKeyRef.current = createSaleIdempotencyKey();
      checkoutRecordedAtRef.current = new Date().toISOString();
    }
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
    if (posScopeReadOnly) return;
    if (tableSelectionError || (selectedTable && (!tableShop || (shift && shift.shop_id !== selectedTable.shopId)))) {
      await odinaAlert(tableSelectionError || 'Stol uchun do‘kon va smenani tekshiring.');
      return;
    }
    if ((selectedTable || takeawayOrder || takeawayRequestIdRef.current) && (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false))) {
      await odinaAlert('Stol savdosini internet qaytmaguncha yakunlab bo‘lmaydi. Savat saqlanib turadi.');
      return;
    }
    if (!shift) {
      if (shiftReadState !== 'ready') {
        void loadCurrentShift().catch((error) => odinaAlert(syncErrorMessage(error)));
        return;
      }
      if (!isOnline) {
        void odinaAlert('Smenani ochish uchun internet kerak.');
      } else {
        setOpenShiftOpen(true);
      }
      return;
    }
    if (!cart.length || payOpen || paying || saleSubmittingRef.current || stockChecking || (offlineSyncing && !queueEligible) || tableLocked) return;
    if (queueAuthorizationError) {
      await odinaAlert('Server seansi tasdiqlanmadi. Tizimga qayta kiring; saqlangan savdolar qurilmada qoladi.');
      return;
    }
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

      if (offlineSales.some((record) => record.status !== 'confirmed') || offlineSyncing) {
        // New ordinary sales join the durable queue; background synchronization
        // never holds the next cashier payment behind the previous receipt.
        if (queueEligible) {
          await openOfflinePayment();
          return;
        }
        const syncResult = await syncOfflineSales();
        if (syncResult?.remaining > 0 || syncResult?.failed || syncResult?.skipped) {
          await odinaAlert('Avval qurilmada qolgan savdolarni serverga yuborish kerak.', {
            title: 'Sinxronlash tugamadi',
            details: syncResult?.failed?.message || offlineSyncError || '',
            tone: 'warning',
          });
          return;
        }
      }

      const result = await invokePosRead(base44, {
        action: 'check_stock',
        shift_id: shift.id,
        is_delivery: isDelivery,
        ...(savedTakeaway ? { takeaway_order_id: savedTakeaway.id, takeaway_order_revision: savedTakeaway.revision } : {}),
        ...(selectedTable ? { table_shop_id: selectedTable.shopId,
          table_number: selectedTable.number,
          table_order_id: tableOrder?.id, table_order_revision: tableOrder?.revision } : {}),
        items: cart.map((item) => ({ product_id: item.product_id, quantity: item.quantity, ...friesOptionFields(item) })),
      });
      if (checkoutCancelledRef.current) return;
      reportRequestSuccess();
      const payload = result?.data || result;
      const accepted = await confirmStockWarnings(
        payload?.shortages || [],
        payload?.allow_negative_stock,
      );
      if (accepted) openPayment(false);
    } catch (error) {
      reportRequestError(error);
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
    if (saleSubmittingRef.current || checkoutAttemptRef.current?.uncertain) {
      void odinaAlert('Avvalgi to‘lov natijasi hali tasdiqlanmagan. Qayta pul olmang; shu to‘lovni yana tasdiqlab tekshiring.');
      return;
    }
    checkoutCancelledRef.current = true;
    checkoutReadyRef.current = false;
    setPayOpen(false);
    if (paying) return;
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
    checkoutAttemptRef.current = null;
    setCheckoutRetryPending(false);
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
    if (isStaffTicketEnabled(sale?.shop_id || shift?.shop_id || user?.shop_id)
      && sale?.items?.length && !sale?.table_number_snapshot && !sale?.table_order_id_snapshot) {
      setStaffTicket({ mode: 'sale', order: sale, autoPrint: true });
    } else if (selectedTable && !sale?.offline_pending && !sale?.table_release_pending) {
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
    checkoutAttemptRef.current = null;
    setCheckoutRetryPending(false);
    resetCart();
    presentCompletedSale(record.local_sale, printReceipt);
  };

  // Keep the previous stock base while a confirmed sale still has a local
  // reservation. Publishing a newer general snapshot here would subtract twice.
  const mergeUnreservedStock = (current, incoming) => {
    const held = new Set([...confirmedStockRef.current.values()].flatMap((record) =>
      (record.request?.items || []).map((item) => `${record.shop_id}:${item.product_id}`)));
    if (!held.size) return incoming;
    return [...incoming.filter((row) => !held.has(`${row.location_id}:${row.product_id}`)),
      ...current.filter((row) => held.has(`${row.location_id}:${row.product_id}`))];
  };

  const refreshConfirmedStock = (shopId) => {
    const existing = confirmedStockReadsRef.current.get(shopId);
    if (existing) return existing.promise;
    const ownerId = user?.id;
    const session = checkoutSessionRef.current;
    const job = { version: 0, promise: null };
    confirmedStockReadsRef.current.set(shopId, job);
    job.promise = (async () => {
      for (let pass = 0; pass < 4; pass++) {
        const version = job.version;
        const holds = [...confirmedStockRef.current.values()].filter((row) => row.shop_id === shopId);
        const productIds = [...new Set(holds.flatMap((row) => [
          ...(row.request?.items || []).map((item) => item.product_id),
          ...(row.stock_updates || []).map((item) => item.product_id),
        ]))];
        const generation = ++stockReadGenerationRef.current;
        const outcome = await waitForSaleResponse({ promise: base44.entities.ProductStock.filter({
          location_id: shopId, product_id: { $in: productIds },
        }, '-updated_at', 500) }, { timeoutMs: 10000 });
        if (checkoutSessionRef.current !== session || stockUserRef.current !== ownerId) throw new Error('Kassir seansi o‘zgardi.');
        if (outcome.pending) throw new Error('Qoldiqni tekshirish kutilmoqda.');
        if (generation !== stockReadGenerationRef.current || version !== job.version) continue;
        // Close the coalescing job before publishing so a later acknowledgment
        // must start a fresh read rather than join a response already received.
        confirmedStockReadsRef.current.delete(shopId);
        const scoped = (outcome.response || []).filter((row) => row.location_id === shopId && productIds.includes(row.product_id));
        setProductStock((current) => [...current.filter((row) =>
          row.location_id !== shopId || !productIds.includes(row.product_id)), ...scoped]);
        for (const hold of holds) {
          confirmedStockRef.current.delete(hold.id);
          reconciledSaleKeysRef.current.add(hold.id);
          const order = String(hold.request?.recorded_at || '');
          const previous = latestStockSaleRef.current.get(shopId);
          if (!previous || order > previous.order) latestStockSaleRef.current.set(shopId, { order, key: hold.id });
        }
        setConfirmedStockReservations([...confirmedStockRef.current.values()]);
        return;
      }
      throw new Error('Qoldiq yangilanmoqda. Tekshiruv qayta bajariladi.');
    })().finally(() => {
      if (confirmedStockReadsRef.current.get(shopId) === job) confirmedStockReadsRef.current.delete(shopId);
    });
    return job.promise;
  };

  const reconcileCompletedSale = useStableEvent((payload, key, record) => {
    const saleKey = key || payload.sale?.idempotency_key || payload.sale?.id;
    if (!saleKey || reconciledSaleKeysRef.current.has(saleKey)) return;
    // A delayed queue response cannot reopen a shift or replace newer totals.
    if (payload.shift) {
      shiftMutationRef.current++;
      setShift((current) => current?.id === payload.shift.id
        && Number(payload.shift.order_count || 0) > Number(current.order_count || 0) ? payload.shift : current);
      setShiftReadState('ready');
    }
    const request = record?.request || checkoutAttemptRef.current?.request || {};
    const saleShopId = record?.shop_id || payload.sale?.shop_id || shift?.shop_id;
    const order = String(request.recorded_at || payload.sale?.sold_at || '');
    const previous = latestStockSaleRef.current.get(saleShopId);
    const hasHeldStock = [...confirmedStockRef.current.values()].some((row) => row.shop_id === saleShopId);
    const freshSnapshot = !record && order && payload.stock_updates?.length && !hasHeldStock
      && (!payload.shift || Number(payload.shift.order_count || 0) >= Number(shift?.order_count || 0))
      && (!previous || order > previous.order || previous.key === saleKey);
    if (freshSnapshot) {
      stockReadGenerationRef.current++;
      latestStockSaleRef.current.set(saleShopId, { order, key: saleKey });
      const updatedByProduct = Object.fromEntries(payload.stock_updates.map((item) => [item.product_id, item.quantity]));
      setProductStock((current) => {
        const changed = current.map((stock) => stock.location_id === saleShopId
          && Object.prototype.hasOwnProperty.call(updatedByProduct, stock.product_id)
          ? { ...stock, quantity: updatedByProduct[stock.product_id] } : stock);
        for (const item of payload.stock_updates) {
          if (!changed.some((stock) => stock.location_id === saleShopId && stock.product_id === item.product_id)) {
            changed.push({ location_id: saleShopId, product_id: item.product_id, quantity: item.quantity });
          }
        }
        return changed;
      });
      reconciledSaleKeysRef.current.add(saleKey);
      return;
    }
    // Idempotent replays may omit stock_updates. Retain the queued deduction
    // until a scoped authoritative read, never replace stock with an older ack.
    if (!confirmedStockRef.current.has(saleKey)) {
      stockReadGenerationRef.current++;
      const running = confirmedStockReadsRef.current.get(saleShopId);
      if (running) running.version++;
      confirmedStockRef.current.set(saleKey, { id: saleKey, shift_id: request.shift_id,
        shop_id: saleShopId, request, stock_updates: payload.stock_updates || [] });
      setConfirmedStockReservations([...confirmedStockRef.current.values()]);
    }
    return refreshConfirmedStock(saleShopId);
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!isOnline) return;
      const shopsToRefresh = new Set([...confirmedStockRef.current.values()].map((row) => row.shop_id));
      for (const shopId of shopsToRefresh) {
        if (!confirmedStockReadsRef.current.has(shopId)) void refreshConfirmedStock(shopId).catch(() => {});
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [isOnline, user?.id]);

  useEffect(() => {
    // A different signed-in cashier starts with independent presentation/locks.
    // The old closure and user-scoped flight retain its immutable request.
    checkoutAttemptRef.current = null;
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
    checkoutReadyRef.current = false;
    saleSubmittingRef.current = false;
    setCheckoutRetryPending(false);
    setPayOpen(false);
    setPaying(false);
    setConfirmedStockReservations([]);
    return () => {
      stockReadGenerationRef.current++;
      confirmedStockRef.current.clear();
      confirmedStockReadsRef.current.clear();
      latestStockSaleRef.current.clear();
      reconciledSaleKeysRef.current.clear();
    };
  }, [user?.id]);

  const applyCompletedSale = (payload, printReceipt) => {
    const reconciliation = reconcileCompletedSale(payload, checkoutRequestKeyRef.current);
    void Promise.resolve(reconciliation).catch(() => {});
    setPayOpen(false);
    setCheckoutOffline(false);
    checkoutRequestKeyRef.current = '';
    checkoutRecordedAtRef.current = '';
    checkoutAttemptRef.current = null;
    setCheckoutRetryPending(false);
    resetCart();
    if (!selectedTable || payload.table_released === true) setTableOrder(null);
    setTakeawayOrder(null);
    const sale = selectedTable && payload.table_released !== true
      ? { ...payload.sale, table_release_pending: true } : payload.sale;
    presentCompletedSale(sale, printReceipt);
    if (selectedTable && payload.table_released !== true) {
      void odinaAlert('Savdo yozildi, lekin ochiq buyurtmani yopish tasdiqlanmadi. Qayta pul olmang! Ochiq buyurtmalar yoki Stollar ichida «To‘lovni tekshirish» orqali yakunlang.');
    }
    void loadWasteAlerts();
  };

  const completeSale = async (payments, printReceipt = true) => {
    if (posScopeReadOnly) return;
    if (saleSubmittingRef.current || !cart.length || stockChecking || discountLoading || !checkoutReadyRef.current) return;
    saleSubmittingRef.current = true;
    const checkoutTimingStarted = performance.now();
    const checkoutTimingStartedAt = new Date().toISOString();
    let checkoutServerMs = null;
    let checkoutBackendTiming = null;
    let checkoutOutcome = 'unconfirmed';
    let checkoutSaleId = '';
    let saleCommitted = false;
    const checkoutSession = checkoutSessionRef.current;
    setMobileCartOpen(false);
    // Close the payment dialog before the async request so a cleared cart can
    // never leave a stale 0 UZS payment window on screen after a successful sale.
    setPayOpen(false);
    setPaying(true);
    const idempotencyKey = checkoutAttemptRef.current?.key || checkoutRequestKeyRef.current || createSaleIdempotencyKey();
    checkoutRequestKeyRef.current = idempotencyKey;
    try { recordCheckoutTiming({ requestKey: idempotencyKey, totalMs: 0, outcome: 'unconfirmed' }); } catch { /* Diagnostics only. */ }
    const recordedAt = checkoutAttemptRef.current?.request.recorded_at || checkoutRecordedAtRef.current || new Date().toISOString();
    checkoutRecordedAtRef.current = recordedAt;
    let attempt = checkoutAttemptRef.current;
    let pendingRecord = attempt?.pendingRecord || null;
    let storingPending = false;

    try {
      if (selectedTable && (tableCartDirty || !tableOrder?.id || tableOrder.state !== 'occupied')) {
        throw new Error('Buyurtma serverda saqlanganini tekshiring. To‘lovni qayta oching.');
      }
      if (takeawayOrder && (takeawayDirty || takeawayOrder.state !== 'occupied')) {
        throw new Error('Buyurtmani saqlang va to‘lovni qayta oching.');
      }
      if (!attempt && queueEligible && !discountOwnerPin && discountPct === 0) {
        pendingRecord = buildPendingSale({
          idempotencyKey,
          recordedAt,
          shift,
          user,
          shop: shops.find((shop) => shop.id === shift.shop_id),
          cart,
          payments,
          isDelivery,
        });
        // Separate payment submission time from the earlier payment-dialog time.
        pendingRecord.checkout_started_at = checkoutTimingStartedAt;
      }

      if (!attempt) {
        const request = pendingRecord?.request || {
          action: 'complete_sale',
          shift_id: shift.id,
          is_delivery: isDelivery,
          ...(takeawayOrder ? { takeaway_order_id: takeawayOrder.id, takeaway_order_revision: takeawayOrder.revision } : {}),
          ...(selectedTable ? { table_shop_id: selectedTable.shopId, table_number: selectedTable.number,
            table_order_id: tableOrder?.id, table_order_revision: tableOrder?.revision } : {}),
          items: cart.map((item) => ({
            product_id: item.product_id,
            quantity: item.quantity,
            ...friesOptionFields(item),
          })),
          discount_code: discountCode || undefined,
          rounding_total: adjustmentMode === 'rounding' ? roundingTarget : undefined,
          manual_discount_amount: adjustmentMode === 'manual' ? subtotal - roundingTarget : undefined,
          owner_pin: discountPct === 100 && discountOwnerPin ? discountOwnerPin : undefined,
          payments,
          idempotency_key: idempotencyKey,
          recorded_at: recordedAt,
        };
        attempt = { key: idempotencyKey, request: JSON.parse(JSON.stringify(request)), pendingRecord,
          checkoutStartedAt: checkoutTimingStartedAt, uncertain: false, onlineStarted: false, flight: null };
        checkoutAttemptRef.current = attempt;
      } else if (attempt.key !== idempotencyKey) {
        throw new Error('Avvalgi to‘lovning so‘rov kaliti o‘zgarmasligi kerak. Qayta pul olmang.');
      }

      if (checkoutOffline || !isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        if (selectedTable || takeawayOrder || takeawayRequestIdRef.current) throw new Error('Saqlangan buyurtmani internet orqali to‘lash kerak. Savat saqlanib turadi.');
        if (!pendingRecord) {
          throw new Error('Chegirmali savdoni offline saqlab bo‘lmaydi. Internetni kuting.');
        }
        storingPending = true;
        await enqueueOfflineSale(pendingRecord);
        saleCommitted = true;
        checkoutOutcome = 'queued';
        if (checkoutSessionRef.current !== checkoutSession) return;
        finishQueuedSale(pendingRecord, printReceipt);
        return;
      }

      try {
        const serverTimingStarted = performance.now();
        const flight = attempt.flight && attempt.flight.status !== 'rejected' ? attempt.flight
          : startSaleRequest(attempt.request,
            (request) => base44.functions.invoke('complete-sale', request), { userId: user.id });
        attempt.flight = flight;
        attempt.onlineStarted = true;
        // Only an unchanged sale with a durable queue fallback can finish
        // locally after 1s. Protected requests retain the 2.5s response budget.
        const outcome = await waitForSaleResponse(flight, {
          timeoutMs: pendingRecord
            ? POS_CHECKOUT_RESPONSE_BUDGET_MS
            : POS_PROTECTED_CHECKOUT_RESPONSE_BUDGET_MS,
        });
        if (outcome.pending) {
          attempt.uncertain = true;
          if (!pendingRecord) {
            throw Object.assign(new Error('To‘lov natijasi kutilmoqda. Shu to‘lovni qayta tekshiring; qayta pul olmang.'), { code: 'ETIMEDOUT' });
          }
          storingPending = true;
          // Without durable storage the catch below preserves the frozen
          // attempt promptly; it never waits indefinitely for the original write.
          await enqueueOfflineSale(pendingRecord);
          saleCommitted = true;
          checkoutOutcome = 'queued';
          if (checkoutSessionRef.current !== checkoutSession) return;
          finishQueuedSale(pendingRecord, printReceipt);
          return;
        }
        const result = outcome.response;
        if (checkoutSessionRef.current === checkoutSession) reportRequestSuccess();
        checkoutServerMs = flight.roundTripMs ?? Math.round(performance.now() - serverTimingStarted);
        const payload = result?.data || result;
        checkoutBackendTiming = payload?.backend_timing || null;
        if (!payload?.sale?.id) {
          releaseSaleRequest(idempotencyKey, flight);
          throw Object.assign(new Error(payload?.error || 'Savdoni yakunlab bo‘lmadi.'), { status: 502 });
        }
        checkoutSaleId = payload.sale.id;
        saleCommitted = true;
        checkoutOutcome = payload.already_processed ? 'rechecked' : 'confirmed';
        releaseSaleRequest(idempotencyKey, flight);
        if (checkoutSessionRef.current !== checkoutSession) return;
        applyCompletedSale(payload, printReceipt);
      } catch (error) {
        if (checkoutSessionRef.current === checkoutSession) reportRequestError(error);
        if (saleCommitted || storingPending || !pendingRecord || !isRetryableSyncError(error)) throw error;
        attempt.uncertain = true;
        storingPending = true;
        await enqueueOfflineSale(pendingRecord);
        saleCommitted = true;
        checkoutOutcome = 'queued';
        if (checkoutSessionRef.current !== checkoutSession) return;
        finishQueuedSale(pendingRecord, printReceipt);
      }
    } catch (error) {
      if (checkoutSessionRef.current !== checkoutSession) return;
      // A storage failure can race a confirmed original response. Acknowledge
      // that one sale, without another SDK invocation or another request key.
      const latePayload = attempt?.flight?.status === 'fulfilled'
        ? (attempt.flight.response?.data || attempt.flight.response) : null;
      if (!saleCommitted && latePayload?.sale?.id) {
        checkoutSaleId = latePayload.sale.id;
        checkoutOutcome = latePayload.already_processed ? 'rechecked' : 'confirmed';
        checkoutBackendTiming = latePayload.backend_timing || null;
        saleCommitted = true;
        releaseSaleRequest(idempotencyKey, attempt.flight);
        try { applyCompletedSale(latePayload, printReceipt); return; } catch (presentationError) { error = presentationError; }
      }
      if (saleCommitted) {
        setPayOpen(false);
        console.error('Completed sale presentation failed:', error);
        void odinaAlert('Savdo saqlandi. Chek oynasini ochishda xato yuz berdi. Qayta pul olmang; Savdolar tarixidan tekshiring.');
        return;
      }
      const uncertain = Boolean(attempt?.onlineStarted && (attempt.uncertain || isRetryableSyncError(error)));
      if (attempt) attempt.uncertain = uncertain;
      if (!uncertain) {
        checkoutAttemptRef.current = null;
        releaseSaleRequest(idempotencyKey, attempt?.flight);
      }
      setCheckoutRetryPending(uncertain);
      setPayOpen(true);
      const message = syncErrorMessage(error);
      const discountHint = uncertain
        ? ' Natija noaniq bo‘lishi mumkin. To‘lov oynasi qayta ochildi; avval Savdolar tarixini tekshiring, keyin kerak bo‘lsa shu tugmani yana bosing.'
        : '';
      void odinaAlert(`Savdoni yakunlab bo‘lmadi: ${message}${discountHint}`);
    } finally {
      if (checkoutSessionRef.current === checkoutSession) {
        saleSubmittingRef.current = false;
        setPaying(false);
      }
      const confirmedAt = attempt?.flight?.receivedAt;
      const startedAt = Date.parse(attempt?.checkoutStartedAt || checkoutTimingStartedAt);
      const checkoutTotalMs = ['confirmed', 'rechecked'].includes(checkoutOutcome)
        && Number.isFinite(confirmedAt) && confirmedAt >= startedAt
        ? confirmedAt - startedAt : Math.round(performance.now() - checkoutTimingStarted);
      if (checkoutSessionRef.current === checkoutSession) recordCheckoutTiming({ requestKey: idempotencyKey,
        totalMs: checkoutTotalMs, outcome: checkoutOutcome });
      // Diagnostics are separate from financial completion and never delay or retry a sale.
      try {
        void reportCheckoutTiming({ event_id: createCheckoutTimingEventId(), actor_id: user?.id || '',
          shift_id: shift?.id || '', request_key: idempotencyKey,
          ...(checkoutSaleId ? { sale_id: checkoutSaleId } : {}), total_ms: checkoutTotalMs,
          ...(checkoutServerMs === null ? {} : { api_round_trip_ms: checkoutServerMs }),
          outcome: checkoutOutcome, client_completed_at: new Date().toISOString() }, {
          send: body => base44.functions.invoke('checkout-timing', body),
          isCurrentUser: () => checkoutSessionRef.current === checkoutSession && timingUserRef.current === user?.id,
        }).then(result => {
          if (result?.failed || (result?.error && !(result?.sent > 0))) console.warn('Checkout timing history upload is pending.');
        }).catch(() => console.warn('Checkout timing history upload is pending.'));
      } catch { console.warn('Checkout timing history upload is pending.'); }
      console.info('[Odina checkout timing]', JSON.stringify({
        server_ms: checkoutServerMs,
        backend: checkoutBackendTiming,
        total_ms: checkoutTotalMs,
        completed: saleCommitted,
        print_receipt: printReceipt,
      }));
    }
  };

  const openShift = async ({ shop, starting_cash }) => {
    if (shopScope && (!shopScope.ready || !scopedShopId || shop?.id !== scopedShopId)) return;
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
      const currentShift = await openPosShift(base44, { shopId: shop?.id, startingCash: starting_cash });
      saveShiftRestart(user, currentShift);
      shiftMutationRef.current++;
      setShift(currentShift);
      setShiftReadState('ready');
      setOpenShiftOpen(false);
    } catch (e) {
      void odinaAlert('Smenani ochib bo‘lmadi: ' + syncErrorMessage(e));
    }
    finally { setShiftLoading(false); }
  };

  const requestCloseShift = async () => {
    if (posScopeReadOnly) return;
    if (offlineStorageError) {
      await odinaAlert('Qurilmadagi savdolarni tekshirib bo‘lmadi. Xotira xatosi tuzatilmaguncha smenani yopib bo‘lmaydi.');
      return;
    }
    if (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      await odinaAlert('Smenani yopishdan oldin internetga ulaning.', {
        title: 'Internet kerak',
        tone: 'warning',
      });
      return;
    }
    if (queuedForCurrentShift.length) {
      const result = await syncOfflineSales();
      if (result?.remaining > 0 || result?.failed || result?.skipped) {
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
      const currentShift = await loadCurrentShift();
      if (!currentShift || currentShift.id !== shift.id) {
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
    if (posScopeReadOnly) return;
    if (closingShiftRef.current) return;
    const shiftId = shiftToClose?.id;
    if (!shiftId) {
      setCloseShiftOpen(false);
      await loadAll().catch(() => {});
      void odinaAlert('Smena ma’lumoti yangilandi. Qayta ochib, yopishni tasdiqlang.');
      return;
    }
    if (!isOnline || offlineStorageError || offlineSales.some((record) => record.shift_id === shiftId && record.status !== 'confirmed')) {
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
      saveShiftRestart(user, null);
      shiftMutationRef.current++;
      setShift(null);
      setCloseShiftOpen(false);
      setShiftToClose(null);
      const detailsWarning = payload.details_warning || (payload.stock_report?.complete === false
        ? 'Smena yopildi. Yopilishdagi mahsulot qoldig‘i tafsilotlari yuklanmadi; Smenalar tarixidan qayta tekshiring.'
        : '');
      if (detailsWarning) toast({ title: 'Smena yopildi', description: detailsWarning });
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
    if (posScopeReadOnly) return;
    if (!shift || cashWithdrawalSubmittingRef.current) return;
    if (!isOnline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      void odinaAlert('Kassadan pul olishni saqlash uchun internet kerak.');
      return;
    }
    const isDebtPayment = expense_category === 'goods_payment';
    const debtRequestScope = orderRequestScope(user?.id, 'pay_debt');
    if (isDebtPayment && !cashWithdrawalRequestRef.current) cashWithdrawalRequestRef.current = readOrderRequest(debtRequestScope);
    const hadPendingDebt = isDebtPayment && Boolean(cashWithdrawalRequestRef.current);
    const fingerprint = JSON.stringify([shift.id, amount, reason, expense_category, recipient_id || '', recipient_name || '']);
    if (cashWithdrawalRequestRef.current && cashWithdrawalRequestRef.current.fingerprint !== fingerprint) {
      void odinaAlert('Avvalgi pul operatsiyasi natijasini tekshiring. Uni boshqa summa bilan takrorlamang; avvalgi summa va izoh bilan qayta tekshiring.');
      return;
    }
    if (!cashWithdrawalRequestRef.current) {
      cashWithdrawalRequestRef.current = { key: createSaleIdempotencyKey(), fingerprint };
    }
    if (isDebtPayment && !cashWithdrawalRequestRef.current.payload) {
      cashWithdrawalRequestRef.current.payload = { action: 'pay_debt', shift_id: shift.id,
        supplier_id: recipient_id, amount, notes: reason };
    }
    cashWithdrawalSubmittingRef.current = true;
    setCashWithdrawalLoading(true);
    try {
      if (isDebtPayment) cashWithdrawalRequestRef.current = retainOrderRequest(debtRequestScope, cashWithdrawalRequestRef.current);
      const result = await base44.functions.invoke(isDebtPayment ? 'supplier-ledger' : 'complete-sale', isDebtPayment ? {
        ...cashWithdrawalRequestRef.current.payload,
        idempotency_key: cashWithdrawalRequestRef.current.key,
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
      shiftMutationRef.current++;
      setShift(payload.shift);
      if (expense_category === 'goods_payment') {
        setSupplierDebts((current) => ({
          ...current,
          [recipient_id]: Math.max(0, Number(payload.remaining_debt || 0)),
        }));
      }
      if (isDebtPayment) clearOrderRequest(debtRequestScope);
      cashWithdrawalRequestRef.current = null;
      setCashWithdrawalOpen(false);
    } catch (e) {
      const pending = e?.response?.data?.operation_pending || e?.data?.operation_pending;
      const reversed = e?.response?.data?.operation_reversed || e?.data?.operation_reversed;
      if (reversed || (!pending && !isRetryableSyncError(e) && (!isDebtPayment || !hadPendingDebt))) {
        if (isDebtPayment) clearOrderRequest(debtRequestScope);
        cashWithdrawalRequestRef.current = null;
      }
      void odinaAlert('Pul olish natijasini tekshiring: ' + (e?.response?.data?.error || e?.data?.error || e?.message || e));
    } finally {
      cashWithdrawalSubmittingRef.current = false;
      setCashWithdrawalLoading(false);
    }
  };

  return (
    <div className={`odina-pos odina-pos-workbench ${posCompact ? 'odina-pos-compact' : ''} flex flex-1 flex-col min-h-0 w-full max-w-full bg-background overflow-hidden`}>
      {productOrderOpen && canEditProductOrder && catalogShopId && <ProductOrderDialog
        key={catalogShopId} shopId={catalogShopId}
        shopName={shops.find(shop => shop.id === catalogShopId)?.name || shift?.shop_name || user?.shop_name || 'Do‘kon'}
        products={catalogProducts} categories={visibleCategories} initialCategory={showFav ? 'all' : activeCat}
        onClose={() => setProductOrderOpen(false)} onSaved={acceptProductOrder} />}
      {/* Header */}
      <div className="odina-pos-header flex shrink-0 items-center gap-2 sm:gap-3 px-3 sm:px-6 py-2.5 sm:py-3 border-b border-border bg-card/95 backdrop-blur sticky top-0 z-20">
        <div className="odina-pos-shop-context flex items-center gap-2.5 min-w-0">
          <div className="odina-store-icon w-9 h-9 rounded-xl bg-primary/15 text-brand-ink flex items-center justify-center shrink-0">
            <Building2 className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{shopScope ? (scopedShop?.name || (shopScope.shopId === 'all' ? 'Barcha do‘konlar' : 'Do‘kon yuklanmoqda…')) : shift?.shop_name || (shiftReadState === 'loading' ? 'Smena tekshirilmoqda…' : shiftReadState === 'error' ? 'Smenani yuklab bo‘lmadi' : 'Faol smena yo‘q')}</div>
            <div className="text-xs text-muted-foreground truncate">
              {posScopeReadOnly ? 'Katalogni ko‘rish' : shift ? `${Number(shift.order_count || 0) + queuedForCurrentShift.length} ta buyurtma` : shiftReadState === 'error' ? 'Qayta tekshirish tugmasini bosing' : shiftReadState === 'loading' ? 'Iltimos, kuting' : 'Savdoni boshlash uchun smenani oching'}
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
        <Button type="button" variant="outline" size="sm" onClick={() => void goToTables()} disabled={posScopeReadOnly}
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

            <Button variant="outline" size="sm" aria-label="Kassadan pul olish" title="Pul olish" onClick={() => setCashWithdrawalOpen(true)} disabled={posScopeReadOnly} className="h-10 w-10 shrink-0 rounded-xl p-0 touch-manipulation">
              <Banknote className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" aria-label="Smenani yopish" title="Smenani yopish" onClick={requestCloseShift} disabled={offlineSyncing || posScopeReadOnly} className="h-10 w-10 shrink-0 rounded-xl p-0 touch-manipulation">
              <Clock className="w-4 h-4" />
            </Button>
          </>
        ) : shiftReadState === 'ready' ? (
          <Button size="sm" onClick={() => setOpenShiftOpen(true)} disabled={posScopeReadOnly} className="h-10 bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
            Smenani ochish
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={shiftReadState === 'loading'}
            onClick={() => void loadCurrentShift().catch((error) => odinaAlert(syncErrorMessage(error)))}
            className="h-10 shrink-0 touch-manipulation">
            <RefreshCw className={`mr-1.5 h-4 w-4 ${shiftReadState === 'loading' ? 'animate-spin' : ''}`} />
            {shiftReadState === 'loading' ? 'Tekshirilmoqda…' : 'Qayta tekshirish'}
          </Button>
        )}
      </div>

      {posScopeReadOnly && <p role="status" className="mx-3 sm:mx-5 mt-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">{!scopedShopId ? 'Savdo qilish uchun yuqoridan bitta do‘konni tanlang.' : scopedShop?.location_type === 'production' || scopedShop?.allows_pos === false ? 'Bu joylashuvda Kassa savdosi yoqilmagan. Ombor bo‘limidan foydalaning.' : shift && shift.shop_id !== scopedShopId ? `Sizning ochiq smenangiz ${shift.shop_name || 'boshqa do‘kon'}da. Tanlangan do‘kon katalogi faqat ko‘rish uchun. Smenangiz avtomatik almashtirilmaydi.` : 'Do‘kon ma’lumoti tekshirilmoqda.'}</p>}
      <CheckoutTimingStatus userRole={user?.role} pending={paying}
        onOpenHistory={() => setCheckoutTimingHistoryOpen(true)}
        timing={(!shopScope || scopedShopId === shift?.shop_id) && lastCheckoutTiming?.shiftId === shift?.id ? lastCheckoutTiming : null} />

      {!selectedTable && Number.isInteger(location.state?.savedTableNumber) && (
        <div role="status" className="mx-3 sm:mx-5 mt-3 flex shrink-0 items-center gap-3 rounded-2xl border border-brand-olive/40 bg-brand-olive/10 px-4 py-3 text-sm">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-ink" aria-hidden="true" />
          <p className="flex-1"><strong>{location.state.savedTableNumber}-stol buyurtmasi saqlandi.</strong> To‘lov olinmadi. Kassa yangi buyurtmaga tayyor.</p>
          {isStaffTicketEnabled(location.state.savedShopId || shift?.shop_id || user?.shop_id) && <Button type="button" variant="outline" onClick={() => setStaffTicket({
            mode: 'table', shopId: location.state.savedShopId || shift?.shop_id,
            shop: shops.find((item) => item.id === (location.state.savedShopId || shift?.shop_id)),
            tableNumber: location.state.savedTableNumber,
          })} className="min-h-11 shrink-0 rounded-xl text-xs font-semibold">
            <ReceiptText className="h-4 w-4 mr-1.5" /> Xizmat cheki
          </Button>}
          <Button type="button" variant="ghost" size="icon" aria-label="Saqlash xabarini yopish"
            onClick={() => navigate(posHomePath, { replace: true, state: null })} className="h-11 w-11 shrink-0 rounded-xl"><X className="h-4 w-4" /></Button>
        </div>
      )}

      <OfflineRestartStatus saved={restartSaved && Boolean(shift) && readShiftRestart(user)?.shift?.id === shift?.id} error={restartError} offline={catalogOffline || !isOnline} />
      <OfflineSalesBanner
        browserOnline={browserOnline} connectionPaused={connectionPaused}
        isOnline={isOnline}
        records={offlineSales.filter((record) => record.status !== 'confirmed')}
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
            {isStaffTicketEnabled(selectedTable?.shopId) && tableOrder?.items?.length > 0 && !tableCartDirty && <Button type="button" variant="outline"
              onClick={() => setStaffTicket({ mode: 'table', shop: tableShop, shopId: selectedTable.shopId, tableNumber: selectedTable.number })}
              className="min-h-11 rounded-xl font-semibold text-brand-ink">
              <ReceiptText className="h-4 w-4 mr-1.5" /> Xizmat cheki
            </Button>}
            {tableOrder?.state === 'paying' && <Button type="button" variant="outline" className="min-h-11 border-amber-500" onClick={() => void reconcileTablePayment()}>To‘lovni tekshirish</Button>}
            {(tableOrderError || tableSaveError) && <Button type="button" variant="outline" className="min-h-11" onClick={async () => {
              if (tableCartDirty && !(await odinaConfirm('Saqlanmagan savat o‘chadi. Serverdagi buyurtmani qayta yuklaysizmi?'))) return;
              setTableReload((current) => current + 1);
            }}>Buyurtmani yangilash</Button>}
            {isStaffTicketEnabled(selectedTable?.shopId) && Boolean(selectedTable && (tableOrder?.items?.length || cart.length)) && (
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

      <PaymentSavingStatus saving={paying} />

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

      <div className="odina-pos-body flex-1 flex min-h-0">
        {/* Center: categories + grid */}
        <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
          {/* Category rail */}
          <div className="odina-category-rail hidden md:flex w-36 shrink-0 border-r border-border bg-sidebar/50 flex-col py-3 overflow-y-auto scrollbar-thin">
            <p className="odina-category-title">KATEGORIYALAR</p>
            <CatTab active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }} icon={<Search className="w-4 h-4" />} label="Barchasi" />
            <CatTab active={showFav} onClick={() => setShowFav(true)} icon={<Star className="w-4 h-4" />} label="Sevimlilar" />
            <div className="h-px bg-border my-2 mx-3" />
            {visibleCategories.map((c) => (
              <CatTab key={c.id} active={activeCat === c.id && !showFav} onClick={() => { setActiveCat(c.id); setShowFav(false); }} icon={<CategoryIcon icon={c.icon} className="text-base" imgClassName="w-5 h-5" />} label={c.name.replaceAll('&', ' & ')} />
            ))}
          </div>

          <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
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
              <div className="odina-category-chips flex gap-2 overflow-x-auto no-scrollbar pb-1 md:hidden">
                <Chip active={activeCat === 'all' && !showFav} onClick={() => { setActiveCat('all'); setShowFav(false); }}>Barchasi</Chip>
                <Chip active={showFav} onClick={() => setShowFav(true)}><Star className="h-4 w-4" aria-hidden="true" /> Sevimlilar</Chip>
                {visibleCategories.map((c) => (
                  <Chip key={c.id} active={activeCat === c.id && !showFav} onClick={() => { setActiveCat(c.id); setShowFav(false); }}>{c.name.replaceAll('&', ' & ')}</Chip>
                ))}
              </div>
            </div>

            <div role="region" aria-label="Kassadagi mahsulotlar" tabIndex={0} className="odina-product-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-4 sm:px-5 pb-20 lg:pb-6">
              <ProductGrid products={filtered} shopId={catalogShopId}
                stockByProduct={stockByProduct} showStock={Boolean(shopScope ? catalogShopId : shift)}
                onAdd={addToCart} disabled={tableLocked || paying || payOpen || stockChecking}
                loading={loadingData} />
            </div>
          </div>
        </div>

        {/* Cart */}
        <div className="odina-cart-wrap hidden lg:flex w-[340px] xl:w-[380px] 2xl:w-[420px] min-h-0 min-w-0 shrink-0 border-l border-border overflow-hidden">
          <Cart
            cart={cart}
            isDelivery={isDelivery} onDeliveryChange={changeDelivery}
            selectedProductId={cart.some((row) => saleLineKey(row) === keyboardProductId) ? keyboardProductId : (cart.length ? saleLineKey(cart[cart.length - 1]) : undefined)}
            onSelectItem={(item) => setKeyboardProductId(saleLineKey(item))}
            onInc={inc} onDec={dec} onRemove={removeItem} onClear={clearCart}
            subtotal={subtotal} discount={discount} couponDiscount={couponDiscount} discountCode={discountCode}
            onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError}
            roundingTarget={roundingTarget} adjustmentMode={adjustmentMode} roundingError={roundingError}
            onApplyRounding={applyRounding} onApplyManualDiscount={applyManualDiscount}
            onRemoveRounding={() => { setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); }}
            total={total} onCheckout={openCheckout} disabled={!shift || Boolean(tableSelectionError) || posScopeReadOnly}
            takeawayOrder={takeawayOrder} onServiceTicket={!selectedTable && isStaffTicketEnabled(shift?.shop_id || user?.shop_id) ? showTakeawayTicket : undefined}
            onOpenOrders={!selectedTable ? loadOpenOrders : undefined} onLeaveTakeaway={leaveTakeaway}
            savingTakeaway={takeawaySaving}
            tableMode={Boolean(selectedTable)} tableDirty={tableCartDirty} tableSaved={Boolean(tableOrder?.id)}
            onSaveTable={() => void saveAndStartNextOrder()} onCancelTable={() => void cancelTableSelection()} savingTable={savingTable} locked={tableLocked || paying || payOpen || stockChecking}
          />
        </div>
      </div>

      {/* Telefon va iPad uchun doim ko‘rinadigan buyurtma paneli */}
      <div className={`odina-mobile-cart-dock lg:hidden fixed left-0 ${screenMode ? '' : sidebarCollapsed ? 'lg:left-20' : 'lg:left-64'} right-0 bottom-0 z-40 px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] bg-card/95 backdrop-blur border-t border-border transition-[left] duration-200`}>
        <Button onClick={() => setMobileCartOpen(true)} className="w-full min-h-12 h-auto px-4 py-3 whitespace-normal text-sm sm:text-base font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary-strong touch-manipulation">
          Buyurtma · {formatUZS(total)} ({cart.reduce((s, i) => s + (i.sale_unit === 'gram' ? 1 : i.quantity), 0)} ta)
        </Button>
      </div>

      <Sheet open={mobileCartOpen && compactCartViewport} onOpenChange={setMobileCartOpen}>
        <SheetContent side="bottom" className="odina-cart-sheet lg:hidden h-[88dvh] p-0 rounded-t-[28px] overflow-hidden">
          <SheetTitle className="sr-only">Joriy buyurtma</SheetTitle>
          <Cart
            cart={cart}
            isDelivery={isDelivery} onDeliveryChange={changeDelivery}
            selectedProductId={cart.some((row) => saleLineKey(row) === keyboardProductId) ? keyboardProductId : (cart.length ? saleLineKey(cart[cart.length - 1]) : undefined)}
            onSelectItem={(item) => setKeyboardProductId(saleLineKey(item))}
            onInc={inc} onDec={dec} onRemove={removeItem} onClear={clearCart}
            subtotal={subtotal} discount={discount} couponDiscount={couponDiscount} discountCode={discountCode}
            onApplyDiscount={applyDiscount} onRemoveDiscount={removeDiscount} discountError={discountError}
            roundingTarget={roundingTarget} adjustmentMode={adjustmentMode} roundingError={roundingError}
            onApplyRounding={applyRounding} onApplyManualDiscount={applyManualDiscount}
            onRemoveRounding={() => { setRoundingTarget(null); setAdjustmentMode(null); setRoundingError(''); }}
            total={total} onCheckout={() => { setMobileCartOpen(false); void openCheckout(); }} disabled={!shift || Boolean(tableSelectionError) || posScopeReadOnly}
            takeawayOrder={takeawayOrder} onServiceTicket={!selectedTable && isStaffTicketEnabled(shift?.shop_id || user?.shop_id) ? showTakeawayTicket : undefined}
            onOpenOrders={!selectedTable ? loadOpenOrders : undefined} onLeaveTakeaway={leaveTakeaway}
            savingTakeaway={takeawaySaving}
            tableMode={Boolean(selectedTable)} tableDirty={tableCartDirty} tableSaved={Boolean(tableOrder?.id)}
            onSaveTable={() => void saveAndStartNextOrder()} onCancelTable={() => void cancelTableSelection()} savingTable={savingTable} locked={tableLocked || paying || payOpen || stockChecking}
          />
        </SheetContent>
      </Sheet>

      <Dialog open={openOrdersOpen} onOpenChange={(open) => { if (!cancellingTakeawayRef.current) setOpenOrdersOpen(open); }}>
        <DialogContent className="sm:max-w-lg max-h-[85dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>Ochiq buyurtmalar · Olib ketish</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">To‘lanmagan buyurtmalar. To‘lov uchun buyurtmani oching.</p>
          <Button variant="outline" onClick={loadOpenOrders} disabled={openOrdersLoading || Boolean(cancellingTakeawayId)}>Yangilash</Button>
          {openOrdersError && <p role="alert" className="text-sm text-destructive">{openOrdersError}</p>}
          {openOrdersLoading ? <p>Yuklanmoqda…</p> : openOrders.length === 0 && !openOrdersError ? <p>Ochiq buyurtma yo‘q.</p> : (
            <div className="space-y-3">{openOrders.map((order) => (
              <div key={order.id} className="rounded-xl border border-brand-sand/50 p-3 space-y-2">
                <div className="flex justify-between gap-2 font-semibold">
                  <span>{order.is_delivery === true ? '🚚 Dostavka' : 'Buyurtma'} #{order.ticket_number}</span><span>{formatUZS(order.total)}</span>
                </div>
                <p className="text-xs text-muted-foreground">{formatUzbekistanDateTime(order.started_at)} · {order.opened_by_name}</p>
                <p className="text-sm break-words">{order.items.map((row) => row.product_name + ' × ' + row.quantity + (row.sale_unit === 'gram' ? ' g' : '')).join(', ')}</p>
                <p className="text-xs font-semibold">{order.state === 'paying' ? 'To‘lov tekshirilmoqda — qayta pul olmang' : 'To‘lanmagan'}</p>
                <div className="flex flex-wrap gap-2">
                  <Button className="min-h-11 flex-1" onClick={() => order.state === 'paying' ? reconcileTakeaway(order) : openTakeaway(order)} disabled={openOrdersLoading || Boolean(cancellingTakeawayId)}>
                    {order.state === 'paying' ? 'To‘lovni tekshirish' : 'Ochish · To‘lov'}
                  </Button>
                  {isStaffTicketEnabled(order.shop_id || shift?.shop_id || user?.shop_id) && <Button variant="outline" className="min-h-11" disabled={Boolean(cancellingTakeawayId)} onClick={() => {
                    setOpenOrdersOpen(false);
                    setStaffTicket({ mode: 'takeaway', order, shopId: order.shop_id || shift?.shop_id || user?.shop_id, shop: shops.find((row) => row.id === (order.shop_id || shift?.shop_id || user?.shop_id)) });
                  }}>Xizmat cheki</Button>}
                  <TakeawayCancelAction ticketNumber={order.ticket_number}
                    disabled={openOrdersLoading || Boolean(cancellingTakeawayId) || paying || payOpen || stockChecking || takeawaySaving || savingTable || order.state !== 'occupied' || Boolean(order.checkout_key)}
                    busy={cancellingTakeawayId === order.id}
                    error={takeawayCancelError?.orderId === order.id ? takeawayCancelError.message : ''}
                    onConfirm={() => void cancelTakeawayOrder(order)} />
                </div>
              </div>
            ))}</div>
          )}
        </DialogContent>
      </Dialog>
      <PosTablePicker
        open={tablePickerOpen}
        onOpenChange={setTablePickerOpen}
        activeShopId={shopScope ? scopedShopId : shift?.shop_id || user?.shop_id}
        onSelect={(shopId, number, payDirect) => { void selectTableFromPicker(shopId, number, payDirect); }}
      />
      <Dialog open={Boolean(burgerProduct)} onOpenChange={(open) => !open && setBurgerProduct(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{burgerProduct?.name}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Fri qo‘shilsinmi?{burgerProduct?.id === '6ab747c5c1c33517e6eea449' ? ' 1 porsiya = 3 ta mini burger.' : ''}</p>
          {!burgerProduct?.shopId && <p className="text-xs text-muted-foreground">Branch smenasi ochilgach shu do‘kon narxlari qo‘llanadi.</p>}
          <div className="grid gap-3">
            <Button type="button" variant="outline" className="h-auto min-h-20 justify-between gap-3 rounded-xl px-4 py-4"
              disabled={tableLocked || paying || payOpen || stockChecking} onClick={() => saveBurgerChoice('without')}>
              <span className="text-base font-semibold">Frisiz</span><span>{formatUZS(burgerProduct?.price || 0)}</span>
            </Button>
            <Button type="button" className="h-auto min-h-20 justify-between gap-3 rounded-xl px-4 py-4"
              disabled={tableLocked || paying || payOpen || stockChecking} onClick={() => saveBurgerChoice('with')}>
              <span className="text-left"><span className="block text-base font-semibold">Fri bilan</span><span className="block text-xs opacity-80">150 g fri · +{formatUZS(FRIES_SURCHARGE)}</span></span>
              <span>{formatUZS((burgerProduct?.price || 0) + FRIES_SURCHARGE)}</span>
            </Button>
          </div>
          <Button type="button" variant="ghost" onClick={() => setBurgerProduct(null)}>Bekor qilish</Button>
        </DialogContent>
      </Dialog>
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
        isDelivery={isDelivery}
        attemptKey={checkoutRequestKeyRef.current}
        retryPending={checkoutRetryPending}
        checking={stockChecking}
        discountPending={discountLoading}
        discountControls={
          <fieldset disabled={paying || stockChecking || discountLoading || checkoutRetryPending} className="min-w-0 space-y-2.5 disabled:opacity-60">
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
            {salesHistoryOpen && <SalesHistory embedded settings={settings} />}
          </div>
        </DialogContent>
      </Dialog>
      <CheckoutTimingHistory key={user?.id || 'signed-out'} open={checkoutTimingHistoryOpen} onOpenChange={setCheckoutTimingHistoryOpen}
        userRole={user?.role} shops={shops} adminShopScope={shopScope} />
      <ShiftReport shift={shiftReport} onAfterPrint={() => setShiftReport(null)} />
      <Receipt
        sale={receiptPrintSale}
        settings={settings}
        print={!!receiptPrintSale}
        onAfterPrint={finishSalePresentation}
      />
      <StaffOrderTicketModal open={!!staffTicket} onClose={() => setStaffTicket(null)}
        mode={staffTicket?.mode} order={staffTicket?.order} shop={staffTicket?.shop}
        shopId={staffTicket?.shopId} tableNumber={staffTicket?.tableNumber} autoPrint={staffTicket?.autoPrint} />
      <OpenShiftDialog open={openShiftOpen} shops={shopScope ? shops.filter((shop) => shop.id === scopedShopId) : shops} preferredShopId={shopScope ? scopedShopId : undefined} user={user} onClose={() => setOpenShiftOpen(false)} onConfirm={openShift} loading={shiftLoading} />
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
        pendingSupplierPayment={readOrderRequest(orderRequestScope(user?.id, 'pay_debt'))}
        dataLoading={cashDataLoading}
        dataError={cashDataError}
        onRetryData={() => void loadCashData()}
        onClose={() => setCashWithdrawalOpen(false)}
        onConfirm={recordCashWithdrawal}
        loading={cashWithdrawalLoading}
      />
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
    <button type="button" aria-pressed={active} onClick={onClick} className={`odina-category-chip whitespace-nowrap min-h-11 px-4 py-2 rounded-full text-sm font-medium transition-colors touch-manipulation ${active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground/70'}`}>
      {children}
    </button>
  );
}