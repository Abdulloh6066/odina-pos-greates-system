# Checkpoint: Before Kassa photo thumbnails for all products

**Sana:** 2026-10-22 (Asia/Tashkent)
**Maqsad:** Kassa rasmlari uchun o‘zgarishdan oldingi holatni saqlash.

## Boshlang‘ich holat

- `Product` entity: faqat `image_url` bor. `pos_thumbnail_url` va `pos_thumbnail_source` maydonlari **yo‘q**.
- `src/lib/pos-thumbnail-manifest.js`: 12 ta mahsulot uchun oldindan tayyorlangan WebP kichik rasmlar (`/images/pos-v2/*.webp`).
- `src/lib/pos-thumbnails.js` → `posThumbnailFor(product)`: faqat manifest mosligini qaytaradi, aks holda `null` (asl rasm ishlatiladi).
- `src/components/pos/ProductCard.jsx`: bitta rasm manbasi; kichik rasm yuklanmasa `setFailedThumbnail` orqali asl rasmga qaytadi.
- `src/pages/POS.jsx`: katalog rasmlari uchun oldindan yuklash (preload) mavjud emas.
- `src/pages/Products.jsx`: kassa rasmlarini optimallashtirish tugmasi mavjud emas.
- Backend: `pos-thumbnails` funksiyasi mavjud emas. `set-product-availability` — mavjudlikni o‘zgartiruvchi yagona product funksiyasi.

## O‘zgarmasligi shart

Savdo, to‘lov, smena, ombor, narx va boshqa biznes ma’lumotlari; `image_url` va boshqa Product maydonlari; mavjud RLS qoidalari.

## Qaytarish

```bash
git checkout before-kassa-photo-thumbnails-2026-10-22 -- .
``