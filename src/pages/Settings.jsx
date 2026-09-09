import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaPrompt } from '@/lib/odina-dialog';
import { Settings as SettingsIcon, Building2, Save } from 'lucide-react';
import { logAction } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
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

  const load = async () => {
    setLoading(true);
    const [s, sh] = await Promise.all([base44.entities.Settings.list(), base44.entities.Shop.list()]);
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
    <div className="odina-page p-5 sm:p-8 max-w-3xl mx-auto animate-fade-in">
      <PageHeader title="Sozlamalar" subtitle="Do‘kon, chek va xavfsizlik sozlamalari" icon={SettingsIcon} />
      {loading ? (
        <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : (
        <>
          <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5 space-y-4">
            <h2 className="font-display text-lg font-bold">Chek sozlamalari</h2>
            <div>
              <Label className="text-xs mb-1.5 block">Do‘kon nomi</Label>
              <Input value={shopName} onChange={(e) => setShopName(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Minnatdorchilik matni</Label>
              <Textarea value={thankYou} onChange={(e) => setThankYou(e.target.value)} rows={2} />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Chek tagidagi ma’lumot (ixtiyoriy)</Label>
              <Input value={receiptFooter} onChange={(e) => setReceiptFooter(e.target.value)} placeholder="Address / phone / Instagram" />
            </div>
            <div className="w-32">
              <Label className="text-xs mb-1.5 block">Valyuta</Label>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value)} />
            </div>
            <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">
              <Save className="w-4 h-4 mr-1.5" /> {saving ? 'Saqlanmoqda…' : 'Sozlamalarni saqlash'}
            </Button>
          </div>

          <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5 mt-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-lg font-bold">Qoldiqsiz sotuv</h2>
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

          <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5 mt-5 space-y-4">
            <div>
              <h2 className="font-display text-lg font-bold">Egasi tasdiqlash PIN kodi</h2>
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

          <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5 mt-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-bold flex items-center gap-2"><Building2 className="w-5 h-5 text-brand-ink" /> Do‘konlar</h2>
              <Button variant="outline" size="sm" onClick={addShop}>Do‘kon qo‘shish</Button>
            </div>
            <div className="space-y-2">
              {shops.map((s) => (
                <div key={s.id} className="flex items-center gap-3 p-3 rounded-xl bg-secondary/50">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{s.name} {s.is_main && <span className="text-xs text-brand-ink">· Asosiy</span>}</div>
                    {s.address && <div className="text-xs text-muted-foreground truncate">{s.address}</div>}
                  </div>
                </div>
              ))}
              {shops.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">Hali do‘konlar yo‘q.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}