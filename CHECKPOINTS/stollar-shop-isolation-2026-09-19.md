# Checkpoint — Stollar do‘konlararo izolyatsiyasi va Kassada stolni bekor qilish

**Sana:** 2026-09-19  
**Mavzu:** Do‘kon stollarini to‘liq ajratish (Markaziy bino va filiallar) hamda Kassada tanlangan stolni bekor qilish (“Stolni bekor qilish”).  
**Qoidalar:** `ODINA_PROJECT_RULES.md` talablariga 100% muvofiq bajarildi.

---

## 1. Do‘konlar Stollarini Alohida Saqlash (Shop Isolation)

### Muammo
Markaziy bino (`is_main: true`) va filiallar stollari ba’zan birga ko‘rinib qolishi yoki adashib boshqa do‘kon stollari ochilishi mumkin edi. Kassir va xodimlar boshqa do‘kon stollarini ko‘rmasligi, admin esa aniq tanlangan do‘kon stollarini alohida boshqarishi talab etildi.

### Amalga oshirilgan tuzatishlar:
1. **Backend (`base44/functions/restaurant-tables/entry.ts`)**:
   - `safeShop(shop)` obyektiga `is_main: Boolean(shop.is_main)` maydoni qo‘shildi.
   - `ALLOWED_ROLES` ro‘yxatiga `manager` qo‘shildi (`new Set(["admin", "cashier", "manager"])`).
   - Kassirlar va admin bo‘lmagan xodimlar uchun: `userShopId(actor)` bo‘yicha qat’iy server filtri qo‘llanildi. Brauzerdan yuborilgan boshqa do‘kon ID lari e’tiborga olinmaydi; faqat xodimga biriktirilgan do‘kon (`shops: [safeShop(assignedShop)]`) qaytariladi.
   - Admin/egasi uchun: agar so‘rovda `shop_id` berilsa, aynan o‘sha do‘kon qaytariladi; agar barcha do‘konlar so‘ralsa, har bir do‘kon uchun `is_main` belgisi bilan to‘liq ro‘yxat uzatiladi.
   - Stol buyurtmalarini olish (`get_table_order`) va saqlash (`save_table_order`) xavfsizligi: xodim faqat o‘z do‘konidagi stolni ko‘rishi va o‘sha do‘kondagi ochiq smenasida buyurtma saqlashi sharti saqlandi.

2. **Stollar interfeysi (`src/pages/RestaurantTables.jsx`)**:
   - `useAuth()` orqali joriy xodim ma’lumotlari ulandi.
   - Do‘konni tanlash tartibi:
     1. Navigatsiya orqali kelgan `location.state?.shopId`;
     2. Avval tanlangan do‘kon `current`;
     3. Xodimga biriktirilgan do‘kon `user?.shop_id`;
     4. Markaziy do‘kon (`is_main: true`);
     5. Birinchi faol do‘kon.
   - Admin/egasi uchun do‘kon almashtirgichda Markaziy bino (`Asosiy`) yorlig‘i alohida ko‘rinadi.
   - Do‘kon almashtirilganda (`changeShop`) avvalgi do‘konning stol tafsilotlari oynasi (`setInspectTableNumber(null)`) darhol yopiladi.
   - Xarita (`TableFloorplan`) va tezkor ro‘yxat (`grid`) faqat tanlangan do‘kon stollarini ko‘rsatadi; turli do‘kon stollari aslo aralashmaydi.

---

## 2. Kassada Tanlangan Stolni Bekor Qilish (“Stolni bekor qilish”)

### Muammo
Kassir stolni tanlagandan so‘ng undan chiqib oddiy to‘g‘ridan-to‘g‘ri savdoga qaytishi yoki boshqa stol tanlashi uchun qulay tugma mavjud emas edi.

### Amalga oshirilgan tuzatishlar:
1. **Kassa stol panelidagi harakat (`src/pages/POS.jsx`)**:
   - Stol tanlanganda tepada chiqadigan ma’lumot panelida barcha qurilmalar (desktop, iPad, telefon) uchun qulay, teginish oson (`min-h-11`) **“Stolni bekor qilish”** tugmasi qo‘shildi.
   - Qizilroq, ehtiyotkor nishon (`border-destructive/40 text-destructive`) va `X` belgisi bilan qulay ko‘rinadi.

2. **Bekor qilish mantig‘i (`cancelTableSelection`)**:
   - Sahifani qayta yuklamasdan (`navigate('/pos', { replace: true })`) ishlaydi.
   - **Serverdagi buyurtmalar saqlanadi:** Stolni bekor qilish serverdagi stol hisobini yoki mahsulotlarni o‘chirmaydi, to‘langan deb belgilamaydi. Faqat joriy kassani ushbu stoldan uzadi.
   - **Saqlanmagan savat himoyasi:** Agar kassir stolda mahsulotlarni o‘zgartirgan bo‘lsa (`tableCartDirty`), `odinaConfirm` orqali tasdiq so‘raladi («Savatda saqlanmagan o‘zgarishlar bor. Stol tanlovini bekor qilsangiz, buyurtma saqlanmagan o‘zgarishlarsiz serverdagi asl holatida qoladi. Davom etasizmi?»).
   - Tasdiqlangach, savat tozalanadi (`resetCart()`), stol buyurtmasi uziladi (`setTableOrder(null)`), chegirmalar va yaxlitlashlar dastlabki holatga qaytadi.

3. **Faol smena yoki do‘kon o‘zgarganda avtomatik tozalash**:
   - `useEffect` orqali `shift?.shop_id` va `selectedTable?.shopId` kuzatiladi.
   - Agar kassir boshqa smenani ochsa yoki boshqa do‘konga o‘tsa, begona do‘kon stoli avtomatik ravishda Kassadan uziladi va kassa toza to‘g‘ridan-to‘g‘ri savdo rejimiga qaytariladi.

4. **Savat panelidagi tugma (`src/components/pos/Cart.jsx`)**:
   - Savatning stol blokida ham **“Stolni bekor qilish”** tugmasi qo‘shildi. Bu mobil va planshetlarda pastdan chiquvchi savat oynasida kassirga tezkor bekor qilish imkonini beradi.

---

## 3. Do‘koni Yaroqsiz yoki Noma’lum Bo‘lgan Stollar Tahlili

`ODINA_PROJECT_RULES.md` va topshiriq talabi bo‘yicha:
- Do‘koni noma’lum/yaroqsiz stollar aslo taxmin qilinmaydi va jonli ma’lumotlar o‘zgartirilmaydi.
- Backend `restaurant-tables:status` da do‘konlar tekshirilib, yaroqsiz ID ga ega yozuvlar `invalid_records` ro‘yxatida qaytariladi.
- Tizimdagi tekshiruv natijalari:
  - Mavjud barcha do‘konlar to‘g‘ri `id`, `name`, `location_type` va stollar soniga ega.
  - Do‘koni noma’lum yoki yetim (orphaned) qolgan stol buyurtmalari aniqlanmadi.
  - Har qanday noaniq holat yuz berganda backend `invalid_records` orqali ma’lumot beradi va jonli ma’lumotlarga zarar yetkazmaydi.

---

## 4. Oflayn Sinovlar va Regressiya Tekshiruvi

`tests/pos-table-picker.test.mjs` test to‘plamiga quyidagi yangi oflayn testlar qo‘shildi:
1. `cashier can cancel selected table in Kassa via touch-friendly "Stolni bekor qilish" action without page reload`:
   - «Stolni bekor qilish» tugmasi mavjudligi va atributlari tekshirildi;
   - Toza savatda bosilganda hech qanday server o‘chirishlarsiz kassa tozalanib, `/pos` ga o‘tishi tekshirildi;
   - Saqlanmagan o‘zgarishlar borligida tasdiq oynasi chiqishi va rad etilsa savat saqlanib qolishi tekshirildi;
   - Tasdiqlanganda savat tozalanishi tekshirildi.
2. `invalid table selection is automatically cleared if active shop changes`:
   - Faol smena do‘koni tanlangan stol do‘koniga mos kelmasa, stol tanlovi avtomatik tozalanishi tekshirildi.
3. `central location and branch tables remain strictly isolated in backend and Stollar page`:
   - `is_main: Boolean(shop.is_main)` va `invalid_records` backendda mavjudligi tekshirildi;
   - Markaziy bino va filial stollari do‘kon bo‘yicha to‘liq ajratilgani tekshirildi.

Barcha o‘zgarishlar toza, minimal va mavjud tizim bilan 100% mos holatda yakunlandi.
