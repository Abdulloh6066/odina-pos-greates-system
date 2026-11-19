import {categoryRank,reportNumber as n} from './ai-report.js';
const number = v => v!==null && v!==undefined && v!=='' && typeof v!=='boolean' && Number.isFinite(Number(v)) ? Number(v) : null;
const required = v => {const x=number(v);if(x===null||x<0)throw Error('Tarixiy qiymat yetishmaydi. Hisobot to‘liq emas.');return x;};
const close = (a,b) => Math.abs(a-b)<0.01;
// Match the accounting report: a raw refund row can exist before its sale is marked refunded.
export function selectReportRefunds(refunds, originals){
 const saleMap=new Map(originals.map(sale=>[sale.id,sale]));
 return refunds.filter(refund=>{
  const sale=saleMap.get(refund.sale_id);
  if(!sale||sale.shop_id!==refund.shop_id)throw Error('Qaytarilgan savdoning asl yozuvi topilmadi. Hisobotni tekshiring.');
  return sale.status==='refunded'&&(!sale.refund_id||sale.refund_id===refund.id);
 });
}

export function conciseShiftReport({sales,items,products=[],categories=[],refunds=[]}){
 const valid=sales.filter(s=>['completed','refunded'].includes(s.status));
 const bySale=new Map();for(const i of items){const a=bySale.get(i.sale_id)||[];a.push(i);bySale.set(i.sale_id,a);}
 const ps=new Map(products.map(p=>[p.id,p])),cs=new Map(categories.map(c=>[c.id,c.name]));
 const groups=new Map(), payments={cash:0,card:0,online:0,other:0};
 let total=0,pieces=0,grams=0;
 for(const sale of valid){
  const saleTotal=required(sale.total);total+=saleTotal;
  const recorded=bySale.get(sale.id), rows=recorded?.length?recorded:sale.items;
  if(!Array.isArray(rows)||!rows.length||recorded?.length&&sale.sale_items_count>0&&recorded.length!==sale.sale_items_count)throw Error('Savdo mahsulotlari to‘liq yuklanmadi.');
  let rowTotal=0;
  for(const i of rows){
   const qty=required(i.quantity),unit=i.sale_unit==='gram'?'g':'ta';
   let amount=number(i.line_total);
   // Legacy embedded subtotal is gross. Only use it when recorded receipt discount is explicitly zero.
   if(amount===null&&!recorded?.length&&number(sale.discount_amount)===0)amount=number(i.subtotal);
   if(amount===null||amount<0)throw Error('Chegirmadan keyingi tarixiy mahsulot summasi yo‘q. Taxminiy hisobot tuzilmadi.');
   rowTotal+=amount; if(unit==='g')grams+=qty;else pieces+=qty;
   const p=ps.get(i.product_id),category=i.category_name_snapshot||cs.get(p?.shop_category_ids?.[sale.shop_id]||p?.category_id)||'Kategoriyasi noma’lum';
   const name=i.product_name_snapshot||i.product_name||'Noma’lum mahsulot';
   const key=JSON.stringify([i.product_id,name,unit,i.fries_option,i.tea_option,i.cake_extra]);
   if(!groups.has(category))groups.set(category,new Map());
   const map=groups.get(category),r=map.get(key)||{name,unit,quantity:0,amount:0};
   r.quantity+=qty;r.amount+=amount;map.set(key,r);
  }
  if(!close(rowTotal,saleTotal))throw Error('Mahsulot summalari chek jami bilan mos emas. Hisobotni tekshirish kerak.');
  if(!Array.isArray(sale.payments))throw Error('Chekning to‘lov ma’lumoti yo‘q.');
  let paid=0;
  for(const p of sale.payments){const amount=required(p.amount);paid+=amount;
   const key=p.method==='cash'?'cash':['bank_card','uzcard','humo'].includes(p.method)?'card':['online','click','payme'].includes(p.method)?'online':'other';
   payments[key]+=amount;
  }
  if(!close(paid,saleTotal))throw Error('To‘lovlar chek jami bilan mos emas. Hisobotni tekshirish kerak.');
 }
 const refundTotal=refunds.reduce((s,r)=>s+required(r.amount),0);
 const lines=['Jami savdo: '+n(total)+' so‘m',n(valid.length)+' ta chek · '+n(pieces)+' ta mahsulot'+(grams?' · '+n(grams)+' g':''),'','Qatorlarda: soni · jami summa, so‘m.'];
 for(const [name,map] of [...groups].sort((a,b)=>categoryRank(a[0])-categoryRank(b[0])||a[0].localeCompare(b[0],'uz'))){
  lines.push('',name);let amount=0,count=0,weight=0;
  for(const r of map.values()){lines.push('- '+r.name+' — '+n(r.quantity)+' '+r.unit+' · '+n(r.amount));amount+=r.amount;if(r.unit==='g')weight+=r.quantity;else count+=r.quantity;}
  lines.push('Jami: '+(count?n(count)+' ta':'')+(count&&weight?' + ':'')+(weight?n(weight)+' g':'')+(!count&&!weight?'0 ta':'')+' · '+n(amount));
 }
 lines.push('','To‘lovlar','Naqd — '+n(payments.cash)+' so‘m','Karta — '+n(payments.card)+' so‘m','Online — '+n(payments.online)+' so‘m');
 if(payments.other)lines.push('Boshqa / bank o‘tkazmasi — '+n(payments.other)+' so‘m');
 if(refundTotal)lines.push('','Qaytarishlar — '+n(refundTotal)+' so‘m','Qaytarishdan keyingi sof savdo — '+n(total-refundTotal)+' so‘m');
 return {text:lines.join('\n'),total,receipts:valid.length,pieces,grams,payments,refundTotal};
}
