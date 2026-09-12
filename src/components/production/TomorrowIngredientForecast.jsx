import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, PackageSearch } from 'lucide-react';

const UNIT_LABELS = {
  g: 'g',
  ml: 'ml',
  piece: 'dona',
};

const formatQuantity = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '0';
  return parsed.toLocaleString('uz-UZ', { maximumFractionDigits: 3 });
};

export default function TomorrowIngredientForecast({ forecast, loading, error }) {
  if (loading) {
    return (
      <div className="mb-4 rounded-2xl border border-border bg-card p-4 flex items-center gap-3">
        <Loader2 className="w-5 h-5 animate-spin text-brand-olive shrink-0" />
        <div>
          <p className="text-sm font-semibold">Ertangi masalliqlar hisoblanmoqda…</p>
          <p className="text-xs text-muted-foreground">Buyurtmalar, tex-kartalar va markaziy ombor solishtirilmoqda.</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-amber-900">Masalliq nazoratini yuklab bo‘lmadi</p>
          <p className="text-xs text-amber-800 mt-0.5 break-words">{error}</p>
        </div>
      </div>
    );
  }

  if (!forecast) return null;

  const shortages = Array.isArray(forecast.shortages) ? forecast.shortages : [];
  const issues = Array.isArray(forecast.issues) ? forecast.issues : [];
  const ingredientCount = Array.isArray(forecast.ingredient_requirements)
    ? forecast.ingredient_requirements.length
    : 0;
  const tomorrowOrders = Number(forecast.tomorrow_order_count || 0);

  if (tomorrowOrders === 0) {
    return (
      <div className="mb-4 rounded-2xl border border-border bg-card p-4 flex items-center gap-3">
        <PackageSearch className="w-5 h-5 text-brand-olive shrink-0" />
        <div>
          <p className="text-sm font-semibold">Ertangi masalliq nazorati</p>
          <p className="text-xs text-muted-foreground">Ertaga tayyorlanadigan faol buyurtma yo‘q.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-2xl border border-border bg-card premium-shadow overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-secondary/40 flex flex-wrap items-center gap-2">
        <PackageSearch className="w-5 h-5 text-brand-olive shrink-0" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Ertangi masalliqlar nazorati</h3>
          <p className="text-xs text-muted-foreground truncate">
            {forecast.location?.name || 'Markaziy ombor'} · bugungi qolgan ishlar ham hisobga olingan
          </p>
        </div>
        <span className="ml-auto text-xs font-semibold bg-card border border-border rounded-full px-2.5 py-1">
          {tomorrowOrders} ta buyurtma
        </span>
      </div>

      <div className="p-4 space-y-3">
        {shortages.length > 0 ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-rose-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-rose-900">
                Ertagacha {shortages.length} turdagi masalliq yetishmaydi
              </p>
              <p className="text-xs text-rose-700 mt-0.5">
                Xarid yoki ombor kirimini oldindan rejalashtiring.
              </p>
            </div>
          </div>
        ) : issues.length === 0 && ingredientCount > 0 ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 flex items-start gap-2.5">
            <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-emerald-900">Masalliqlar yetarli</p>
              <p className="text-xs text-emerald-700 mt-0.5">
                Ertagacha kerak bo‘ladigan {ingredientCount} turdagi masalliq markaziy omborda bor.
              </p>
            </div>
          </div>
        ) : null}

        {shortages.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
            {shortages.map((row) => {
              const unit = UNIT_LABELS[row.unit] || row.unit;
              return (
                <div
                  key={`${row.ingredient_id}-${row.unit}`}
                  className="rounded-xl border border-rose-200 bg-card p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold">{row.ingredient_name}</p>
                    <span className="text-xs font-bold text-rose-700 whitespace-nowrap">
                      −{formatQuantity(row.missing)} {unit}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <Metric label="Bugun" value={`${formatQuantity(row.required_today)} ${unit}`} />
                    <Metric label="Ertaga" value={`${formatQuantity(row.required_tomorrow)} ${unit}`} />
                    <Metric label="Jami kerak" value={`${formatQuantity(row.required_total)} ${unit}`} />
                    <Metric label="Omborda bor" value={`${formatQuantity(row.available)} ${unit}`} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {issues.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <div className="flex items-center gap-2 text-amber-900">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <p className="text-sm font-semibold">Hisobni to‘ldirish kerak</p>
            </div>
            <ul className="mt-2 space-y-1 text-xs text-amber-800">
              {issues.map((issue, index) => (
                <li key={`${issue.type}-${issue.product_id || issue.ingredient_id || index}`}>
                  • {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {shortages.length === 0 && issues.length === 0 && ingredientCount === 0 && (
          <p className="text-xs text-muted-foreground">
            Ertangi buyurtmalarda markaziy ishlab chiqarish tex-kartasi talab qiladigan mahsulot yo‘q.
          </p>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-2.5 py-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-semibold text-foreground mt-0.5">{value}</div>
    </div>
  );
}
