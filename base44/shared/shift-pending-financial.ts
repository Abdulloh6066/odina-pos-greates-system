// Close only after every claimed order and supplier payment has finished.
export function pendingFinancialCloseGuard(shift: any) {
  const predicate: any = {};
  for (const [field, stateField, finished] of [
    ["supplier_payment_operations_json", "status", ["completed", "reversed"]],
    ["order_payment_operations_json", "state", ["applied"]],
  ] as const) {
    let journal;
    try {
      const raw = shift[field];
      if (raw !== undefined && raw !== null && typeof raw !== "string") throw new Error();
      journal = raw === undefined || raw === null || raw === "" ? {} : JSON.parse(raw);
      if (!journal || typeof journal !== "object" || Array.isArray(journal)) throw new Error();
    } catch {
      throw Object.assign(new Error("Smena to‘lovlari holatini egasi tekshirishi kerak."), { status: 409 });
    }
    if (Object.values(journal).some((operation: any) => !(finished as readonly string[]).includes(operation?.[stateField]))) {
      throw Object.assign(new Error("Smena to‘lovi yakunlanmagan. Avval saqlangan so‘rovni tekshiring."), { status: 409 });
    }
    predicate[field] = shift[field] === undefined ? { $exists: false } : shift[field];
  }
  return predicate;
}
