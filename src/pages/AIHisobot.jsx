import React,{useCallback,useEffect,useRef,useState} from 'react';
import {useOutletContext} from 'react-router-dom';
import {base44} from '@/api/base44Client';
import {Button} from '@/components/ui/button';
import {readAllEntityPages,salesHistoryQuery} from '@/lib/history-pagination';
import {formatUzbekistanDateTime,uzbekistanDateKey} from '@/lib/uzbekistan-time';
import {isReportOwner} from '@/lib/ai-report';
import {conciseShiftReport,selectReportRefunds} from '@/lib/concise-ai-report';

export default function AIHisobot(){
 const {user,adminShopScope:scope}=useOutletContext();
 const owner=isReportOwner(user),shopId=scope?.specificShopId||'',scopeReady=scope?.ready===true;
 const shopName=scope?.shops?.find(s=>s.id===shopId)?.name||'';
 const userId=user?.id,userRole=user?.role;
 const [mode,setMode]=useState('open'),[text,setText]=useState(''),[context,setContext]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
 const request=useRef(0);
 const load=useCallback(async()=>{
  if(!owner||!scopeReady||!shopId||!shopName)return;
  const version=++request.current,isCurrent=()=>version===request.current;
  setBusy(true);setText('');setContext('');setError('');setCopied(false);
  const cutoff=new Date(),cutoffISO=cutoff.toISOString(),day=uzbekistanDateKey(cutoff);
  try{
   let shift=null;
   if(mode!=='today'){
    const status=mode==='open'?'open':'closed';
    const shifts=await base44.entities.Shift.filter({shop_id:shopId,status},mode==='open'?'-opened_at':'-closed_at',mode==='open'?2:1);
    if(!Array.isArray(shifts)||!shifts.length)throw Error(mode==='open'?'Ochiq smena topilmadi.':'Yopilgan smena topilmadi.');
    if(mode==='open'&&shifts.length>1)throw Error('Bu do‘konda bir nechta ochiq smena bor. Avval Smenalar sahifasida aniqlashtiring.');
    shift=shifts[0];
    if(shift.shop_id!==shopId||shift.status!==status)throw Error('Smena do‘koni yoki holati mos kelmadi.');
   }
   const saleQuery=shift?{shop_id:shopId,shift_id:shift.id}:salesHistoryQuery({user:{id:userId,role:userRole},date:day,shop_id:shopId});
   const refundQuery=shift?{shop_id:shopId,shift_id:shift.id}:{$and:[{shop_id:shopId},{$or:[{created_at:{$gte:new Date(day+'T00:00:00+05:00').toISOString(),$lte:cutoffISO}},{created_at:{$exists:false},created_date:{$gte:new Date(day+'T00:00:00+05:00').toISOString(),$lte:cutoffISO}}]}]};
   const [loadedSales,products,categories,refunds]=await Promise.all([
    readAllEntityPages(base44.entities.Sale,{$and:[saleQuery,{created_date:{$lte:cutoffISO}}]},'id',isCurrent),
    readAllEntityPages(base44.entities.Product,{},'id',isCurrent),
    readAllEntityPages(base44.entities.Category,{},'id',isCurrent),
    readAllEntityPages(base44.entities.Refund,{$and:[refundQuery,{created_date:{$lte:cutoffISO}}]},'id',isCurrent)]);
   if(!isCurrent())return;
   const sales=loadedSales.filter(s=>s.shop_id===shopId&&(!shift||s.shift_id===shift.id));
   const items=[];
   // Bounded batches, complete pagination, no all-history SaleItem download.
   for(let start=0;start<sales.length&&isCurrent();start+=50){
    items.push(...await readAllEntityPages(base44.entities.SaleItem,{shop_id:shopId,sale_id:{$in:sales.slice(start,start+50).map(s=>s.id)}},'id',isCurrent));
   }
   const scopedRefunds=refunds.filter(r=>r.shop_id===shopId&&(!shift||r.shift_id===shift.id));
   const saleIds=new Set(sales.map(s=>s.id));
   const missingOriginalIds=[...new Set(scopedRefunds.map(r=>r.sale_id).filter(id=>id&&!saleIds.has(id)))];
   const originals=[...sales];
   // A refund can happen in a later shift than the original receipt.
   for(let start=0;start<missingOriginalIds.length&&isCurrent();start+=50){
    originals.push(...await readAllEntityPages(base44.entities.Sale,{shop_id:shopId,id:{$in:missingOriginalIds.slice(start,start+50)}},'id',isCurrent));
   }
   if(!isCurrent())return;
   const result=conciseShiftReport({sales,items,products,categories,refunds:selectReportRefunds(scopedRefunds,originals)});
   if(isCurrent()){
    setText(result.text);
    setContext(shopName+' · '+(shift?(mode==='open'?'Hozirgi ochiq smena':'Oxirgi yopilgan smena')+' · '+formatUzbekistanDateTime(shift.opened_at||shift.created_date)+' — '+formatUzbekistanDateTime(shift.closed_at||cutoff):'Bugun · '+day)+' · Yuklangan: '+formatUzbekistanDateTime(cutoff));
   }
  }catch(e){if(isCurrent())setError(e?.response?.data?.error||e.message||'Hisobot yuklanmadi.');}
  finally{if(isCurrent())setBusy(false);}
 },[owner,scopeReady,shopId,shopName,userId,userRole,mode]);
 useEffect(()=>{
  if(owner&&scopeReady&&shopId&&shopName)void load();
  else{setText('');setContext('');setError('');setBusy(false);setCopied(false);}
  return()=>{request.current++;};
 },[load,owner,scopeReady,shopId,shopName]);
 if(!owner)return <div className="p-8" role="alert">Bu sahifa faqat tasdiqlangan biznes egasi uchun.</div>;
 return <div className="odina-page p-5 sm:p-8 max-w-4xl mx-auto space-y-5">
 <header><h1 className="text-3xl font-bold">AI Hisobot</h1><p className="mt-2 text-muted-foreground">{scopeReady?(shopName||'Ish joyi menyusidan bitta do‘konni tanlang'):'Do‘konlar yuklanmoqda…'}</p></header>
 <div className="flex flex-wrap gap-2" aria-label="Hisobot davri">{[['open','Hozirgi smena'],['closed','Oxirgi yopilgan smena'],['today','Bugun']].map(([value,label])=><Button key={value} variant={mode===value?'default':'outline'} aria-pressed={mode===value} onClick={()=>setMode(value)}>{label}</Button>)}<Button variant="outline" disabled={busy||!shopName||!scopeReady} onClick={()=>void load()}>{busy?'Yuklanmoqda…':'Hisobotni yangilash'}</Button></div>
 {error&&<p role="alert" className="text-destructive">{error}</p>}
 {text&&<section className="rounded-2xl border bg-card p-5 space-y-4">
 <p className="text-xs text-muted-foreground">{context}</p>
 <Button onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);}catch{setError('Nusxalab bo‘lmadi. Matnni belgilang va nusxalang.');}}}>{copied?'Nusxalandi':'Hisobotni nusxalash'}</Button>
 <div className="whitespace-pre-wrap break-words text-sm leading-7">{text.split('\n').map((line,index)=><div key={index} className={!line.startsWith('- ')&&!line.startsWith('Qatorlarda:')?'font-semibold':''}>{line||'\u00a0'}</div>)}</div>
 </section>}
 <p className="text-xs text-muted-foreground leading-5">Summalar chegirmadan keyin. Mahsulot va to‘lovlar asl cheklar bo‘yicha; qaytarish bo‘lsa alohida satrda va sof savdoda ko‘rsatiladi. Buyurtma avanslari va hali serverga yuborilmagan offline savdolar kirmaydi. Kategoriyalar tarixiy nom yo‘q bo‘lsa joriy katalogdan olinadi. Sinov cheklari avtomatik chiqarib tashlanmaydi. Faqat o‘qish, hech qanday yozuv o‘zgartirilmaydi.</p>
 </div>;
}
