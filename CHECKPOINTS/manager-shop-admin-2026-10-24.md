# Checkpoint — Boshqaruvchi = o‘z do‘koni uchun admin

**Sana:** 2026-10-24 · **Restore point:** "Before manager shop-admin rights" · Publish qilinmagan.

## Yangi huquqlar (faqat biriktirilgan do‘kon, server tekshiradi)
- Tannarx va foyda — hisobot o‘z do‘koniga majburan cheklanadi (profit-report).
- Nazorat va eksport — faqat o‘z do‘koni yozuvlari, xodimlari, do‘koni (audit-report).
- Kunlik eksport — menyuga qo‘shildi (backend avvaldan do‘konga cheklangan; global sozlamalar egasida).
- Xodimlar — faqat o‘z do‘konidagi kassir/omborchilar: taklif, ism, o‘chirish/yoqish, kassir ↔ omborchi (security-admin, staff-invite).
- Kassa yakunlash vaqti tarixi — faqat o‘z do‘koni (checkout-timing).
- Buyurtma ishlab chiqarish holati — o‘z do‘koni buyurtmalari (customer-orders).
- "Kassada ochish" menyusi.

## Egasida qoladi
Budget, Xavfsizlik / egasi PIN, Sozlamalar, global katalog va retseptlar, markaziy ishlab chiqarish, admin/egasi hisoblari, Telegram sozlamalari. Qaytarish avvalgidek egasi PIN kodi bilan.

## Tekshiruv
lint OK · build OK · testlar 1226 pass / 36 fail — 36 tasi o‘zgarishdan oldin ham yiqilgan, yangi yiqilish yo‘q. 6 ta "faqat admin" testi yangi qoidaga moslandi, menejer vaqt tarixi do‘konga cheklanishi testi qo‘shildi.
