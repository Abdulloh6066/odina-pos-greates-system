// Offline-only regression tests for the admin audit/export center.
// No live Base44 records are read, created, updated or deleted.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  auditRequestFilters,
  auditRowsToCsv,
  defaultAuditFilters,
  tashkentDateKey,
} from "../src/lib/audit-export.js";

function fixture() {
  const db = {
    User: [
      { id: "owner", role: "admin", full_name: "Odina Owner", active: true },
      { id: "cashier", role: "cashier", full_name: "Ali Kassir", shop_id: "shop-a", active: true },
    ],
    Shop: [
      { id: "shop-a", name: "Odina Central", active: true },
      { id: "shop-b", name: "Odina Chilonzor", active: true },
    ],
    ActionHistory: [{
      id: "action-1",
      user_id: "cashier",
      user_name: "Ali Kassir",
      action: "sale_completed",
      details: "Odina Central · S-001",
      created_date: "2026-09-11T20:30:00.000Z",
    }],
    Sale: [{
      id: "sale-1",
      sale_number: "S-001",
      sold_at: "2026-09-11T20:30:00.000Z",
      business_date: "2026-09-12",
      user_id: "cashier",
      user_name: "Ali Kassir",
      shop_id: "shop-a",
      shop_name: "Odina Central",
      total: 50000,
      discount_amount: 0,
      payment_methods_summary: "Naqd pul",
      status: "completed",
    }],
    Payment: [
      {
        id: "payment-before-boundary",
        sale_id: "old-sale",
        sale_number: "S-OLD",
        shop_id: "shop-a",
        cashier_id: "cashier",
        method: "cash",
        amount: 10000,
        created_at: "2026-09-11T18:59:59.000Z",
      },
      {
        id: "payment-1",
        sale_id: "sale-1",
        sale_number: "S-001",
        shop_id: "shop-a",
        cashier_id: "cashier",
        method: "cash",
        amount: 50000,
        created_at: "2026-09-11T20:30:01.000Z",
      },
    ],
    OrderPayment: [{
      id: "order-payment-1",
      order_id: "order-1",
      order_number_snapshot: "BO-001",
      payment_kind: "advance",
      payment_method: "uzcard",
      amount: 20000,
      paid_at: "2026-09-11T20:31:00.000Z",
      shop_id: "shop-b",
      shop_name_snapshot: "Odina Chilonzor",
      employee_id: "cashier",
      employee_name: "Ali Kassir",
      status: "completed",
    }],
    Refund: [{
      id: "refund-1",
      refund_number: "R-001",
      sale_id: "sale-refund",
      sale_number: "S-REFUND",
      shop_id: "shop-a",
      cashier_id: "cashier",
      cashier_name: "Ali Kassir",
      amount: 12000,
      reason: "Mijoz qaytardi",
      created_at: "2026-09-11T21:00:00.000Z",
    }],
    CashMovement: [{
      id: "cash-1",
      shop_id: "shop-a",
      user_id: "cashier",
      user_name: "Ali Kassir",
      amount: 5000,
      reason: "Yetkazish",
      created_at: "2026-09-11T21:10:00.000Z",
    }],
    Shift: [{
      id: "shift-1",
      user_id: "cashier",
      user_name: "Ali Kassir",
      shop_id: "shop-a",
      shop_name: "Odina Central",
      status: "closed",
      opened_at: "2026-09-11T19:05:00.000Z",
      closed_at: "2026-09-11T22:00:00.000Z",
      starting_cash: 0,
      total_sales: 50000,
      order_count: 1,
      difference: 0,
    }],
    StockMovement: [
      {
        id: "stock-old",
        movement_number: "SM-OLD",
        location_id: "shop-a",
        location_name: "Odina Central",
        item_name: "Medovik",
        movement_type: "sale",
        quantity_change: -1,
        balance_before: 4,
        balance_after: 3,
        unit: "piece",
        reason: "Oldingi kun",
        user_id: "cashier",
        user_name: "Ali Kassir",
        created_at: "2026-09-11T18:59:59.000Z",
      },
      {
        id: "stock-1",
        movement_number: "SM-001",
        location_id: "shop-a",
        location_name: "Odina Central",
        item_name: "Medovik",
        movement_type: "sale",
        quantity_change: -2,
        balance_before: 5,
        balance_after: 3,
        unit: "piece",
        reason: "S-001",
        user_id: "cashier",
        user_name: "Ali Kassir",
        created_at: "2026-09-11T20:30:02.000Z",
      },
    ],
  };

  let listReads = 0;
  const clone = (value) => value == null ? value : structuredClone(value);
  const entities = Object.fromEntries(Object.entries(db).map(([name, rows]) => [name, {
    get: async (id) => clone(rows.find((row) => row.id === id) || null),
    list: async () => {
      listReads += 1;
      return clone(rows);
    },
  }]));
  let authenticatedUser = clone(db.User[0]);
  const client = {
    auth: { me: async () => clone(authenticatedUser) },
    asServiceRole: { entities },
  };

  let source = readFileSync("base44/functions/audit-report/entry.ts", "utf8")
    .replace(
      'import { createClientFromRequest } from "npm:@base44/sdk";',
      "const createClientFromRequest = () => client;",
    )
    .replace(
      'import { resolveAppUser, userLabel } from "../../shared/user-helpers.ts";',
      [
        'const userLabel = (user) => user?.full_name || user?.email || "Noma’lum xodim";',
        "const resolveAppUser = async (service, user) => {",
        "  const stored = await service.entities.User.get(user?.id);",
        "  return { ...user, ...stored, role: stored?.role || user?.role, active: stored?.active ?? user?.active };",
        "};",
      ].join("\n"),
    )
    .replace("export default async function(req)", "async function handler(req)");
  source += "\nglobalThis.testHandler = handler;";

  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context = vm.createContext({ client, Response, console, structuredClone, Intl });
  vm.runInContext(code, context);

  return {
    db,
    get listReads() { return listReads; },
    setAuth(user) { authenticatedUser = clone(user); },
    call: async (body) => {
      const response = await context.testHandler({ json: async () => body });
      return { status: response.status, data: await response.json() };
    },
  };
}

test("backend checks the stored app role before any audit lists are loaded", async () => {
  const f = fixture();
  f.db.User[0].role = "cashier";
  f.setAuth({ id: "owner", role: "admin", full_name: "Forged session admin" });

  const response = await f.call({ action: "list" });

  assert.equal(response.status, 403);
  assert.equal(f.listReads, 0);
});

test("admin gets one filtered timeline with Tashkent business dates and trusted summaries", async () => {
  const f = fixture();
  const response = await f.call({
    action: "list",
    date_from: "2026-09-12",
    date_to: "2026-09-12",
    limit: 100,
  });

  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(response.data.rows.length > 0);
  assert.ok(response.data.rows.every((row) => row.business_date === "2026-09-12"));
  assert.ok(response.data.rows.some((row) => row.source === "Sale" && row.reference === "S-001"));
  assert.ok(response.data.rows.some((row) => row.source === "OrderPayment" && row.reference === "BO-001"));
  assert.ok(response.data.rows.some((row) => row.source === "StockMovement" && row.quantity === -2));
  assert.ok(!response.data.rows.some((row) => row.reference === "S-OLD"));
  assert.ok(!response.data.rows.some((row) => row.reference === "SM-OLD"));
  assert.equal(response.data.summary.sales_total, 50000);
  assert.equal(response.data.summary.payments_total, 70000);
  assert.equal(response.data.summary.refund_total, 12000);
  assert.equal(response.data.summary.cash_out_total, 5000);
});

test("employee, shop, category and search filters are all applied on the backend", async () => {
  const f = fixture();
  const response = await f.call({
    action: "list",
    date_from: "2026-09-12",
    date_to: "2026-09-12",
    category: "payment",
    user_id: "cashier",
    shop_id: "shop-b",
    query: "BO-001",
    limit: 100,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.total, 1);
  assert.equal(response.data.rows[0].source, "OrderPayment");
});

test("export is bounded and reports when the filtered result was truncated", async () => {
  const f = fixture();
  const response = await f.call({
    action: "export",
    date_from: "2026-09-12",
    date_to: "2026-09-12",
    limit: 1,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.rows.length, 1);
  assert.equal(response.data.truncated, true);
});

test("audit backend is read-only", () => {
  const source = readFileSync("base44/functions/audit-report/entry.ts", "utf8");
  assert.doesNotMatch(source, /\.entities\.[A-Za-z0-9]+\.(create|update|updateMany|delete|deleteMany|bulkCreate)\s*\(/);
});

test("CSV is UTF-8, Excel-friendly and blocks spreadsheet formula injection", () => {
  const csv = auditRowsToCsv([{
    event_time: "2026-09-11T20:30:00.000Z",
    business_date: "2026-09-12",
    category_label: "Amallar jurnali",
    action_label: "Sinov",
    source: "ActionHistory",
    user_name: "+SUM(1,1)",
    shop_name: "Odina",
    reference: "A-1",
    details: '=HYPERLINK("https://example.test")',
    amount: -1000,
    quantity: null,
    unit: "",
    status: "completed",
  }]);

  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.match(csv, /"'\+SUM\(1,1\)"/);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/);
  assert.match(csv, /;-1000;/);
});

test("frontend helpers use a seven-day Tashkent range and strip all-filter sentinels", () => {
  const filters = defaultAuditFilters("2026-09-12T10:00:00.000Z");
  assert.equal(filters.date_from, "2026-09-06");
  assert.equal(filters.date_to, "2026-09-12");
  assert.equal(tashkentDateKey("2026-09-11T19:00:00.000Z"), "2026-09-12");
  assert.deepEqual(auditRequestFilters(filters), {
    date_from: "2026-09-06",
    date_to: "2026-09-12",
    category: "",
    user_id: "",
    shop_id: "",
    query: "",
  });
});

test("audit route and menu are admin-only", () => {
  const app = readFileSync("src/App.jsx", "utf8");
  const pos = readFileSync("src/lib/pos.js", "utf8");

  assert.match(app, /path="\/audit".*pageKey="audit"/);
  assert.match(pos, /admin:\s*\[[^\]]*'audit'/);
  for (const role of ["manager", "cashier", "accountant", "production", "warehouse"]) {
    const match = pos.match(new RegExp(role + ":\\s*\\[([^\\]]*)\\]"));
    assert.ok(match, role + " menu missing");
    assert.doesNotMatch(match[1], /'audit'/);
  }
});
