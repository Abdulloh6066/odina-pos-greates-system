// Shared customer helpers used by order/sale backend functions.
// Phone normalization is intentionally pure so the client and server agree
// on the lookup key used to match existing customers.

export function normalizePhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("998")) return digits;
  if (digits.length === 9) return "998" + digits;
  if (digits.startsWith("8") && digits.length === 10) return "998" + digits.slice(1);
  return digits;
}

export function splitFullName(name: string): { first_name: string; last_name: string } {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || "Mijoz",
    last_name: parts.slice(1).join(" "),
  };
}

/**
 * Resolves a customer for an order/sale: prefer an explicit customer_id,
 * then an existing customer matched by normalized phone, and finally create
 * a minimal customer record so every order/sale links to a real customer.
 * Runs as the service role, so caller RLS does not block creation.
 */
export async function ensureCustomer(
  service: any,
  input: { customer_id?: string; name?: string; phone?: string },
): Promise<{ customer_id: string; customer: any | null }> {
  const explicitId = String(input?.customer_id || "").trim();
  if (explicitId) {
    const existing = await service.entities.Customer.get(explicitId).catch(() => null);
    if (existing) return { customer_id: existing.id, customer: existing };
  }

  const phone = String(input?.phone || "").trim();
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return { customer_id: "", customer: null };

  const matches = await service.entities.Customer.filter({ phone_normalized: phoneNormalized });
  if (matches && matches.length) {
    return { customer_id: matches[0].id, customer: matches[0] };
  }

  const { first_name, last_name } = splitFullName(String(input?.name || ""));
  try {
    const created = await service.entities.Customer.create({
      first_name,
      last_name,
      phone,
      phone_normalized: phoneNormalized,
      birth_date: "",
      label: "",
      notes: "",
    });
    return { customer_id: created.id, customer: created };
  } catch {
    // If creation fails (e.g. race), fall back to no link rather than failing the order.
    return { customer_id: "", customer: null };
  }
}