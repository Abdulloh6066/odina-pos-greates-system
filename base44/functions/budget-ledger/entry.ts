import { createClientFromRequest } from "npm:@base44/sdk";
import { resolveAppUser } from "../../shared/user-helpers.ts";
import { financialRequestKey, runBudgetAdjustment, runSupplierPayment } from "../../shared/supplier-payment-recovery.ts";

const ACCOUNTS = new Set(["cash", "uzcard", "humo", "online", "bank"]);
const ACCOUNT_LABELS: Record<string, string> = {
  cash: "Naqd pul",
  uzcard: "Uzcard",
  humo: "Humo",
  online: "Onlayn",
  bank: "Bank",
};

const money = (value: unknown) => Math.round(Number(value) || 0);

const hex = (bytes: Uint8Array) =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const PIN_FAILURE_LIMIT = 5;
const PIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

async function recentPinFailureCount(service: any, actorKey: string) {
  const events = await service.entities.ActionHistory.filter(
    { user_id: actorKey },
    "-created_date",
    20,
  );
  const cutoff = Date.now() - PIN_FAILURE_WINDOW_MS;
  let failures = 0;
  for (const event of events || []) {
    const occurredAt = Date.parse(String(event.created_date || event.created_at || ""));
    if (!Number.isFinite(occurredAt) || occurredAt < cutoff) break;
    if (event.action === "owner_pin_verified" || event.action === "owner_pin_updated") break;
    if (event.action === "owner_pin_failed") failures += 1;
  }
  return failures;
}

async function recordPinAttempt(service: any, actor: any, ok: boolean) {
  await service.entities.ActionHistory.create({
    user_id: String(actor?.id || actor?.email || "unknown"),
    user_name: String(actor?.full_name || actor?.email || "Noma’lum xodim"),
    action: ok ? "owner_pin_verified" : "owner_pin_failed",
    details: ok ? "Himoyalangan amal uchun PIN tasdiqlandi." : "Noto‘g‘ri PIN urinishi bloklandi.",
  });
}

async function verifyOwnerPin(service: any, pinValue: unknown, actor: any) {
  const actorKey = String(actor?.id || actor?.email || "");
  if (!actorKey) return false;
  if (await recentPinFailureCount(service, actorKey) >= PIN_FAILURE_LIMIT) return false;

  const pin = String(pinValue || "");
  if (!/^\d{4,8}$/.test(pin)) {
    await recordPinAttempt(service, actor, false);
    return false;
  }
  const records = await service.entities.SecuritySettings.filter({ key: "owner_approval_pin" });
  const security = records?.[0];
  if (
    !security?.pin_hash ||
    !security?.pin_salt ||
    security.pin_algorithm !== "PBKDF2-SHA256"
  ) return false;

  const configuredIterations = Number(security.pin_iterations || 100000);
  const iterations = Math.min(Math.max(configuredIterations, 100000), 600000);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: new TextEncoder().encode(security.pin_salt),
    iterations,
  }, key, 256);
  const verified = constantTimeEqual(hex(new Uint8Array(derived)), String(security.pin_hash));
  await recordPinAttempt(service, actor, verified);
  return verified;
}

export default async function(req) {
  const base44 = createClientFromRequest(req);
  const service = base44.asServiceRole;

  try {
    const auth = await base44.auth.me();
    if (!auth) return Response.json({ error: "Tizimga kirish talab qilinadi." }, { status: 401 });
    const user = await resolveAppUser(service, auth);
    if (user.role !== "admin") {
      return Response.json({ error: "Budget faqat egasi uchun ochiq." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    if (action === "summary") {
      const [balances, transactions] = await Promise.all([
        service.entities.BudgetBalance.list("account", 20),
        service.entities.BudgetTransaction.list("-created_at", 500),
      ]);
      return Response.json({
        balances: (balances || []).map(({ financial_operations_json: _operations, shift_settlement_operations_json: _settlements, shift_settlement_keys: _keys, ...balance }: any) => balance),
        transactions: transactions || [],
      });
    }

    if (action === "manual_adjustment") {
      if (!(await verifyOwnerPin(service, body?.owner_pin, user))) {
        return Response.json({ error: "Owner PIN noto‘g‘ri." }, { status: 403 });
      }

      const account = String(body?.account || "");
      const direction = String(body?.direction || "");
      const amount = money(body?.amount);
      const description = String(body?.description || "").trim();
      if (!ACCOUNTS.has(account) || !["in", "out"].includes(direction) || !Number.isSafeInteger(amount) || amount <= 0 || description.length < 3) {
        return Response.json({ error: "Hisob, amal, musbat summa va izoh majburiy." }, { status: 400 });
      }

      const result = await runBudgetAdjustment(service, user, {
        key: financialRequestKey(body), account, direction, amount, description,
      }, ACCOUNT_LABELS);
      return Response.json(result);
    }

    if (action === "pay_supplier") {
      if (!(await verifyOwnerPin(service, body?.owner_pin, user))) {
        return Response.json({ error: "Owner PIN noto‘g‘ri." }, { status: 403 });
      }

      const account = String(body?.account || "");
      const supplierId = String(body?.supplier_id || "");
      const amount = money(body?.amount);
      const notes = String(body?.notes || "").trim();
      if (!ACCOUNTS.has(account) || !supplierId || !Number.isSafeInteger(amount) || amount <= 0) {
        return Response.json({ error: "Yetkazib beruvchi, Budget hisobi va musbat summa majburiy." }, { status: 400 });
      }

      const result = await runSupplierPayment(service, user, {
        key: financialRequestKey(body), action, account, supplier_id: supplierId, amount, notes,
      }, ACCOUNT_LABELS);
      return Response.json(result);
    }

    return Response.json({ error: "Noto‘g‘ri amal." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Budget amali bajarilmadi.";
    return Response.json({ error: message,
      operation_pending: Boolean((error as any)?.operation_pending),
      operation_reversed: Boolean((error as any)?.operation_reversed),
    }, { status: Number((error as any)?.status) || 500 });
  }
}