import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { odinaAlert, odinaConfirm } from '@/lib/odina-dialog';
import { Users as UsersIcon, ArrowUpRight } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';

const ROLE_LABELS = { admin: 'Admin', manager: 'Boshqaruvchi', cashier: 'Kassir', accountant: 'Hisobchi', production: 'Ishlab chiq.', warehouse: 'Omborchi' };

export default function StaffAccessPanel({ users, currentUser, canManageAdmins = false, onChanged }) {
  const [busy, setBusy] = useState('');
  const navigate = useNavigate();

  const toggle = async (u) => {
    if (u.id === currentUser?.id || u.is_owner) return void odinaAlert("Himoyalangan hisobni o‘zgartirib bo‘lmaydi.");
    if (u.role === 'admin' && !canManageAdmins) return void odinaAlert('Admin hisobini faqat egasi boshqaradi.');
    const nextActive = u.active === false;
    if (!nextActive) {
      const ok = await odinaConfirm(`${u.full_name || u.email} ni o'chirishni tasdiqlang? U tizimga kira olmaydi.`, { tone: 'danger' });
      if (!ok) return;
    }
    setBusy(u.id);
    try {
      await base44.functions.invoke('security-admin', {
        action: 'update_user_access',
        target_user_id: u.id,
        active: nextActive,
      });
      onChanged?.();
    } catch (e) {
      void odinaAlert("Yangilab bo'lmadi: " + (e?.response?.data?.error || e?.message || e));
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="odina-panel rounded-2xl bg-card border border-border premium-shadow p-5">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <UsersIcon className="w-5 h-5 text-brand-ink" />
          <h2 className="font-display text-lg font-bold">Xodimlar kirish nazorati</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={() => navigate('/users')} className="text-xs">
          Barchasi <ArrowUpRight className="w-3.5 h-3.5" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mb-4">O‘chirilgan xodim tizimga kira olmaydi; hisob va tarix saqlanadi. Admin huquqini faqat hisob egasi boshqaradi. Lavozim va ish joyi «Xodimlar» sahifasida o‘zgartiriladi.</p>
      <div className="space-y-2 max-h-80 overflow-y-auto scrollbar-thin pr-1">
        {users.map((u) => {
          const disabled = u.active === false;
          const isSelf = u.id === currentUser?.id;
          const protectedAccount = isSelf || u.is_owner || (u.role === 'admin' && !canManageAdmins);
          return (
            <div key={u.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-secondary/50">
              <div className="w-8 h-8 rounded-full bg-card flex items-center justify-center font-semibold text-sm shrink-0">{(u.full_name || u.email || '?').charAt(0).toUpperCase()}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{u.full_name || 'Nomsiz'} {isSelf && <span className="text-xs text-muted-foreground">(siz)</span>}</div>
                <div className="text-[11px] text-muted-foreground truncate">{u.email} · {ROLE_LABELS[u.role] || u.role}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={'text-[11px] font-medium ' + (disabled ? 'text-destructive' : 'text-emerald-700')}>{disabled ? "O'chirilgan" : 'Faol'}</span>
                <Switch checked={!disabled} disabled={Boolean(busy) || protectedAccount} onCheckedChange={() => toggle(u)} aria-label="Kirishni yoqish/o'chirish" />
              </div>
            </div>
          );
        })}
        {users.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">Xodimlar topilmadi.</p>}
      </div>
    </section>
  );
}