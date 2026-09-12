import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser, userLabel } from "../../shared/user-helpers.ts";

const CATEGORY_LABELS: Record<string, string> = {
  sale: "Savdo va qaytarish",
  payment: "To‘lov va pul harakati",
  shift: "Smena",
  stock: "Ombor harakati",
  action: "Amallar jurnali",
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Naqd pul",
  uzcard: "Uzcard",
  humo: "Humo",
  click: "Click",
  payme: "Payme",
  bank_transfer: "Bank o‘tkazmasi",
  other: "Boshqa",
};

const PAYMENT_KIND_LABELS: Record<string, string> = {
  advance: "Avans",
  balance: "Qolgan to‘lov",
  additional: "Qo‘shimcha to‘lov",
};

const MOVEMENT_LABELS: Record<string, string> = {
  opening: "Boshlang‘ich qoldiq",
  adjustment: "Qoldiq tuzatildi",
  receipt: "Omborga kirim",
  production_use: "Ishlab chiqarishga sarflandi",
  production_output: "Ishlab chiqarildi",
  transfer_out: "Ombordan yuborildi",
  transfer_in: "Omborga qabul qilindi",
  sale: "Savdoda kamaydi",
  waste: "Chiqit hisobdan chiqarildi",
  waste_cancel: "Chiqit bekor qilindi",
  refund: "Qaytarishda omborga qo‘shildi",
  receipt_cancel: "Kirim bekor qilindi",
};

const ACTION_LABELS: Record<string, string> = {
  sale_completed: "Savdo yakunlandi",
  sale_refunded: "Savdo qaytarildi",
  shift_opened: "Smena ochildi",
  shift_closed: "Smena yopildi",
  shift_stock_snapshot_skipped: "Smena qoldiq tarixi saqlanmadi",
  cash_withdrawal: "Kassadan pul olindi",
  order_created: "Buyurtma yaratildi",
  order_payment: "Buyurtma to‘lovi olindi",
  production_status_change: "Buyurtma ishlab chiqarish holati o‘zgardi",
  order_completed: "Buyurtma yakunlandi",
  stock_adjusted: "Ombor qoldig‘i tuzatildi",
  stock_transfer_sent: "Mahsulot yuborildi",
  stock_transfer_received: "Mahsulot qabul qilindi",
  stock_count_approved: "Ombor sanog‘i tasdiqlandi",
  recipe_saved: "Retsept saqlandi",
  production_completed: "Ishlab chiqarish yakunlandi",
  waste_recorded: "Chiqit hisobdan chiqarildi",
  waste_cancelled: "Chiqit bekor qilindi",
  shop_request_created: "Do‘kon talabi yaratildi",
  shop_request_cancelled: "Do‘kon talabi bekor qilindi",
  shop_request_accepted: "Do‘kon talabi qabul qilindi",
  shop_request_progress: "Do‘kon talabi holati o‘zgardi",
  shop_request_sent: "Do‘kon talabi yuborildi",
  shop_request_received: "Do‘kon talabi qabul qilib olindi",
  supplier_receipt_created: "Yetkazib beruvchidan kirim qilindi",
  supplier_receipt_cancelled: "Yetkazib beruvchi kirimi bekor qilindi",
  supplier_debt_paid: "Yetkazib beruvchi qarzi to‘landi",
  supplier_debt_paid_from_budget: "Yetkazib beruvchi qarzi Budgetdan to‘landi",
  budget_manual_deposit: "Budgetga qo‘lda kirim qilindi",
  budget_manual_withdrawal: "Budgetdan qo‘lda chiqim qilindi",
  staff_invite_applied: "Xodim taklifi qabul qilindi",
  user_invited: "Xodim taklif qilindi",
};

const UNIT_LABELS: Record<string, string> = {
  g: "g",
  ml: "ml",
  piece: "dona",
  sheet: "list",
};

const str = (value: unknown) => String(value ?? "").trim();
const num = (value: unknown) => Number(value) || 0;
const money = (value: unknown) => Math.round(num(value));
const safeTime = (value: unknown) => {
  const time = new Date(str(value)).getTime();
  return Number.isFinite(time) ? time : 0;
};

function tashkentDateKey(value: unknown) {
  const date = new Date(str(value));
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function validDateKey(value: string) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function plainActionLabel(action: unknown) {
  const key = str(action);
  if (ACTION_LABELS[key]) return ACTION_LABELS[key];
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Tizim amali";
}

function paymentLabel(method: unknown) {
  const key = str(method);
  return PAYMENT_LABELS[key] || key || "Ko‘rsatilmagan";
}

function userNameFor(id: unknown, explicitName: unknown, userMap: Map<string, any>) {
  const direct = str(explicitName);
  if (direct) return direct;
  const user = userMap.get(str(id));
  return user ? userLabel(user) : "Noma’lum xodim";
}

function shopFor(
  id: unknown,
  explicitName: unknown,
  details: unknown,
  userId: unknown,
  shopMap: Map<string, any>,
  userMap: Map<string, any>,
  shopsByName: any[],
) {
  const directId = str(id);
  const directName = str(explicitName);
  if (directId || directName) {
    return {
      id: directId,
      name: directName || str(shopMap.get(directId)?.name) || "Noma’lum joy",
      inferred: false,
    };
  }

  const detailText = str(details).toLocaleLowerCase("uz-UZ");
  const namedShop = shopsByName.find((shop) =>
    detailText.includes(str(shop.name).toLocaleLowerCase("uz-UZ"))
  );
  if (namedShop) return { id: str(namedShop.id), name: str(namedShop.name), inferred: true };

  const user = userMap.get(str(userId));
  const userShopId = str(user?.shop_id || user?.data?.shop_id);
  if (userShopId) {
    return {
      id: userShopId,
      name: str(shopMap.get(userShopId)?.name || user?.shop_name || user?.data?.shop_name) || "Noma’lum joy",
      inferred: true,
    };
  }
  return { id: "", name: "", inferred: false };
}

function eventRow(input: any) {
  const eventTime = str(input.event_time);
  return {
    id: str(input.id),
    category: str(input.category),
    category_label: CATEGORY_LABELS[str(input.category)] || "Boshqa",
    source: str(input.source),
    action: str(input.action),
    action_label: str(input.action_label),
    event_time: eventTime,
    business_date: str(input.business_date) || tashkentDateKey(eventTime),
    user_id: str(input.user_id),
    user_name: str(input.user_name) || "Noma’lum xodim",
    shop_id: str(input.shop_id),
    shop_name: str(input.shop_name),
    shop_inferred: Boolean(input.shop_inferred),
    reference: str(input.reference),
    details: str(input.details),
    amount: input.amount == null ? null : money(input.amount),
    amount_label: str(input.amount_label),
    quantity: input.quantity == null ? null : num(input.quantity),
    unit: str(input.unit),
    status: str(input.status),
  };
}

function buildRows(data: any) {
  const users = data.users || [];
  const shops = data.shops || [];
  const userMap = new Map(users.map((row: any) => [str(row.id), row]));
  const shopMap = new Map(shops.map((row: any) => [str(row.id), row]));
  const shopsByName = [...shops]
    .filter((shop: any) => str(shop.name))
    .sort((left: any, right: any) => str(right.name).length - str(left.name).length);
  const rows: any[] = [];

  for (const action of data.actions || []) {
    const shop = shopFor("", "", action.details, action.user_id, shopMap, userMap, shopsByName);
    rows.push(eventRow({
      id: "action:" + action.id,
      category: "action",
      source: "ActionHistory",
      action: action.action,
      action_label: plainActionLabel(action.action),
      event_time: action.created_date || action.created_at || action.updated_date,
      user_id: action.user_id,
      user_name: userNameFor(action.user_id, action.user_name, userMap),
      shop_id: shop.id,
      shop_name: shop.name,
      shop_inferred: shop.inferred,
      reference: action.id,
      details: action.details,
    }));
  }

  for (const sale of data.sales || []) {
    const shop = shopFor(sale.shop_id, sale.shop_name, "", sale.user_id, shopMap, userMap, shopsByName);
    const discount = money(sale.discount_amount);
    const paymentSummary = str(sale.payment_methods_summary)
      || (sale.payments || []).map((payment: any) => paymentLabel(payment.method)).join(", ");
    rows.push(eventRow({
      id: "sale:" + sale.id,
      category: "sale",
      source: "Sale",
      action: sale.status === "refunded" ? "sale_refunded" : "sale_completed",
      action_label: sale.status === "refunded" ? "Qaytarilgan savdo" : "Savdo yakunlandi",
      event_time: sale.sold_at || sale.created_date || sale.created_at,
      business_date: sale.business_date,
      user_id: sale.user_id,
      user_name: userNameFor(sale.user_id, sale.user_name, userMap),
      shop_id: shop.id,
      shop_name: shop.name,
      reference: sale.sale_number || sale.id,
      details: paymentSummary + (discount > 0 ? " · chegirma " + discount + " UZS" : ""),
      amount: sale.status === "refunded" ? -Math.abs(money(sale.total)) : money(sale.total),
      amount_label: sale.status === "refunded" ? "Qaytarilgan summa" : "Savdo summasi",
      status: sale.status,
    }));
  }

  for (const payment of data.payments || []) {
    const shop = shopFor(payment.shop_id, "", "", payment.cashier_id, shopMap, userMap, shopsByName);
    rows.push(eventRow({
      id: "payment:" + payment.id,
      category: "payment",
      source: "Payment",
      action: "sale_payment",
      action_label: "Savdo to‘lovi",
      event_time: payment.created_at || payment.created_date,
      user_id: payment.cashier_id,
      user_name: userNameFor(payment.cashier_id, "", userMap),
      shop_id: shop.id,
      shop_name: shop.name,
      reference: payment.sale_number || payment.sale_id,
      details: paymentLabel(payment.method) + (payment.reference ? " · " + payment.reference : ""),
      amount: payment.amount,
      amount_label: "To‘lov",
      status: "completed",
    }));
  }

  for (const payment of data.orderPayments || []) {
    const shop = shopFor(payment.shop_id, payment.shop_name_snapshot, "", payment.employee_id, shopMap, userMap, shopsByName);
    rows.push(eventRow({
      id: "order-payment:" + payment.id,
      category: "payment",
      source: "OrderPayment",
      action: "order_payment",
      action_label: PAYMENT_KIND_LABELS[str(payment.payment_kind)] || "Buyurtma to‘lovi",
      event_time: payment.paid_at || payment.created_date,
      user_id: payment.employee_id,
      user_name: userNameFor(payment.employee_id, payment.employee_name, userMap),
      shop_id: shop.id,
      shop_name: shop.name,
      reference: payment.order_number_snapshot || payment.order_id,
      details: paymentLabel(payment.payment_method),
      amount: payment.amount,
      amount_label: "Buyurtma to‘lovi",
      status: payment.status,
    }));
  }

  for (const refund of data.refunds || []) {
    const shop = shopFor(refund.shop_id, "", "", refund.cashier_id, shopMap, userMap, shopsByName);
    rows.push(eventRow({
      id: "refund:" + refund.id,
      category: "sale",
      source: "Refund",
      action: "sale_refunded",
      action_label: "Savdo qaytarildi",
      event_time: refund.created_at || refund.created_date,
      user_id: refund.cashier_id,
      user_name: userNameFor(refund.cashier_id, refund.cashier_name, userMap),
      shop_id: shop.id,
      shop_name: shop.name,
      reference: refund.refund_number || refund.sale_number || refund.sale_id,
      details: (str(refund.payment_summary) ? refund.payment_summary + " · " : "") + str(refund.reason),
      amount: -Math.abs(money(refund.amount)),
      amount_label: "Qaytarilgan summa",
      status: "refunded",
    }));
  }

  for (const movement of data.cashMovements || []) {
    const shop = shopFor(movement.shop_id, "", "", movement.user_id, shopMap, userMap, shopsByName);
    rows.push(eventRow({
      id: "cash:" + movement.id,
      category: "payment",
      source: "CashMovement",
      action: "cash_withdrawal",
      action_label: "Kassadan pul olindi",
      event_time: movement.created_at || movement.created_date,
      user_id: movement.user_id,
      user_name: userNameFor(movement.user_id, movement.user_name || movement.employee_name, userMap),
      shop_id: shop.id,
      shop_name: shop.name,
      reference: movement.reference_id || movement.id,
      details: [movement.recipient_name_snapshot, movement.reason].filter(Boolean).join(" · "),
      amount: -Math.abs(money(movement.amount)),
      amount_label: "Kassadan chiqim",
      status: "completed",
    }));
  }

  for (const shift of data.shifts || []) {
    const shop = shopFor(shift.shop_id, shift.shop_name, "", shift.user_id, shopMap, userMap, shopsByName);
    const employeeName = userNameFor(shift.user_id, shift.user_name, userMap);
    if (shift.opened_at || shift.created_date) {
      rows.push(eventRow({
        id: "shift-open:" + shift.id,
        category: "shift",
        source: "Shift",
        action: "shift_opened",
        action_label: "Smena ochildi",
        event_time: shift.opened_at || shift.created_date,
        user_id: shift.user_id,
        user_name: employeeName,
        shop_id: shop.id,
        shop_name: shop.name,
        reference: shift.id,
        details: "Boshlang‘ich naqd: " + money(shift.starting_cash) + " UZS",
        status: shift.status,
      }));
    }
    if (shift.closed_at) {
      rows.push(eventRow({
        id: "shift-close:" + shift.id,
        category: "shift",
        source: "Shift",
        action: "shift_closed",
        action_label: "Smena yopildi",
        event_time: shift.closed_at,
        user_id: shift.user_id,
        user_name: employeeName,
        shop_id: shop.id,
        shop_name: shop.name,
        reference: shift.id,
        details: str(shift.order_count) + " ta savdo · pul farqi " + money(shift.difference) + " UZS",
        amount: shift.total_sales,
        amount_label: "Smena savdosi",
        status: shift.status,
      }));
    }
  }

  for (const movement of data.stockMovements || []) {
    const shop = shopFor(movement.location_id, movement.location_name, "", movement.user_id, shopMap, userMap, shopsByName);
    const unit = UNIT_LABELS[str(movement.unit)] || str(movement.unit);
    rows.push(eventRow({
      id: "stock:" + movement.id,
      category: "stock",
      source: "StockMovement",
      action: movement.movement_type,
      action_label: MOVEMENT_LABELS[str(movement.movement_type)] || "Ombor harakati",
      event_time: movement.created_at || movement.created_date,
      user_id: movement.user_id,
      user_name: userNameFor(movement.user_id, movement.user_name, userMap),
      shop_id: shop.id,
      shop_name: shop.name,
      reference: movement.movement_number || movement.reference_id || movement.id,
      details: str(movement.item_name) + " · " + num(movement.balance_before) + " → " + num(movement.balance_after) + " " + unit + (movement.reason ? " · " + movement.reason : ""),
      quantity: movement.quantity_change,
      unit,
      status: "completed",
    }));
  }

  return rows.filter((row) => row.event_time);
}

function filterRows(rows: any[], filters: any) {
  const query = str(filters.query).toLocaleLowerCase("uz-UZ");
  return rows.filter((row) => {
    if (filters.date_from && row.business_date < filters.date_from) return false;
    if (filters.date_to && row.business_date > filters.date_to) return false;
    if (filters.category && row.category !== filters.category) return false;
    if (filters.user_id && row.user_id !== filters.user_id) return false;
    if (filters.shop_id && row.shop_id !== filters.shop_id) return false;
    if (query) {
      const haystack = [
        row.action_label,
        row.reference,
        row.details,
        row.user_name,
        row.shop_name,
        row.category_label,
      ].join(" ").toLocaleLowerCase("uz-UZ");
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function summarize(rows: any[]) {
  const directSales = rows.filter((row) => row.source === "Sale");
  const directPayments = rows.filter((row) => row.source === "Payment" || row.source === "OrderPayment");
  const refunds = rows.filter((row) => row.source === "Refund");
  const cashOuts = rows.filter((row) => row.source === "CashMovement");
  return {
    total_events: rows.length,
    sale_count: directSales.length,
    sales_total: directSales.reduce((sum, row) => sum + Math.max(0, num(row.amount)), 0),
    payment_count: directPayments.length,
    payments_total: directPayments.reduce((sum, row) => sum + Math.max(0, num(row.amount)), 0),
    refund_total: refunds.reduce((sum, row) => sum + Math.abs(num(row.amount)), 0),
    cash_out_total: cashOuts.reduce((sum, row) => sum + Math.abs(num(row.amount)), 0),
    shift_events: rows.filter((row) => row.source === "Shift").length,
    stock_events: rows.filter((row) => row.source === "StockMovement").length,
    action_events: rows.filter((row) => row.source === "ActionHistory").length,
  };
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const authenticatedUser = await base44.auth.me();
    if (!authenticatedUser) {
      return Response.json({ error: "Tizimga kirish talab qilinadi." }, { status: 401 });
    }

    const service = base44.asServiceRole;
    const user = await resolveAppUser(service, authenticatedUser);
    if (user?.active === false || user?.role !== "admin") {
      return Response.json(
        { error: "Nazorat va eksport faqat egasi uchun ochiq." },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const action = str(body.action || "list");
    if (action !== "list" && action !== "export") {
      return Response.json({ error: "Noto‘g‘ri amal." }, { status: 400 });
    }

    const filters = {
      date_from: str(body.date_from),
      date_to: str(body.date_to),
      category: str(body.category),
      user_id: str(body.user_id),
      shop_id: str(body.shop_id),
      query: str(body.query).slice(0, 120),
    };
    if (!validDateKey(filters.date_from) || !validDateKey(filters.date_to)) {
      return Response.json({ error: "Sana formati noto‘g‘ri." }, { status: 400 });
    }
    if (filters.date_from && filters.date_to && filters.date_from > filters.date_to) {
      return Response.json({ error: "Boshlanish sanasi tugash sanasidan keyin bo‘lmasligi kerak." }, { status: 400 });
    }
    if (filters.category && !Object.hasOwn(CATEGORY_LABELS, filters.category)) {
      return Response.json({ error: "Noto‘g‘ri bo‘lim filtri." }, { status: 400 });
    }

    const sourceLimit = action === "export" ? 3000 : 1500;
    const [
      users,
      shops,
      actions,
      sales,
      payments,
      orderPayments,
      refunds,
      cashMovements,
      shifts,
      stockMovements,
    ] = await Promise.all([
      service.entities.User.list("full_name", 500),
      service.entities.Shop.list("name", 500),
      service.entities.ActionHistory.list("-created_date", sourceLimit),
      service.entities.Sale.list("-created_date", sourceLimit),
      service.entities.Payment.list("-created_date", sourceLimit),
      service.entities.OrderPayment.list("-created_date", sourceLimit),
      service.entities.Refund.list("-created_date", sourceLimit),
      service.entities.CashMovement.list("-created_date", sourceLimit),
      service.entities.Shift.list("-created_date", sourceLimit),
      service.entities.StockMovement.list("-created_date", sourceLimit),
    ]);

    const sourceRows = {
      users: users || [],
      shops: shops || [],
      actions: actions || [],
      sales: sales || [],
      payments: payments || [],
      orderPayments: orderPayments || [],
      refunds: refunds || [],
      cashMovements: cashMovements || [],
      shifts: shifts || [],
      stockMovements: stockMovements || [],
    };
    const sourceCapReached = [
      sourceRows.actions,
      sourceRows.sales,
      sourceRows.payments,
      sourceRows.orderPayments,
      sourceRows.refunds,
      sourceRows.cashMovements,
      sourceRows.shifts,
      sourceRows.stockMovements,
    ].some((rows) => rows.length >= sourceLimit);

    const matched = filterRows(buildRows(sourceRows), filters)
      .sort((left, right) => safeTime(right.event_time) - safeTime(left.event_time) || right.id.localeCompare(left.id));
    const requestedLimit = Math.floor(num(body.limit));
    const maxLimit = action === "export" ? 5000 : 200;
    const limit = Math.min(Math.max(requestedLimit || (action === "export" ? 5000 : 100), 1), maxLimit);
    const offset = action === "export"
      ? 0
      : Math.min(Math.max(Math.floor(num(body.offset)), 0), 100000);
    const rows = matched.slice(offset, offset + limit);

    return Response.json({
      rows,
      total: matched.length,
      summary: summarize(matched),
      users: sourceRows.users.map((item: any) => ({
        id: str(item.id),
        name: userLabel(item),
        role: str(item.role || item?.data?.role),
        shop_id: str(item.shop_id || item?.data?.shop_id),
      })),
      shops: sourceRows.shops.map((item: any) => ({
        id: str(item.id),
        name: str(item.name),
        active: item.active !== false,
      })),
      filters,
      generated_at: new Date().toISOString(),
      truncated: matched.length > rows.length && action === "export",
      source_cap_reached: sourceCapReached,
    });
  } catch (error) {
    console.error("audit-report failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Nazorat ma’lumotlarini yuklab bo‘lmadi." },
      { status: 500 },
    );
  }
}
