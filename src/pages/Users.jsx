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
import { logAction } from '@/lib/pos';
import { odinaConfirm } from '@/lib/odina-dialog';
import { Trash2, RotateCcw } from 'lucide-react';

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
  const [canManageAdmins, setCanManageAdmins] = useState(false);
  const [pendingDemotion, setPendingDemotion] = useState(null);
  const [demotionShopId, setDemotionShopId] = useState('');
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [accessResponse, sh] = await Promise.all([
        base44.functions.invoke('security-admin', { action: 'status' }),
        base44.entities.Shop.list(),
      ]);
      const access = accessResponse?.data || accessResponse;
      setUsers(access?.users || []);
      setCanManageAdmins(access?.can_manage_admins === true);
      setShops(sh || []);
    } catch (error) {
      setCanManageAdmins(false);
      void odinaAlert('Xodimlar ro‘yxatini yuklab bo‘lmadi: ' + (error?.message || error));
    }
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

  const updateRole = async (target, role) => {
    if (role === target.role) return;
    if ((role === 'admin' || target.role === 'admin') && !canManageAdmins) return;
    if (target.role === 'admin' && role !== 'admin') {
      setPendingDemotion({ target, role });
      setDemotionShopId(target.shop_id || '');
      return;
    }
    if (role === 'admin') {
      const confirmed = await odinaConfirm({
        title: 'Admin huquqini berish',
        description: `${target.full_name || target.email} barcha do‘konlar, Budget va xodimlar bo‘limiga kirish huquqini oladi. Tasdiqlaysizmi?`,
        confirmLabel: 'Admin qilish',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    await updateAccess({ target_user_id: target.id, role });
  };

  const confirmDemotion = async () => {
    if (!pendingDemotion || !demotionShopId) {
      void odinaAlert('Yangi lavozim uchun do‘konni tanlang.');
      return;
    }
    const { target, role } = pendingDemotion;
    setPendingDemotion(null);
    await updateAccess({ target_user_id: target.id, role, shop_id: demotionShopId });
    setDemotionShopId('');
  };

  const updateShop = async (id, shopId) => {
    await updateAccess({ target_user_id: id, shop_id: shopId });
  };

  const toggleActive = async (u) => {
    const next = u.active === false;
    const confirmed = await odinaConfirm({
      title: next ? 'Xodimni yoqish' : 'Xodimni o‘chirish',
      description: next
        ? `${u.full_name || u.email} tizimga kirishini qayta yoqmoqchimisiz?`
        : `${u.full_name || u.email} hisobini o‘chirmoqchimisiz? Ular tizimga kira olmaydi.`,
      confirmLabel: next ? 'Yoqish' : 'O‘chirish',
      tone: next ? 'info' : 'danger',
    });
    if (!confirmed) return;
    try {
      await base44.functions.invoke('security-admin', {
        action: 'update_user_access',
        target_user_id: u.id,
        active: next,
      });
      await logAction(user, next ? 'staff_reenabled' : 'staff_disabled', `${u.full_name || u.email}`);
      await load();
    } catch (error) {
      void odinaAlert(error?.response?.data?.error || "Xodim holatini o‘zgartirib bo‘lmadi.");
    }
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
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{u.full_name || 'Nomsiz xodim'}</span>
                    {u.active === false && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-destructive/10 text-destructive font-semibold shrink-0">O‘chirilgan</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                </div>
              </div>
              {u.is_owner ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Shield className="w-4 h-4 text-brand-olive" />
                  Himoyalangan hisob — o‘chirilishi yoki o‘zgartirilishi mumkin emas.
                </div>
              ) : u.id !== user.id && (u.role !== 'admin' || canManageAdmins) ? (
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr] gap-2 w-full min-w-0">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Ruxsat darajasi</span>
                    <OdinaSelect value={u.role} onChange={(e) => updateRole(u, e.target.value)} className="h-11 rounded-lg border border-input bg-card px-2 text-sm font-medium">
                      {(canManageAdmins || u.role === 'admin') && <option value="admin" disabled={!canManageAdmins}>Admin</option>}
                      <option value="manager">Boshqaruvchi</option>
                      <option value="cashier">Kassir</option>
                      <option value="accountant">Hisobchi</option>
                      <option value="production">Ishlab chiqarish xodimi</option>
                      <option value="warehouse">Omborchi</option>
                    </OdinaSelect>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Ish joyi</span>
                    {u.role === 'admin' ? (
                      <p className="min-h-11 flex items-center text-xs text-muted-foreground">Barcha do‘konlar · lavozimni o‘zgartirishda ish joyi tanlanadi</p>
                    ) : (
                      <OdinaSelect value={u.shop_id || ''} onChange={(e) => updateShop(u.id, e.target.value)} className="h-11 rounded-lg border border-input bg-card px-2 text-sm font-medium">
                        <option value="">Joy biriktirilmagan</option>
                        {shops.map((s) => <option key={s.id} value={s.id}>{s.name}{s.location_type === 'production' ? ' · Ishlab chiqarish markazi' : ' · Do‘kon'}</option>)}
                      </OdinaSelect>
                    )}
                  </div>
                  <div className="flex gap-2 sm:col-span-2">
                    {u.active === false ? (
                      <Button
                        type="button"
                        size="sm"
                        className="h-9 bg-emerald-600 hover:bg-emerald-700 text-white"
                        onClick={() => toggleActive(u)}
                      >
                        <RotateCcw className="w-4 h-4 mr-1.5" /> Tasdiqlash (yoqish)
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-9 border-destructive/40 text-destructive hover:bg-destructive/10"
                        onClick={() => toggleActive(u)}
                      >
                        <Trash2 className="w-4 h-4 mr-1.5" /> O‘chirish
                      </Button>
                    )}
                  </div>
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
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onDone={() => { setInviteOpen(false); load(); }} user={user} shops={shops} canManageAdmins={canManageAdmins} />
      <Dialog open={Boolean(pendingDemotion)} onOpenChange={(open) => { if (!open) setPendingDemotion(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Admin huquqini qaytarib olish</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{pendingDemotion?.target.full_name || pendingDemotion?.target.email} yangi lavozimga o‘tadi. Oldingi savdo va moliyaviy tarix saqlanadi.</p>
          <div className="space-y-2">
            <Label>Yangi ish joyi</Label>
            <OdinaSelect value={demotionShopId} onChange={(event) => setDemotionShopId(event.target.value)}>
              <option value="">Do‘konni tanlang</option>
              {shops.filter((shop) => shop.active !== false).map((shop) => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
            </OdinaSelect>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDemotion(null)}>Bekor qilish</Button>
            <Button disabled={!demotionShopId} onClick={confirmDemotion}>Lavozimni o‘zgartirish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InviteDialog({ open, onClose, onDone, user, shops = [], canManageAdmins = false }) {
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

    if (role === 'admin') {
      if (!canManageAdmins) return;
      const confirmed = await odinaConfirm({
        title: 'Admin taklifi',
        description: `${normalizedEmail} barcha do‘konlar, Budget va xodimlar bo‘limiga kirish huquqini oladi. Davom etasizmi?`,
        confirmLabel: 'Admin taklifini yuborish',
        tone: 'danger',
      });
      if (!confirmed) return;
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
              {canManageAdmins && <option value="admin">Admin (to‘liq huquq)</option>}
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
            Xodim emaildagi taklif havolasini ochib, o‘z parolini yaratadi. Birinchi kirishda tanlangan lavozim va ish joyi avtomatik biriktiriladi. Admin to‘liq huquqqa ega; faqat hisob egasi uni tayinlaydi.
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