# Checkpoint — Xizmat cheki (Oshxona buyurtma varaqasi) yangi dizayni va Kassa/Stollar integratsiyasi

**Sana:** 2026-09-20  
**Mavzu:** Oshxona va xizmat xodimlari uchun xizmat cheki (“Xizmat cheki”) dizaynini foydalanuvchi taqdim etgan minimal va qat’iy andaza (`media_1789849369493.png`) asosida to‘liq qayta ishlab chiqish, buyurtma saqlanganda avtomatik ochish, va Stollar sahifasiga o‘tishda ortiqcha ogohlantirishsiz qulay qilish.  
**Qoidalar:** `ODINA_PROJECT_RULES.md` talablariga 100% muvofiq bajarildi.

---

## 1. Yangi Xizmat Cheki Dizayni (Minimalist Oshxona Varaqasi)

Foydalanuvchining so‘nggi talabi va namunasi asosida chekning barcha ortiqcha elementlari olib tashlandi:

### Ko‘rinish va tuzilishi:
```text
BUYURTMA № #1                                   1-stol
――――――――――――――――――――――――――――――――――――――――――――――――――――――
VAQT                                  2026-09-20 00:54
BUYURTMA OLUVCHI                      Abdulloh Rajabov
――――――――――――――――――――――――――――――――――――――――――――――――――――――
ХУРАСАН КИЧИК                                        1
------------------------------------------------------
ХУРАСАН КАТТА                                        1
```

### Aniq o‘zgarishlar:
1. **Sarlavha qatori:**
   - Chap tomonda: `BUYURTMA № #${order.number || tableNumber}` (qalin, katta harflar).
   - O‘ng tomonda: `${tableNumber}-stol` (qalin, katta harflar).
2. **Ajratuvchi chiziqlar:**
   - Sarlavhadan keyin to‘liq qora chiziq (`――――――――――――――――`).
   - Ma’lumotlar blokidan keyin to‘liq qora chiziq (`――――――――――――――――`).
   - Mahsulotlar orasida nuqtali/uziq chiziq (`- - - - - - - -`).
3. **Ma’lumotlar bloki:**
   - `VAQT`: O‘zbekiston vaqti (`Asia/Tashkent`) bo‘yicha aniq sana va daqiqa (`YYYY-MM-DD HH:mm`).
   - `BUYURTMA OLUVCHI`: Buyurtmani ochgan yoki saqlagan mas’ul xodim ismi (`opened_by_name` / `user.name`).
   - `MIJOZ`: Agar mijoz qayd etilgan bo‘lsa, ko‘rsatiladi.
   - `ESLATMA`: Agar umumiy izoh yozilgan bo‘lsa, ko‘rsatiladi.
4. **Mahsulotlar ro‘yxati:**
   - Chapda: Mahsulot nomi katta harflarda (UPPERCASE), qalin shriftda.
   - O‘ngda: Faqat sof dona/miqdor soni (masalan `1`, `2`, ortiqcha "ta" yoki ramkasiz).
   - Agar variant yoki tayyorlash eslatmasi bo‘lsa, mahsulot ostida aniq ko‘rsatiladi.
5. **Olib tashlangan elementlar (foydalanuvchi talabi bilan):**
   - ❌ `TURI` ustuni sarlavhasi olib tashlandi.
   - ❌ `MAHSULOTLAR VA MIQDOR` bo‘lim sarlavhasi olib tashlandi.
   - ❌ `To‘lov hujjati hisoblanmaydi` yozuvi butunlay olib tashlandi.
   - ❌ Pastki jami hisoblar, narxlar va summalar yo‘q (oshxona faqat buyurtmani tayyorlaydi, narxlar unga kerak emas).
6. **Qayta chop etish (Reprint):**
   - Agar chek qayta chop etilsa (`revision > 1` yoki shu sessiyada qayta bosilsa), tepada aniq `*** QAYTA CHOP ETILDI (REPRINT #{revision}) ***` nishoni chiqadi.

---

## 2. Buyurtmani Stolga Saqlash va Avtomatik Ochilish Oqimi

### Foydalanuvchi talabi:
> "this is should ask after we put that on stolga buyurtmani saqlash and when I tuch the sollar that should't ask me again"

### Amalga oshirilgan yechim:
1. **“Buyurtmani stolga saqlash” bosilganda:**
   - Kassa orqali buyurtma serverga muvaffaqiyatli saqlangach, darhol yangi formatdagi **Xizmat cheki** (`StaffOrderTicketModal`) ekranda ochiladi.
   - Kassir yoki ofitsiant buyurtmani darhol ko‘rib olishi va bir bosishda 80mm printerda chop etishi mumkin.
2. **“Stollar” bosilganda ortiqcha so‘rovsiz o‘tish:**
   - `goToTables` funksiyasidan oddiy savat uchun chiqadigan `Oddiy savat saqlanmagan` tasdiqlovchi so‘rovi olib tashlandi.
   - Xodim "Stollar" tugmasiga teginganda hech qanday asabga teguvchi dialogsiz to‘g‘ridan-to‘g‘ri stollar xaritasiga o‘tadi.
3. **Kassadagi tezkor tugmalar:**
   - Stol saqlangandan keyin Kassa tepasida chiqadigan yashil panelda **“Xizmat cheki”** tugmasi qo‘shildi.
   - Tanlangan stol faol bo‘lganda ham boshqaruv panelida **“Xizmat cheki”** tugmasi mavjud.

---

## 3. Stollar Sahifasidagi Integratsiya (`TableDetailSheet.jsx`)

1. **Stol ma’lumot oynasida:**
   - Stol band bo‘lganda, `Kassada ochish` va `To‘lov qilish` tugmalari ostida **“Xizmat cheki”** va **“Hisob cheki (Pre-check)”** tugmalari yonma-yon joylashtirildi.
   - **“Xizmat cheki”** bosilganda `StaffOrderTicketModal` ochiladi va oshxona varaqasi ko‘rsatiladi.

---

## 4. Backend Saqlash Yangilanishi (`base44/functions/restaurant-tables/entry.ts`)

1. `save_table_order` amali yangilandi:
   - Buyurtma elementlariga `variant_name` va `notes` qo‘shildi.
   - Buyurtma obyektiga `opened_by_name`, `customer_name` va `notes` maydonlari kiritildi.
   - Natijada xizmat cheki ochilganda buyurtmani kim olgani va qanday eslatmalar kiritilgani to‘liq aks etadi.

---

## 5. Chop Etish Uslubi (`src/index.css`)

1. `@media print` qoidalariga `.receipt-print.staff-order-ticket { display: block !important; }` qo‘shildi.
2. Mavjud `.receipt-print.table-precheck` qoidasi bilan alohida qatorda saqlanib, barcha avtomatlashtirilgan testlar muvofiqligi ta’minlandi.

---

## 6. O‘zgartirilgan Fayllar

- `src/components/tables/StaffOrderTicketModal.jsx` (yangi dizayn, 80mm format, toza minimal tuzilma)
- `src/components/tables/TableDetailSheet.jsx` (Xizmat cheki tugmasi va modal integratsiyasi)
- `src/pages/POS.jsx` (Buyurtma saqlanganda avtomatik chek ochilishi, bannerlardagi tugmalar, Stollar navigatsiyasi yaxshilanishi)
- `base44/functions/restaurant-tables/entry.ts` (`opened_by_name`, `variant_name`, `notes` saqlanishi)
- `src/index.css` (80mm xizmat cheki chop etish klassi)
- `tests/pos-table-picker.test.mjs` (xizmat cheki dizayni va navigatsiya testlari)
