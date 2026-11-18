import {createClientFromRequest} from "npm:@base44/sdk";
const RETAIL = ["6a96f0a4ecc85c2fc57f3174","6a96f0a4ecc85c2fc57f3173"];
function fingerprint(value) {
  let n=2166136261;
  for(let i=0;i<value.length;i++) n=Math.imul(n ^ value.charCodeAt(i),16777619);
  return (n>>>0).toString(36);
}
function menu(products, categories, shops) {
  const openShops=RETAIL.map(id=>shops.find(s=>s.id===id && s.active!==false && s.allows_pos!==false && s.location_type!=="production")).filter(Boolean);
  const goods=[];
  for(const p of products) {
    if(p.active===false||p.archived||!p.name) continue;
    const offers=[];
    for(const s of openShops) {
      const c=categories.find(c=>c.id===(p.shop_category_ids?.[s.id]||p.category_id));
      if(!c||c.active===false||c.hidden_shop_ids?.includes(s.id)||(p.available_shop_ids?.length&&!p.available_shop_ids.includes(s.id))) continue;
      const price=Number(p.shop_prices?.[s.id]??p.price);
      if(!Number.isFinite(price)||price<0) continue;
      const order=s.pos_product_order?.indexOf(p.id)??-1;
      offers.push({s:s.id,c:c.id,p:Math.round(price),o:order<0?99999:order});
    }
    if(!offers.length) continue;
    const raw=String((p.pos_thumbnail_source===p.image_url && p.pos_thumbnail_url)||p.image_url||"");
    let url=raw.startsWith("/images/")?"https://odina-pos-suite.base44.app"+raw:raw.startsWith("https://")?raw:"";
    const key=raw?fingerprint(raw):"";
    goods.push({id:p.id,n:String(p.name).trim(),d:String(p.description||"").trim().slice(0,380),u:p.sale_unit==="gram"?"g":"pc",im:url,k:key,offers});
  }
  const used=new Set(goods.flatMap(p=>p.offers.map(o=>o.c)));
  return {shops:openShops.map(s=>({id:s.id,n:s.name,a:String(s.address||"").replace(/📍\s*/g,"").trim()})),cats:categories.filter(c=>used.has(c.id)).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(c=>({id:c.id,n:c.name})),items:goods};
}

async function listAll(entity) {
  const result=[];
  for(let start=0;start<30000;start+=250) {
    const page=await entity.list("id",250,start);
    result.push(...page);
    if(page.length<250) return result;
  }
  throw new Error("Catalog size limit");
}
let cache=null;
export default async function(req) {
  if(req.method!=="POST") return Response.json({error:"method"},{status:405});
  let input; try { input=await req.json(); } catch {return Response.json({error:"json"},{status:400});}
  const secret=Deno.env.get("ODINA_VITRINA_FEED_KEY");
  if(!secret || input?.key!==secret) return Response.json({error:"forbidden"},{status:403});
  const api=createClientFromRequest(req).asServiceRole.entities;
  try {
    if(!cache || Date.now()-cache.time>45000) {
      const [p,c,s]=await Promise.all([listAll(api.Product),listAll(api.Category),Promise.all(RETAIL.map(id=>api.Shop.get(id)))]);
      const data=menu(p,c,s);
      const allowed=new Set(data.items.map(i=>i.id));
      const inline=new Map(p.filter(item=>allowed.has(item.id)&&/^data:image\/(webp|png|jpeg);base64,/.test(item.image_url||"")).map(item=>[item.id,item.image_url]));
      cache={time:Date.now(),data,inline};
    }
    if(input.image) {
      const image=cache.inline.get(input.image);
      return image?Response.json({image}):Response.json({error:"missing"},{status:404});
    }
    return Response.json({...cache.data,syncedAt:new Date(cache.time).toISOString()});
  } catch {return Response.json({error:"POS katalogi vaqtincha band"},{status:503});}
}