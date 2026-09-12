// Pure decision logic for "Ombor sanog'i" (physical stock counting).
// Imported by the backend function AND unit-tested offline (transpiled).
// No SDK access here — callers pass in records.

export const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
};

export function validateCountedQuantity(value: unknown, unit: string) {
  if (value === null || value === undefined || value === "") {
    return { value: null, error: "" };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) {
    return { value: null, error: "Sanalgan miqdor 0 yoki undan katta son bo‘lishi kerak." };
  }
  if (["piece", "sheet"].includes(String(unit || "")) && !Number.isSafeInteger(parsed)) {
    return { value: null, error: "Dona va list miqdori butun son bo‘lishi kerak." };
  }
  return { value: num(parsed), error: "" };
}

// Only the owner/admin may approve and apply stock adjustments.
export const canApprove = (role: string) => String(role || "") === "admin";

// Snapshot validation: before applying, the current stock quantity AND its
// version must still match what was captured when the count started.
// If sales, transfers or waste moved the stock in between, the row is "stale"
// and must be refreshed and recounted — it is never overwritten blindly.
export function classifyItem(item: any, currentStock: any) {
  const sysQ = num(item?.system_quantity);
  const sysV = String(item?.system_version || "");
  if (!currentStock) return { stale: true };
  const curQ = num(currentStock?.quantity);
  const curV = String(currentStock?.updated_date || currentStock?.updated_at || "");
  if (curQ !== sysQ || curV !== sysV) return { stale: true };
  const after = num(item?.counted_quantity);
  return { stale: false, before: curQ, after, change: after - curQ };
}

export function summarizeCount(items: any[]) {
  const list = items || [];
  let counted = 0;
  let diffItems = 0;
  let net = 0;
  for (const it of list) {
    if (it?.was_counted) {
      counted++;
      const d = num(it?.difference);
      if (d !== 0) diffItems++;
      net += d;
    }
  }
  return {
    total_items: list.length,
    counted_items: counted,
    difference_items: diffItems,
    net_difference: Math.round(net * 1000) / 1000,
  };
}

// Items still needing an adjustment: counted, non-zero difference, not yet applied, not stale.
export function pendingItems(items: any[]) {
  return (items || []).filter((it: any) =>
    it?.was_counted && num(it?.difference) !== 0 && !it?.applied && !it?.stale,
  );
}

// Approval is complete only when every counted difference has been applied
// and no row is stale (stale rows require a refresh + recount first).
export function isApprovalComplete(items: any[]) {
  const list = items || [];
  for (const it of list) {
    if (!it?.was_counted) continue;
    if (num(it?.difference) === 0) continue;
    if (it?.stale) return false;
    if (!it?.applied) return false;
  }
  return true;
}