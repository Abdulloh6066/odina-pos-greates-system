// Read-only presentation of immutable historical rows; never a posting calculator.
export const isReportOwner = u => u?.role === 'admin' && u.active !== false && u.data?.active !== false && (u.is_owner === true || u.data?.is_owner === true);
export function reportIntent(text) {
 const q=String(text||'').trim().toLowerCase();
 if (/^(bugun|bugungi (savdo|hisobot)|today|today report)$/.test(q)) return 'today';
 if (/^(oxirgi smena|oxirgi smena hisoboti|last shift|last closed shift|hisobot)$/.test(q)) return 'shift';
 return null;
}
export const reportNumber = n => Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n).toLocaleString('en-US',{maximumFractionDigits:3}).replace(/,/g,' ') : 'noma’lum';
// Saved amounts only. A net line without its allocated discount is not gross.
const savedNumber = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
export function historicalLineGross(item) {
 const subtotal = savedNumber(item.subtotal);
 if (subtotal !== null && subtotal >= 0) return subtotal;
 const net = savedNumber(item.line_total), discount = savedNumber(item.discount_amount);
 if (net !== null && discount !== null && net >= 0 && discount >= 0) return net + discount;
 const price = savedNumber(item.unit_price ?? item.price), quantity = savedNumber(item.quantity);
 // Gram prices in complete-sale are per kilogram; never infer a missing legacy unit.
 if (price !== null && price >= 0 && quantity !== null && quantity >= 0 && ['piece','gram'].includes(item.sale_unit)) {
  return Math.round(price * quantity / (item.sale_unit === 'gram' ? 1000 : 1));
 }
 return null;
}
export function historicalReceiptTotals(sales) {
 const rows = sales.filter(s => ['completed','refunded'].includes(s.status));
 const sum = key => rows.every(s => savedNumber(s[key]) !== null && savedNumber(s[key]) >= 0)
  ? rows.reduce((total,s) => total + savedNumber(s[key]),0) : null;
 return {gross:sum('subtotal'),discount:sum('discount_amount'),net:sum('total')};
}
export const categoryRank = name => /tort|cake/i.test(name) ? 0 : /ovqat|food|taom|fast.?food/i.test(name) ? 1 : /ichimlik|drink|choy|kofe|coffee|limonad|smuzi/i.test(name) ? 2 : 3;
export function shiftItemGroups(sales, items, products, categories) {
 const bySale = new Map(); for(const i of items) {const rows=bySale.get(i.sale_id)||[]; rows.push(i);bySale.set(i.sale_id,rows);}
 const ps=new Map(products.map(p=>[p.id,p])), cs=new Map(categories.map(c=>[c.id,c.name]));
 const groups=new Map(); let missing=0;
 for(const sale of sales.filter(s=>['completed','refunded'].includes(s.status))){
  const rows=bySale.get(sale.id)||sale.items||[];
  if(!rows.length) missing++;
  for(const i of rows){
   const category=i.category_name_snapshot||cs.get(ps.get(i.product_id)?.category_id)||'Kategoriyasi noma’lum';
   const name=i.product_name_snapshot||i.product_name||'Noma’lum mahsulot';
   const unit=i.sale_unit==='gram'?'g':'dona/porsiya';
   const key=JSON.stringify([i.product_id||name,name,unit]);
   if(!groups.has(category))groups.set(category,new Map());
   const group=groups.get(category),r=group.get(key)||{name,unit,quantity:0,amount:0,unknown:false};
   const qty=savedNumber(i.quantity), amount=historicalLineGross(i);
   if(qty===null||qty<0||amount===null)r.unknown=true;
   else {r.quantity+=qty;r.amount+=amount;}
   group.set(key,r);
  }
 }
 return {missing,groups:[...groups].sort((a,b)=>categoryRank(a[0])-categoryRank(b[0])||a[0].localeCompare(b[0],'uz')).map(([name,rows])=>({name,rows:[...rows.values()],subtotal:[...rows.values()].some(r=>r.unknown)?null:[...rows.values()].reduce((s,r)=>s+r.amount,0)}))};
}
