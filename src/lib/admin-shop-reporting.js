// This is an admin viewing preference, never an authorization source.
export function adminReportingScope(user, scope) {
  return user?.role === 'admin' && scope?.isAdmin ? scope : null;
}

export function scopeReportingRows(rows, scope, field = 'shop_id') {
  if (!scope) return rows || [];
  if (scope.ready === false) return [];
  if (scope.shopId === 'all') return rows || [];
  return (rows || []).filter((row) => row[field] === scope.specificShopId);
}

export function scopeRangeReport(report, scope) {
  if (!report || !scope || (scope.shopId === 'all' && scope.ready !== false)) return report;
  const shop = scopeReportingRows(report.shops, scope)[0];
  const byDay = shop?.days || [];
  const grand = shop?.totals || {
    revenue: 0, cost: 0, profit: 0, sales: 0, refunds: 0,
    orderPayments: 0, collections: 0, expenses: 0, netProfit: 0,
    unknownCostCount: 0, cash: 0, uzcard: 0, humo: 0, online: 0, bank_transfer: 0,
  };
  return { ...report, shops: shop ? [shop] : [], byDay, grand, dates: byDay.map((day) => day.date) };
}
