// Read-only presentation of immutable historical rows; never a posting calculator.
export const isReportOwner = u => u?.role === 'admin' && u.active !== false && u.data?.active !== false && (u.is_owner === true || u.data?.is_owner === true);
export function reportIntent(text) {
 const q=String(text||'').trim().toLowerCase();
 if (/^(bugun|bugungi (savdo|hisobot)|today|today report)$/.test(q)) return 'today';
 if (/^(oxirgi smena|oxirgi smena hisoboti|last shift|last closed shift|hisobot)$/.test(q)) return 'shift';
 return null;
}
export const reportNumber = n => Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n).toLocaleString('en-US',{maximumFractionDigits:3}).replace(/,/g,' ') : 'noma’lum';
const categoryRank = name => /tort|cake/i.test(name) ? 0 : /ovqat|food|taom|fast.?food/i.test(name) ? 1 : /ichimlik|drink|choy|kofe|coffee|limonad|smuzi/i.test(name) ? 2 : 3;
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
   const qty=Number(i.quantity), amount=Number(i.line_total??i.subtotal);
   if(i.quantity==null||!Number.isFinite(qty)||i.line_total==null&&i.subtotal==null||!Number.isFinite(amount))r.unknown=true;
   else {r.quantity+=qty;r.amount+=amount;}
   group.set(key,r);
  }
 }
 return {missing,groups:[...groups].sort((a,b)=>categoryRank(a[0])-categoryRank(b[0])||a[0].localeCompare(b[0],'uz')).map(([name,rows])=>({name,rows:[...rows.values()],subtotal:[...rows.values()].some(r=>r.unknown)?null:[...rows.values()].reduce((s,r)=>s+r.amount,0)}))};
}
