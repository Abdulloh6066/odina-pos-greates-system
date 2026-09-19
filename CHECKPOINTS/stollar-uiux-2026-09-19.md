# Checkpoint — Stollar sahifasi (RestaurantTables) UI/UX yangilanishi

**Sana:** 2026-09-19
**Maqsad:** Stollar sahifasida foydalanuvchi tajribasini (UI/UX) qulaylashtirish: stol ustiga bosganda darhol sahifa yangilanib ketishining oldini olish, buyurtma tarkibini ko‘rsatish, hisob chekini (pre-check) chiqarish va planshetlar uchun «Tezkor ro‘yxat» ko‘rinishini qo‘shish.

---

## Nimalar o‘zgartirildi va qo‘shildi

1. `src/components/tables/TableDetailSheet.jsx` (YANGI):
   - Stol bosilganda o‘ng tomondan/markazdan chiquvchi ixcham ma’lumot kartochkasi.
   - Stol holati: **Bo‘sh** (yashil nishon) yoki **Band** (tillarang nishon) / **To‘lovda**.
   - Ochilgan vaqti (Asia/Tashkent).
   - Buyurtma qilingan mahsulotlar ro‘yxati (nomi, soni, narxi, summasi) va jami to‘lov summasi.
   - **Hisob cheki (Pre-check):** Mehmon hisob so‘raganda to‘lovgacha hisob varaqasini chiqarish (`window.print()`).
   - Tezkor harakat tugmalari:
     - 🟡 **«Kassada ochish»** — Kassaga o‘tib buyurtma davom ettirish.
     - 🟢 **«To‘lov qilish»** — to‘g‘ridan-to‘g‘ri to‘lov oynasini ochish (`action=pay`).

2. `src/components/tables/TableFloorplan.jsx` (YANGILANDI):
   - `selectedViewNumber` propsi qo‘shildi.
   - Tanlangan stol atrofida faol tillarang urg‘u va halqa (`ring-4 ring-brand-olive/40 scale-105`) aks etadi.

3. `src/pages/RestaurantTables.jsx` (YANGILANDI):
   - Ko‘rinish rejimi: **«Zal xaritasi»** (xarita bo‘ylab joylashuv) va **«Tezkor ro‘yxat»** (planshet va telefonlarda stollarni tezkor kartochkalar orqali ko‘rish) tugmalari qo‘shildi.
   - Stol bosilganda avval `TableDetailSheet` ochiladi.
   - `TableDetailSheet` komponenti sahifa pastiga ulandi.

4. `src/pages/POS.jsx` (YANGILANDI):
   - URL orqali `action=pay` kelganda stol buyurtmasi yuklangach avtomatik to‘lov oynasini ochish imkoniyati ulandi.

5. Ko‘cha / terassa hududini erkin to‘rtburchak chizish va cho‘zish (Box Draw & Resize) — `TableFloorplan.jsx` va `table-floorplan.js`:
   - Qotib qolgan «0/12 ta nuqta» va chiziqlar kesishishi xatolari to‘liq almashtirildi.
   - Xaritada sichqoncha/barmoq bilan bitta harakatda ko‘cha to‘rtburchagini tortib chizish (Drag-to-Draw) imkoniyati.
   - 4 ta burchakdagi dumaloq tutqichlar (NW, NE, SE, SW) orqali hududni xohlagan tomonga kengaytirish yoki qisqartirish.
   - O‘rtadagi dastak orqali butun hududni xaritadagi boshqa joyga surish (Move).
   - Tezkor andozalar: «Yuqori ko‘cha», «Pastki ko‘cha», «O‘ng terassa», «Chap terassa» va «Hududni tozalash».
   - «✓ Tayyor · Stollarni joylashtirish» orqali stollarni ko‘cha zonasiga erkin surib qo‘yish.

---

## Nimalar O‘ZGARISHSIZ QOLDIRILDI

- Mavjud barcha backend funksiyalari (`restaurant-tables`, `complete-sale`, va h.k.) tegilmadi.
- Barcha xavfsizlik, rollar (`canManage`), do‘kon cheklovlari va moliyaviy hisob-kitoblar o‘z holicha qoldi.
- Xaritani tahrirlash (eshik devori, ko‘cha hududi, stollar sonini sozlash) to‘liq saqlandi.
- Odina brend ranglari (`#ACA95D` zaytun, `#FECD7C` iliq sariq, `#D0B17F`) va O‘zbekcha (Lotin) matnlar saqlandi.

---

## O‘zgarishlarni bekor qilish (Rollback)

Agar ushbu o‘zgarishlarni avvalgi holatiga qaytarish kerak bo‘lsa:
1. `src/components/tables/TableDetailSheet.jsx` faylini o‘chiring (`rm -f src/components/tables/TableDetailSheet.jsx`).
2. `src/components/tables/TableFloorplan.jsx` dan `selectedViewNumber` va unga bog‘liq class nomini olib tashlang.
3. `src/pages/RestaurantTables.jsx` dagi `viewMode` va `TableDetailSheet` qismlarini olib tashlab, `openTable` funksiyasini to‘g‘ridan-to‘g‘ri `navigate('/pos?...')` ga qaytaring.
4. `src/pages/POS.jsx` dagi `autoPayProcessedRef` effektini olib tashlang.
