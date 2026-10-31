// Inventory quantities can contain halves or three-decimal base units.
// Money and whole-number counters keep their separate formatting.
export function formatInventoryQuantity(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })
    .format(Number(value ?? 0)).replaceAll(',', ' ');
}
