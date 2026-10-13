import '@/styles/operations-workbench.css';
import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaPrompt } from '@/lib/odina-dialog';
import { Settings as SettingsIcon, Building2, Save } from 'lucide-react';
import { logAction } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import TelegramSetup from '@/components/TelegramSetup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';

export default function Settings() {
  const { user } = useOutletContext();
  const [shops, setShops] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [shopName, setShopName] = useState('Odina Shop');
  const [thankYou, setThankYou] = useState('Rahmat! Sizning tabassumingiz biz uchun juda muhim ❤️');
  const [receiptFooter, setReceiptFooter] = useState('');
  const [currency, setCurrency] = useState('UZS');
  const [allowNegativeStock, setAllowNegativeStock] = useState(true);
  const [ownerPin, setOwnerPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [savingPin, setSavingPin] = useState(false);
  const [editingShopId, setEditingShopId] = useState('');
  const [shopContact, setShopContact] = useState({ instagram: '', phone: '', address: '' });
  const [savingShopContact, setSavingShopContact] = useState(false);

  const load = async () => {
    setLoading(true);
    const [s, sh] = await Promise.all([base44.entities.Settings.list(), base44.entities.Shop.list('created_date')]);
    setShops(sh || []);
    const existing = (s || [])[0];
    setSettings(existing);
    if (existing) {
      setShopName(existing.shop_name || 'Odina Shop');
      setThankYou(existing.thank_you_message || '');
      setReceiptFooter(existing.receipt_footer || '');
      setCurrency(existing.currency || 'UZS');
      setAllowNegativeStock(existing.allow_negative_stock !== false);
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        shop_name: shopName,
        thank_you_message: thankYou,
        receipt_footer: receiptFooter,
        currency,
        allow_negative_stock: allowNegativeStock,
      };
      if (settings) await base44.entities.Settings.update(settings.id, payload);
      else { const created = await base44.entities.Settings.create(payload); setSettings(created); }
      await logAction(user, 'settings_updated', 'Updated shop settings');
      void odinaAlert('Sozlamalar saqlandi.');
    } catch (e) { void odinaAlert('Saqlashda xato: ' + (e?.message || e)); }
    finally { setSaving(false); }
  };

  const saveOwnerPin = async () => {
    if (!/^\d{4,8}$/.test(ownerPin)) return void odinaAlert('PIN kod 4–8 ta raqamdan iborat bo‘lishi kerak.');
    if (ownerPin !== confirmPin) return void odinaAlert('PIN kodlar bir xil emas.');
    setSavingPin(true);
    try {
      await base44.functions.invoke('set-owner-pin', { pin: ownerPin });
      setOwnerPin('');
      setConfirmPin('');
      void odinaAlert('Egasi tasdiqlash PIN kodi xavfsiz saqlandi.');
    } catch (e) {
      const message = e?.response?.data?.error || e?.message || e;
      void odinaAlert('PIN kodni saqlashda xato: ' + message);
    } finally {
      setSavingPin(false);
    }
  };

  const editShopContact = (shop) => {
    setEditingShopId(shop.id);
    setShopContact({
      instagram: shop.instagram || '',
      phone: shop.phone || '',
      address: shop.address || '',
    });
  };

  const saveShopContact = async () => {
    const shop = shops.find((row) => row.id === editingShopId && row.location_type === 'shop' && row.allows_pos !== false);
    if (user?.role !== 'admin' || !shop || savingShopContact) return;
    const instagram = shopContact.instagram.trim().replace(/^@/, '').toLowerCase();
    const phone = shopContact.phone.trim();
    const address = shopContact.address.trim();
    if ((instagram && !/^[a-z0-9._]{1,30}$/.test(instagram)) || phone.length > 40 || address.length > 300) {
      void odinaAlert('Instagram: 30 tagacha harf, raqam, nuqta yoki _. Telefon va manzilni qisqartiring.');
      return;
    }
    setSavingShopContact(true);
    try {
      const contact = { instagram, phone, address };
      await base44.entities.Shop.update(shop.id, contact);
      setShops((current) => current.map((row) => row.id === shop.id ? { ...row, ...contact } : row));
      setEditingShopId('');
      await logAction(user, 'shop_receipt_contact_updated', `Do‘kon chek ma’lumotlari yangilandi: ${shop.name}`);
      void odinaAlert(`${shop.name}: chek ma’lumotlari saqlandi.`);
    } catch (error) {
      void odinaAlert('Do‘kon ma’lumotlarini saqlab bo‘lmadi: ' + (error?.message || error));
    } finally {
      setSavingShopContact(false);
    }
  };

  const addShop = async () => {
    const name = await odinaPrompt('Yangi do‘kon nomini kiriting.', {
      title: 'Yangi do‘kon',
      inputLabel: 'Do‘kon nomi',
      placeholder: 'Masalan: Odina Chilonzor',
      confirmLabel: 'Davom etish',
    });
    if (!name) return;
    const address = await odinaPrompt('Manzilni kiriting yoki bo‘sh qoldiring.', {
      title: 'Do‘kon manzili',
      inputLabel: 'Manzil (ixtiyoriy)',
      placeholder: 'Tuman, ko‘cha, mo‘ljal',
      inputRequired: false,
      confirmLabel: 'Do‘konni yaratish',
    });
    if (address === null) return;
    await base44.entities.Shop.create({ name, address });
    load();
  };

  return (
    <div className="odina-page odina-workbench odina-operations odina-settings p-5 sm:p-8 max-w-6xl mx-auto animate-fade-in">
      <PageHeader title="Sozlamalar" eyebrow="TIZIM BOSHQARUVI" subtitle="Cheklar, sotuv qoidalari va do‘kon ma’lumotlarini boshqaring." icon={SettingsIcon} />
      <TelegramSetup user={user} />
      {loading ? (
        <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : (
        <div className="odina-settings-grid">
          <div className="odina-settings-receipt odina-panel rounded-2xl bg-card border border-border p-5 space-y-4">
            <div className="odina-settings-section-heading"><p className="odina-page-eyebrow">MIJOZGA KO‘RINADIGAN MATN</p><h2 className="font-display text-lg font-bold">Chek sozlamalari</h2><p className="text-xs text-muted-foreground mt-1">Umumiy nom va xabarlar barcha do‘konlar cheklarida chiqadi.</p></div>
            <div>
              <Label className="text-xs mb-1.5 block">Do‘kon nomi</Label>
              <Input value={shopName} onChange={(e) => setShopName(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Minnatdorchilik matni</Label>
              <Textarea value={thankYou} onChange={(e) => setThankYou(e.target.value)} rows={2} />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Barcha do‘konlar uchun umumiy chek izohi (ixtiyoriy)</Label>
              <Input value={receiptFooter} onChange={(e) => setReceiptFooter(e.target.value)} placeholder="Masalan: Har kuni siz bilanmiz!" />
              <p className="text-xs text-muted-foreground mt-1">Instagram, telefon va manzilni pastdagi har bir do‘kon sozlamasida alohida kiriting. Eski umumiy izohda ular yozilgan bo‘lsa, takrorlanmasligi uchun uni shu yerdan tahrirlang.</p>
            </div>
            <div className="w-32">
              <Label className="text-xs mb-1.5 block">Valyuta</Label>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value)} />
            </div>
            <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">
              <Save className="w-4 h-4 mr-1.5" /> {saving ? 'Saqlanmoqda…' : 'Sozlamalarni saqlash'}
            </Button>
          </div>

          <div className="odina-settings-stock odina-panel rounded-2xl bg-card border border-border p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="odina-page-eyebrow">SOTUV QOIDASI</p><h2 className="font-display text-lg font-bold">Qoldiqsiz sotuv</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Yoqilganida qoldiq yetmasa kassir ogohlantiriladi, ammo tasdiqlab sotishi mumkin.
                  O‘chirilganda qoldiqsiz sotuv bloklanadi.
                </p>
              </div>
              <Switch
                checked={allowNegativeStock}
                onCheckedChange={setAllowNegativeStock}
                aria-label="Qoldiqsiz sotishga ruxsat"
                className="mt-1"
              />
            </div>
            <p className={`mt-3 text-xs font-medium ${allowNegativeStock ? 'text-amber-700' : 'text-emerald-700'}`}>
              {allowNegativeStock ? 'Hozir: ogohlantirib sotishga ruxsat berilgan' : 'Hozir: qoldiq yetmasa sotuv bloklanadi'}
            </p>
            <Button onClick={save} disabled={saving} variant="outline" className="mt-4 min-h-11 rounded-xl">
              <Save className="w-4 h-4 mr-1.5" /> {saving ? 'Saqlanmoqda…' : 'Ushbu sozlamani saqlash'}
            </Button>
          </div>

          <div className="odina-settings-pin odina-panel rounded-2xl bg-card border border-border p-5 space-y-4">
            <div>
              <p className="odina-page-eyebrow">HIMOYALANGAN AMALLAR</p><h2 className="font-display text-lg font-bold">Egasi tasdiqlash PIN kodi</h2>
              <p className="text-xs text-muted-foreground mt-1">Qaytarish va himoyalangan kassa amallarida ishlatiladi. PIN kodning o‘zi saqlanmaydi.</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs mb-1.5 block">Yangi PIN (4–8 raqam)</Label>
                <Input type="password" inputMode="numeric" autoComplete="new-password" value={ownerPin} onChange={(e) => setOwnerPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
              </div>
              <div>
                <Label className="text-xs mb-1.5 block">PIN kodni takrorlang</Label>
                <Input type="password" inputMode="numeric" autoComplete="new-password" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
              </div>
            </div>
            <Button onClick={saveOwnerPin} disabled={savingPin || !ownerPin || !confirmPin} variant="outline">
              {savingPin ? 'Xavfsiz saqlanmoqda…' : 'Egasi PIN kodini saqlash'}
            </Button>
          </div>

          <div className="odina-settings-shops odina-panel rounded-2xl bg-card border border-border p-5">
            <div className="odina-settings-section-heading flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="font-display text-lg font-bold flex items-center gap-2"><Building2 className="w-5 h-5 text-brand-ink" /> Do‘konlar</h2>
              <Button variant="outline" size="sm" onClick={addShop}>Do‘kon qo‘shish</Button>
            </div>
            <div className="odina-shop-settings-grid grid gap-3">
              {shops.map((s) => (
                <div key={s.id} className="odina-shop-settings-card p-4 rounded-xl border border-border bg-secondary/30 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{s.name} {s.is_main && <span className="text-xs text-brand-ink">· Asosiy</span>}</div>
                      {s.address && <div className="text-xs text-muted-foreground break-words">{s.address}</div>}
                      {s.phone && <div className="text-xs text-muted-foreground">Telefon: {s.phone}</div>}
                      {s.instagram && <div className="text-xs text-brand-ink">Instagram: @{String(s.instagram).replace(/^@/, '')}</div>}
                    </div>
                    {user?.role === 'admin' && s.location_type === 'shop' && s.allows_pos !== false && (
                      <Button type="button" size="sm" variant="outline" disabled={savingShopContact} onClick={() => editShopContact(s)} className="min-h-11 shrink-0 rounded-xl">Chek sozlamalari</Button>
                    )}
                  </div>
                  {editingShopId === s.id && (
                    <div className="rounded-xl border border-primary/25 bg-card p-3 space-y-3">
                      <p className="text-sm font-semibold">{s.name} — chekdagi aloqa ma’lumotlari</p>
                      <div>
                        <Label className="text-xs mb-1.5 block">Instagram</Label>
                        <Input value={shopContact.instagram} onChange={(e) => setShopContact((old) => ({ ...old, instagram: e.target.value }))} placeholder="@odinacake" maxLength={31} autoComplete="off" />
                      </div>
                      <div>
                        <Label className="text-xs mb-1.5 block">Telefon</Label>
                        <Input type="tel" value={shopContact.phone} onChange={(e) => setShopContact((old) => ({ ...old, phone: e.target.value }))} placeholder="+998 ..." maxLength={40} />
                      </div>
                      <div>
                        <Label className="text-xs mb-1.5 block">Manzil</Label>
                        <Textarea value={shopContact.address} onChange={(e) => setShopContact((old) => ({ ...old, address: e.target.value }))} rows={2} maxLength={300} placeholder="Do‘konning aniq manzili" />
                      </div>
                      <p className="text-xs text-muted-foreground">Bo‘sh qoldirilgan ma’lumot chekda chiqmaydi. Faqat ushbu do‘kon o‘zgaradi.</p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" onClick={saveShopContact} disabled={savingShopContact} className="min-h-11 bg-primary text-primary-foreground hover:bg-primary-strong"><Save className="w-4 h-4 mr-1.5" />{savingShopContact ? 'Saqlanmoqda…' : 'Saqlash'}</Button>
                        <Button type="button" variant="outline" disabled={savingShopContact} onClick={() => setEditingShopId('')} className="min-h-11">Bekor qilish</Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {shops.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">Hali do‘konlar yo‘q.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
