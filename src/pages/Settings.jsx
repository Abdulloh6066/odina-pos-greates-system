import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Settings as SettingsIcon, Building2, Save } from 'lucide-react';
import { logAction } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

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
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const payload = { shop_name: shopName, thank_you_message: thankYou, receipt_footer: receiptFooter, currency };
      if (settings) await base44.entities.Settings.update(settings.id, payload);
      else { const created = await base44.entities.Settings.create(payload); setSettings(created); }
      await logAction(user, 'settings_updated', 'Updated shop settings');
      alert('Settings saved.');
    } catch (e) { alert('Save failed: ' + (e?.message || e)); }
    finally { setSaving(false); }
  };

  const saveOwnerPin = async () => {
    if (!/^\d{4,8}$/.test(ownerPin)) return alert('PIN must contain 4 to 8 digits.');
    if (ownerPin !== confirmPin) return alert('PIN confirmation does not match.');
    setSavingPin(true);
    try {
      const result = await base44.functions.invoke('set-owner-pin', { pin: ownerPin });
      const payload = result?.data || result;
      if (!payload?.success) throw new Error(payload?.error || 'Could not save PIN.');
      setOwnerPin('');
      setConfirmPin('');
      alert('Owner approval PIN saved securely.');
    } catch (e) { alert('PIN save failed: ' + (e?.message || e)); }
    finally { setSavingPin(false); }
  };

  const addShop = async () => {
    const name = prompt('Shop name:');
    if (!name) return;
    const address = prompt('Address (optional):') || '';
    await base44.entities.Shop.create({ name, address });
    load();
  };

  return (
    <div className="p-5 sm:p-8 max-w-3xl mx-auto animate-fade-in">
      <PageHeader title="Settings" subtitle="Shop info, receipt text & shops" icon={SettingsIcon} />
      {loading ? (
        <div className="space-y-4">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : (
        <>
          <div className="rounded-2xl bg-card border border-border premium-shadow p-5 space-y-4">
            <h2 className="font-display text-lg font-bold">Receipt</h2>
            <div>
              <Label className="text-xs mb-1.5 block">Shop name</Label>
              <Input value={shopName} onChange={(e) => setShopName(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Thank-you message</Label>
              <Textarea value={thankYou} onChange={(e) => setThankYou(e.target.value)} rows={2} />
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">Receipt footer (optional)</Label>
              <Input value={receiptFooter} onChange={(e) => setReceiptFooter(e.target.value)} placeholder="Address / phone / Instagram" />
            </div>
            <div className="w-32">
              <Label className="text-xs mb-1.5 block">Currency</Label>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value)} />
            </div>
            <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">
              <Save className="w-4 h-4 mr-1.5" /> {saving ? 'Saving…' : 'Save settings'}
            </Button>
          </div>

          <div className="rounded-2xl bg-card border border-border premium-shadow p-5 mt-5 space-y-4">
            <div>
              <h2 className="font-display text-lg font-bold">Owner approval PIN</h2>
              <p className="text-xs text-muted-foreground mt-1">Used later for refunds and protected cashier actions. The PIN is stored only as a secure hash.</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs mb-1.5 block">New PIN (4–8 digits)</Label>
                <Input type="password" inputMode="numeric" autoComplete="new-password" value={ownerPin} onChange={(e) => setOwnerPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
              </div>
              <div>
                <Label className="text-xs mb-1.5 block">Confirm PIN</Label>
                <Input type="password" inputMode="numeric" autoComplete="new-password" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
              </div>
            </div>
            <Button onClick={saveOwnerPin} disabled={savingPin || !ownerPin || !confirmPin} variant="outline">
              {savingPin ? 'Saving securely…' : 'Set owner PIN'}
            </Button>
          </div>

          <div className="rounded-2xl bg-card border border-border premium-shadow p-5 mt-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-bold flex items-center gap-2"><Building2 className="w-5 h-5 text-primary-strong" /> Shops</h2>
              <Button variant="outline" size="sm" onClick={addShop}>Add shop</Button>
            </div>
            <div className="space-y-2">
              {shops.map((s) => (
                <div key={s.id} className="flex items-center gap-3 p-3 rounded-xl bg-secondary/50">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{s.name} {s.is_main && <span className="text-xs text-primary-strong">· Main</span>}</div>
                    {s.address && <div className="text-xs text-muted-foreground truncate">{s.address}</div>}
                  </div>
                </div>
              ))}
              {shops.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No shops yet.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}