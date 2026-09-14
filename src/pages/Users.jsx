import React, { useEffect, useState } from 'react';
import OdinaSelect from '@/components/ui/odina-select';
import { useOutletContext, Navigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert } from '@/lib/odina-dialog';
import { Users as UsersIcon, UserPlus, Shield } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

const ROLE_COLORS = {
  admin: 'bg-red-50 text-red-700',
  manager: 'bg-cyan-50 text-cyan-700',
  cashier: 'bg-blue-50 text-blue-700',
  accountant: 'bg-violet-50 text-violet-700',
  production: 'bg-amber-50 text-amber-700',
  warehouse: 'bg-emerald-50 text-emerald-700',
};

const ROLE_LABELS = {
  admin: 'Egasi / Admin',
  manager: 'Boshqaruvchi',
  cashier: 'Kassir',
  accountant: 'Hisobchi',
  production: 'Ishlab chiqarish xodimi',
  warehouse: 'Omborchi',
};

export default function Users() {
  const { user } = useOutletContext();
  const [users, setUsers] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [u, sh] = await Promise.all([base44.entities.User.list(), base44.entities.Shop.list()]);
      setUsers(u || []);
      setShops(sh || []);
    } catch {}
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  const updateAccess = async (payload) => {
    try {
      await base44.functions.invoke('security-admin', {
        action: 'update_user_access',
        ...payload,
      });
      await load();
    } catch (error) {
      void odinaAlert(error?.response?.data?.error || "Xodim ruxsatini yangilab bo‘lmadi.");
    }
  };

  const updateRole = async (id, role) => {
    await updateAccess({ target_user_id: id, role });
  };

  const updateShop = async (id, shopId) => {
    await updateAccess({ target_user_id: id, shop_id: shopId });
  };

  return (
    <div className="odina-page p-5 sm:p-8 max-w-4xl mx-auto animate-fade-in">
      <PageHeader
        title="Xodimlar"
        subtitle={`${users.length} ta xodim`}
        icon={UsersIcon}
        actions={<Button onClick={() => setInviteOpen(true)} className="bg-primary text-primary-foreground hover:bg-primary-strong"><UserPlus className="w-4 h-4 mr-1.5" /> Xodim qo‘shish</Button>}
      />
      {loading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : (
        <div className="space-y-3">
          {users.map((u) => (
            <div key={u.id} className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-4 flex flex-col gap-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center font-semibold shrink-0">
                  {(u.full_name || u.email || '?').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="font-medium truncate">{u.full_name || 'Nomsiz xodim'}</div>
                  <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                </div>
              </div>
              {u.id !== user.id ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full min-w-0">
                  <OdinaSelect value={u.role} onChange={(e) => updateRole(u.id, e.target.value)} className="h-9 rounded-lg border border-input bg-card px-2 text-sm font-medium">
                    <option value="admin" disabled>Egasi / Admin</option>
                    <option value="manager">Boshqaruvchi</option>
                    <option value="cashier">Kassir</option>
                    <option value="accountant">Hisobchi</option>
                    <option value="production">Ishlab chiqarish xodimi</option>
                    <option value="warehouse">Omborchi</option>
                  </OdinaSelect>
                  <OdinaSelect value={u.shop_id || ''} onChange={(e) => updateShop(u.id, e.target.value)} className="h-9 rounded-lg border border-input bg-card px-2 text-sm font-medium">
                    <option value="">Joy biriktirilmagan</option>
                    {shops.map((s) => <option key={s.id} value={s.id}>{s.name}{s.location_type === 'production' ? ' · Ishlab chiqarish markazi' : ' · Do‘kon'}</option>)}
                  </OdinaSelect>
                </div>
              ) : (
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${ROLE_COLORS[u.role] || 'bg-secondary'} flex items-center gap-1 w-fit`}>
                  <Shield className="w-3 h-3" /> {ROLE_LABELS[u.role] || u.role} (siz)
                </span>
              )}
            </div>
          ))}
          {users.length === 0 && <p className="text-sm text-muted-foreground text-center py-16">Xodimlar topilmadi.</p>}
        </div>
      )}
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onDone={() => { setInviteOpen(false); load(); }} user={user} shops={shops} />
    </div>
  );
}

function InviteDialog({ open, onClose, onDone, user, shops = [] }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('cashier');
  const [shopId, setShopId] = useState('');
  const [saving, setSaving] = useState(false);
  const needsShop = role !== 'admin';
  const activeShops = shops.filter((shop) => shop.active !== false);

  const submit = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      void odinaAlert('Xodimning email manzilini kiriting.');
      return;
    }
    if (needsShop && !shopId) {
      void odinaAlert('Xodim ishlaydigan joyni tanlang.');
      return;
    }

    setSaving(true);
    try {
      const result = await base44.functions.invoke('staff-invite', {
        action: 'invite',
        email: normalizedEmail,
        role,
        shop_id: needsShop ? shopId : '',
      });
      const data = result?.data || result;
      if (!data?.invited) throw new Error(data?.error || 'Taklif yuborilmadi.');

      await logAction(user, 'staff_invite_requested', `${normalizedEmail} · ${role}`);
      const locationText = data.shop_name ? `\nIsh joyi: ${data.shop_name}` : '';
      void odinaAlert(`Taklif yuborildi.\nLavozim: ${ROLE_LABELS[role]}${locationText}\n\nXodim emaildagi havolani ochib, o‘z parolini yaratadi.`);
      setEmail('');
      setRole('cashier');
      setShopId('');
      onDone();
    } catch (e) {
      const message = e?.response?.data?.error || e?.message || String(e);
      void odinaAlert(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle className="font-display text-xl">Xodimni taklif qilish</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="xodim@odina.uz" type="email" disabled={saving} />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Lavozim</Label>
            <OdinaSelect
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={saving}
              className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm font-medium"
            >
              <option value="manager">Boshqaruvchi</option>
              <option value="cashier">Kassir</option>
              <option value="accountant">Hisobchi</option>
              <option value="production">Ishlab chiqarish xodimi</option>
              <option value="warehouse">Omborchi</option>
            </OdinaSelect>
          </div>
          {needsShop && (
            <div>
              <Label className="text-xs mb-1.5 block">Ish joyi</Label>
              <OdinaSelect
                value={shopId}
                onChange={(e) => setShopId(e.target.value)}
                disabled={saving}
                className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm font-medium"
              >
                <option value="">Joyni tanlang</option>
                {activeShops.map((shop) => (
                  <option key={shop.id} value={shop.id}>
                    {shop.name} · {shop.location_type === 'production' ? 'Ishlab chiqarish markazi' : 'Do‘kon'}
                  </option>
                ))}
              </OdinaSelect>
            </div>
          )}
          <div className="rounded-xl bg-secondary/70 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
            Xodim emaildagi taklif havolasini ochib, o‘z parolini yaratadi. Birinchi kirishda tanlangan lavozim va ish joyi avtomatik biriktiriladi.
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Bekor qilish</Button>
          <Button onClick={submit} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">
            {saving ? 'Yuborilmoqda…' : 'Taklif yuborish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}