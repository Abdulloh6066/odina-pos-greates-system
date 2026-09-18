import React from 'react';
import { AlertTriangle, FlaskConical } from 'lucide-react';
import { formatUZS } from '@/lib/pos';
import {
  aggregateReport,
  costPerPiece,
  recipeCostFromMap,
  weightedAvgIngredientCost,
} from '../../../base44/shared/cost-engine.ts';

// This demo uses the REAL pure cost engine with in-memory example purchase lines.
// It never creates products, receipts, stock movements, sales or financial records.
// Keep it visible until the owner explicitly approves its removal.
const EXAMPLE_INGREDIENTS = [
  { id: 'flour', name: 'Un', quantity: 1000, unit: 'g', purchaseQuantity: 1, purchaseUnit: 'kg', purchasePrice: 16000, purchaseLabel: '16 000 / kg' },
  { id: 'curd', name: 'Tvarog', quantity: 1000, unit: 'g', purchaseQuantity: 1, purchaseUnit: 'kg', purchasePrice: 48000, purchaseLabel: '48 000 / kg' },
  { id: 'sugar', name: 'Shakar', quantity: 400, unit: 'g', purchaseQuantity: 1, purchaseUnit: 'kg', purchasePrice: 14000, purchaseLabel: '14 000 / kg' },
  { id: 'butter', name: 'Sariyog‘', quantity: 200, unit: 'g', purchaseQuantity: 1, purchaseUnit: 'kg', purchasePrice: 90000, purchaseLabel: '90 000 / kg' },
  { id: 'egg', name: 'Tuxum', quantity: 4, unit: 'piece', purchaseQuantity: 1, purchaseUnit: 'piece', purchasePrice: 2000, purchaseLabel: '2 000 / dona' },
  { id: 'vanilla', name: 'Vanilin', quantity: 1, unit: 'piece', purchaseQuantity: 1, purchaseUnit: 'piece', purchasePrice: 2000, purchaseLabel: '2 000 / paket' },
  { id: 'powder', name: 'Razrixlitel', quantity: 1, unit: 'piece', purchaseQuantity: 1, purchaseUnit: 'piece', purchasePrice: 2000, purchaseLabel: '2 000 / paket' },
];

const PIECES_PER_SHEET = 20;
const SAMPLE_SALE_PIECES = 3;
const SAMPLE_SELLING_PRICE = 5000;

const exampleCosts = new Map(EXAMPLE_INGREDIENTS.map((ingredient) => [
  ingredient.id,
  weightedAvgIngredientCost([{
    purchase_quantity: ingredient.purchaseQuantity,
    purchase_unit: ingredient.purchaseUnit,
    line_total: ingredient.purchasePrice,
  }]),
]));

const recipeItems = EXAMPLE_INGREDIENTS.map((ingredient) => ({
  ingredient_id: ingredient.id,
  ingredient_name_snapshot: ingredient.name,
  quantity: ingredient.quantity,
  unit: ingredient.unit,
}));

const recipeResult = recipeCostFromMap(recipeItems, exampleCosts);
const unitCost = costPerPiece(recipeResult.batchCost, 1, 'sheet', PIECES_PER_SHEET);
const sampleRevenue = SAMPLE_SALE_PIECES * SAMPLE_SELLING_PRICE;
const exampleReport = aggregateReport(
  [{ id: 'example-sale', status: 'completed' }],
  [{ id: 'example-item', sale_id: 'example-sale', product_id: 'example-tvarojni', product_name_snapshot: 'Tvarojni', quantity: SAMPLE_SALE_PIECES, line_total: sampleRevenue }],
  new Map([['example-item', { unitCost, isEstimate: false, unknown: false }]]),
);

const exampleRows = EXAMPLE_INGREDIENTS.map((ingredient) => ({
  ...ingredient,
  total: ingredient.quantity * exampleCosts.get(ingredient.id).cost,
}));

export default function TvarojniCostDemo() {
  return (
    <section data-testid="tvarojni-cost-demo" className="rounded-2xl border-2 border-brand-olive/45 bg-card premium-shadow p-4 sm:p-6 mb-6 space-y-4" aria-label="Tvarojni tannarx sinovi">
      <div className="flex flex-wrap gap-3 items-start justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-brand-ink"><FlaskConical className="w-4 h-4" /> Sinov · faqat ko‘rish uchun</p>
          <h2 className="font-display text-xl font-bold mt-1">Tvarojni — 1 list / 20 bo‘lak</h2>
          <p className="text-xs text-muted-foreground mt-1">Haqiqiy tannarx tizimining hisoblash formulalari bilan namunaviy sinov.</p>
        </div>
        <span className="rounded-full border border-amber-300 bg-amber-50 text-amber-900 text-xs font-semibold px-3 py-1.5">Haqiqiy ma’lumot emas</span>
      </div>

      <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-950">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <p>Barcha xarid narxlari va qo‘shimcha masalliqlar taxminiy. Bu bo‘lim bazaga yozmaydi, ombor qoldig‘ini yoki haqiqiy savdo va foyda hisobotini o‘zgartirmaydi. Egasi bilan kelishmaguncha sinov bo‘limi saqlanadi.</p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-secondary/60 text-muted-foreground text-xs">
            <tr>
              <th scope="col" className="text-left p-3 font-semibold">Masalliq</th>
              <th scope="col" className="text-right p-3 font-semibold">Retsept</th>
              <th scope="col" className="text-right p-3 font-semibold">Namunaviy xarid narxi</th>
              <th scope="col" className="text-right p-3 font-semibold">Sarflangan tannarx</th>
            </tr>
          </thead>
          <tbody>
            {exampleRows.map((ingredient) => (
              <tr key={ingredient.id} className="border-t border-border">
                <td className="p-3 font-medium">{ingredient.name}</td>
                <td className="p-3 text-right">{ingredient.quantity} {ingredient.unit === 'piece' ? 'dona/paket' : ingredient.unit}</td>
                <td className="p-3 text-right text-muted-foreground">{ingredient.purchaseLabel}</td>
                <td className="p-3 text-right font-medium">{formatUZS(ingredient.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-secondary/45 border-t-2 border-border">
            <tr>
              <th scope="row" colSpan={3} className="p-3 text-left font-semibold">Jami 1 list masalliqlar tannarxi</th>
              <td className="p-3 text-right font-bold">{recipeResult.hasAllPrices ? formatUZS(recipeResult.batchCost) : 'Narxlar yetishmaydi'}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground">1 list tannarxi</p>
          <p className="font-bold text-xl mt-1">{formatUZS(recipeResult.batchCost)}</p>
        </div>
        <div className="rounded-xl border border-brand-olive/40 bg-brand-olive/10 p-4">
          <p className="text-xs text-muted-foreground">1 bo‘lak tannarxi</p>
          <p className="font-bold text-xl text-brand-ink mt-1">{formatUZS(unitCost)}</p>
        </div>
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs text-muted-foreground">3 bo‘lak tannarxi</p>
          <p className="font-bold text-xl mt-1">{formatUZS(exampleReport.summary.cost_of_goods)}</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Faqat tushuntirish uchun: 3 bo‘lakning taxminiy sotuv narxi {formatUZS(SAMPLE_SELLING_PRICE)} / dona bo‘lsa, tushum {formatUZS(exampleReport.summary.net_revenue)}, yalpi foyda {formatUZS(exampleReport.summary.gross_profit)} bo‘ladi. Bu haqiqiy savdo emas; ish haqi, elektr, ijara va qadoqlash kiritilmagan.</p>
      <p className="text-xs font-semibold text-brand-ink">Quyidagi odatiy «Tannarx va foyda» hisoboti o‘z holicha ishlaydi va bu namunani o‘z ichiga olmaydi.</p>
    </section>
  );
}
