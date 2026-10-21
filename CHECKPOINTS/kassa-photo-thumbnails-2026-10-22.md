# Kassa photo thumbnails for all products

**Sana:** 2026-10-22 (Asia/Tashkent)
**Oldingi checkpoint:** `before-kassa-photo-thumbnails-2026-10-22` (git commit + tag)

## Muammo

89 ta mahsulot kassada asl PNG rasmni ishlatadi (~1.8 MB, 1254×1254 px). Kategoriya almashganda va rasm chiqishida 6–9 s kutish. Faqat 12 tasida manifest kichik rasm bor edi.

## O‘zgargan fayllar

| Fayl | O‘zgarish |
| --- | --- |
| `base44/entities/Product.jsonc` | Faqat 2 ixtiyoriy maydon: `pos_thumbnail_url`, `pos_thumbnail_source`. `image_url` va boshqa maydonlar, RLS — o‘zgarmadi. |
| `base44/functions/pos-thumbnails/entry.ts` (+ `function.jsonc`) | Yangi funksiya: faqat admin, faqat shu 2 maydonni yozadi, manba `image_url` mosligini tekshiradi. |
| `src/lib/pos-thumbnails.js` | Ustuvorlik: manifest (manba mos) → `pos_thumbnail_url` (manba mos) → asl rasm (`null`). |
| `src/lib/pos-thumbnail-tool.js` | Yangi: navbat, 512 px → WebP 0.88, 3 ta parallel, xatoni yig‘ish, `data:` ni o‘tkazib yuborish. |
| `src/lib/pos-thumbnail-preload.js` | Yangi: `requestAnimationFrame` → `requestIdleCallback`, `decoding=async`, `fetchPriority=low`, dublikatlar bir marta. |
| `src/components/products/PosThumbnailOptimizer.jsx` | Yangi: admin tugmasi «Kassa rasmlarini optimallashtirish». |
| `src/components/products/PosThumbnailOptimizerDialog.jsx` | Yangi: jarayon, tayyor / o‘tkazib yuborilgan / xato ro‘yxati. |
| `src/pages/Products.jsx` | Tugma `PageHeader` amallariga qo‘shildi (faqat admin). |
| `src/pages/POS.jsx` | Kassa ochilgach katalogdagi kichik rasmlarni jimgina preload qilish. |
| `src/components/pos/ProductCard.jsx` | **O‘zgarmadi** — mavjud `failedThumbnail` fallback yangi ustuvorlik bilan avtomatik ishlaydi. |
| `src/tests/pos-thumbnails.test.mjs`, `src/tests/pos-thumbnail-tool.test.mjs` | Ustuvorlik, o‘lcham, navbat, 3-parallel, preload testlari. |

## Tegilmagan

Savdo, to‘lov, smena, ombor, narx, retsept, buyurtma va hisobot logikasi; `image_url`; mavjud RLS.

## Tekshiruv

- `node --test src/tests/pos-thumbnails.test.mjs src/tests/pos-thumbnail-tool.test.mjs` — 13/13 pass.
- `npm run lint` — xatosiz.
- `npm run build` — exit 0.
- `pos-thumbnails` funksiyasi bo‘sh payload bilan 400 «Mahsulot tanlanmadi.» — validatsiya ishlaydi (yozuv bajarilmadi).

## Tuzatish (2026-10-22, kech)

- `src/lib/pos-thumbnail-tool.js` 77-qator: asl rasm `cache: 'force-cache'` → `cache: 'no-store'` (`mode: 'cors'`, `credentials: 'omit'` o‘zgarmadi) — nashr etilgan saytda 127 rasmning 114 tasi CORS bilan yiqilgan edi.

## Eslatma

`UploadFile` bilan saqlangan kichik rasmlar doimiy ommaviy havolada (stored publicly — havolasi bor har kim ocha oladi). Bu kassa tezligi uchun tanlangan: asl rasmlar ham shu turdagi havolalarda.