// Offline benchmark ONLY. These seconds are not Base44/network saving times.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { basketCheckoutFixture } from '../helpers/basket-checkout.mjs';
const phase = process.argv[2] || 'after';
const count = Number(process.argv[3] || 10);
const samples = [];
for (const store of ['Central', 'Branch']) {
  for (const ingredientCount of [0, 2, 6]) {
    for (let run = 0; run < count; run++) {
      const f = basketCheckoutFixture(store, ingredientCount);
      const started = performance.now();
      const result = await f.call();
      const elapsedMs = performance.now() - started;
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Payment.length, 1);
      assert.equal(f.db.Shift[0].expected_cash, 20000);
      const cost = ingredientCount ? f.ingredients.reduce((sum, [, quantity, , price]) => sum + quantity * price, 0) : 0;
      assert.equal(f.db.SaleItem[0].unit_cost_at_sale, cost);
      const consumesIngredients = store === 'Branch' && ingredientCount > 0;
      assert.equal(f.db.ProductStock[0].quantity, consumesIngredients ? 100 : 99);
      for (const [id, quantity] of f.ingredients) {
        assert.equal(f.db.IngredientStock.find(row => row.ingredient_id === id).quantity,
          consumesIngredients ? 100000 - quantity : 100000);
      }
      const replay = await f.call();
      assert.equal(replay.data.already_processed, true);
      assert.equal(f.db.Sale.length, 1); assert.equal(f.db.Shift[0].expected_cash, 20000);
      samples.push({ store, ingredientCount, run: run + 1, elapsedMs,
        supplierRows: f.reads.reduce((sum, read) => sum + read.rows, 0),
        itemRows: f.reads.filter(read => read.entityName === 'SupplierReceiptItem').reduce((sum, read) => sum + read.rows, 0),
        supplierReads: f.reads.length });
    }
  }
}
const summary = ['Central', 'Branch'].flatMap(store => [0, 2, 6].map(ingredientCount => {
  const rows = samples.filter(row => row.store === store && row.ingredientCount === ingredientCount);
  const times = rows.map(row => row.elapsedMs).sort((a,b) => a-b);
  return { store, ingredientCount, runs: rows.length, meanMs: times.reduce((a,b) => a+b,0)/times.length,
    medianMs: times[Math.floor(times.length/2)], minMs: times[0], maxMs: times.at(-1),
    supplierRows: rows[0].supplierRows, itemRows: rows[0].itemRows, supplierReads: rows[0].supplierReads };
}));
const report = { phase, kind: 'offline in-memory benchmark; NOT real server saving seconds',
  successfulCheckouts: samples.length, successfulIdempotentReplays: samples.length, summary, samples };
writeFileSync('/tmp/odina-basket-' + phase + '.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
