import React, {useEffect,useRef,useState} from 'react';
import {useOutletContext} from 'react-router-dom';
import {base44} from '@/api/base44Client';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {readAllEntityPages} from '@/lib/history-pagination';
import {formatUzbekistanDateTime,uzbekistanDateKey} from '@/lib/uzbekistan-time';
import {isReportOwner,reportIntent,reportNumber as n,shiftItemGroups} from '@/lib/ai-report';

export default function AIHisobot(){
 const {user,adminShopScope:scope}=useOutletContext();
 const owner=isReportOwner(user), shopId=scope?.specificShopId||'';
 const [question,setQuestion]=useState('oxirgi smena');
 const [text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
 const request=useRef(0);
 useEffect(()=>{request.current++;setText('');setError('');setBusy(false);setCopied(false);return()=>{request.current++;};},[shopId,user?.id,owner,scope?.ready]);
 async function load(mode){
  if(!owner||!scope?.ready||!shopId)return;
  if(!mode){setError('“Oxirgi smena” yoki “bugun” deb yozing. Boshqa savollar bu birinchi versiyada qo‘llanmaydi.');return;}
  const version=++request.current,isCurrent=()=>version===request.current;
  setBusy(true);setText('');setError('');setCopied(false);
  const cutoff=new Date(),day=uzbekistanDateKey(cutoff);
  try{
   const shop=scope.shops.find(s=>s.id===shopId);if(!shop)throw Error('Do‘kon tanlanmagan.');
   let lines=['ODINA · '+shop.name,'Asia/Tashkent · So‘rov vaqti: '+formatUzbekistanDateTime(cutoff)];
   if(mode==='today'){
    const res=await base44.functions.invoke('daily-sales-export',{action:'range',date_from:day,date_to:day});
    if(!Array.isArray(res.data?.shops))throw Error('Server hisoboti to‘liq kelmadi.');
    const row=res.data.shops.find(s=>s.shop_id===shopId);
    if(!row)throw Error('Bu do‘kon uchun server hisoboti qaytmadi. Nol deb ko‘rsatilmaydi.');
    const t=row.totals;
    lines.push('Bugun: '+day+' · 00:00 dan hisobot so‘rovi davomida o‘qilgan holatgacha (jonli hisob)','Serverga yetib kelgan ma’lumotlar. Sinxronlanmagan offline savdolar kirmaydi.','',
     'Kassa sof savdo: '+n(t.revenue)+' so‘m','Savdolar: '+n(t.sales),
     'Buyurtma to‘lovlari: '+n(t.orderPayments)+' so‘m','Jami olingan pul: '+n(t.collections)+' so‘m',
     '','Bugungi mahsulotlar kesimi ushbu versiyada yo‘q. Mahsulotlar uchun “Oxirgi smena”ni tanlang.');
   }else{
    const shifts=await base44.entities.Shift.filter({shop_id:shopId,status:'closed'},'-closed_at',1);
    const shift=shifts?.[0];if(!shift||shift.shop_id!==shopId||shift.status!=='closed'||!shift.closed_at)throw Error('Yopilgan smena topilmadi.');
    const [sales,items,products,categories]=await Promise.all([
     readAllEntityPages(base44.entities.Sale,{shift_id:shift.id,shop_id:shopId},'id',isCurrent),
     readAllEntityPages(base44.entities.SaleItem,{shift_id:shift.id,shop_id:shopId},'id',isCurrent),
     readAllEntityPages(base44.entities.Product,{},'id',isCurrent),
     readAllEntityPages(base44.entities.Category,{},'id',isCurrent)]);
    const grouped=shiftItemGroups(sales.filter(s=>s.shift_id===shift.id&&s.shop_id===shopId),items,products,categories);
    lines.push('Oxirgi yopilgan smena: '+formatUzbekistanDateTime(shift.opened_at||shift.created_date)+' — '+formatUzbekistanDateTime(shift.closed_at),
     'Smena: '+shift.id,'','Yopilishdagi saqlangan jami savdo: '+n(shift.total_sales)+' so‘m',
     'Saqlangan cheklar: '+n(shift.order_count),'Saqlangan qaytarishlar: '+n(shift.refunds_total)+' so‘m','',
     'MAHSULOT QATORLARI',
     'Yakunlangan va keyin qaytarilgan savdolarning asl qatorlari. Qaytarishlar miqdordan ayrilmagan. Qator summalari sof tushum bilan bir xil bo‘lishi shart emas.',
     'Kategoriyalar tarixiy nom bo‘lmasa joriy katalogdan olinadi; noma’lumlar alohida.');
    if(grouped.missing)lines.push('DIQQAT: '+grouped.missing+' ta savdoda mahsulot qatorlari yo‘q. Quyidagi ro‘yxat to‘liq emas.');
    for(const group of grouped.groups){lines.push('',group.name);for(const r of group.rows)lines.push(r.name+' — '+(r.unknown?'ma’lumot yetishmaydi':n(r.quantity)+' '+r.unit+' — '+n(r.amount)+' so‘m'));lines.push('Qatorlar jami: '+n(group.subtotal)+' so‘m');}
    if(!grouped.groups.length)lines.push('Mahsulot qatorlari topilmadi.');
   }
   if(isCurrent())setText(lines.join('\n'));
  }catch(e){if(isCurrent())setError(e?.response?.data?.error||e.message||'Hisobot yuklanmadi.');}
  finally{if(isCurrent())setBusy(false);}
 }
 if(!owner)return <div className="p-8" role="alert">Bu sahifa faqat tasdiqlangan biznes egasi uchun.</div>;
 return <div className="odina-page p-5 sm:p-8 max-w-5xl mx-auto space-y-5">
 <header><p className="text-sm text-muted-foreground">FAQAT O‘QISH · EGASI UCHUN</p><h1 className="text-3xl font-bold mt-2">AI Hisobot</h1><p className="mt-3 text-muted-foreground">Oddiy so‘rovdan tekshiriladigan hisobot. Bu versiya qoidalar asosida ishlaydi, tashqi AI yoki pulli obuna ishlatilmaydi.</p></header>
 <section className="rounded-2xl border bg-card p-5 space-y-4">
 <p>Do‘kon: <strong>{scope?.shops?.find(s=>s.id===shopId)?.name||'Yuqoridagi ish joyi menyusidan bitta do‘konni tanlang'}</strong></p>
 <form className="flex flex-col sm:flex-row gap-3" onSubmit={e=>{e.preventDefault();void load(reportIntent(question));}}>
 <Input aria-label="Hisobot so‘rovi" value={question} onChange={e=>setQuestion(e.target.value)} placeholder="Masalan: oxirgi smena" maxLength={160}/>
 <Button disabled={busy||!shopId||!scope?.ready}>Hisobot olish</Button></form>
 <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={busy||!shopId} onClick={()=>{setQuestion('oxirgi smena');void load('shift');}}>Oxirgi yopilgan smena</Button><Button variant="outline" disabled={busy||!shopId} onClick={()=>{setQuestion('bugun');void load('today');}}>Bugungi server hisobi</Button></div>
 <p className="text-xs text-muted-foreground">Savdo, to‘lov, ombor va sozlamalar o‘zgartirilmaydi. Pul jamlari mavjud server hisoboti yoki smena yopilishidagi saqlangan qiymatlardan olinadi.</p></section>
 {busy&&<p role="status">Hisobot yuklanmoqda…</p>}{error&&<p role="alert" className="text-destructive">{error}</p>}
 {text&&<section className="rounded-2xl border bg-card p-5"><Button variant="outline" className="mb-5" onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);}catch{setError('Nusxalab bo‘lmadi. Hisobot matnini belgilang va nusxalang.');}}}>{copied?'Nusxalandi':'Hisobotni nusxalash'}</Button><pre className="whitespace-pre-wrap break-words text-sm leading-7 font-sans">{text}</pre></section>}
 </div>;
}
