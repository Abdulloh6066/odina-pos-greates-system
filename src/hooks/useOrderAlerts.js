import { useEffect, useMemo, useState } from 'react';
import { buildOrderAlerts } from '@/lib/order-alerts';

// Keeps order alerts current while the page is open WITHOUT extra API calls:
// it only re-evaluates the pure alert logic on the already-loaded orders every
// 30s (and whenever the orders array reference changes via existing realtime
// subscriptions). Permissions/RLS are preserved because `orders` comes from the
// same RLS-scoped list each page already fetches.
export function useOrderAlerts(orders) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const alerts = useMemo(() => buildOrderAlerts(orders, now), [orders, now]);

  const counts = useMemo(
    () => ({
      overdue: alerts.filter((a) => a.deadline.kind === 'overdue').length,
      due_soon: alerts.filter((a) => a.deadline.kind === 'due_soon').length,
      unpaid: alerts.filter((a) => a.unpaid).length,
      total: alerts.length,
    }),
    [alerts],
  );

  return { alerts, counts };
}