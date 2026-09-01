import React, { useEffect, useState } from 'react';
import { useOutletContext, Navigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Users as UsersIcon, UserPlus, Shield } from 'lucide-react';
import { logAction } from '@/lib/pos';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

const ROLE_COLORS = {
  admin: 'bg-red-50 text-red-700',
  manager: 'bg-primary/15 text-primary-strong',
  cashier: 'bg-blue-50 text-blue-700',
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
    } catch (e) {}
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  const updateRole = async (id, role) => {
    await base44.entities.User.update(id, { role });
    await logAction(user, 'user_role_changed', `Role set to ${role}`);
    load();
  };

  const updateShop = async (id, shopId) => {
    const shop = shops.find((s) => s.id === shopId);
    await base44.entities.User.update(id, { shop_id: shopId || undefined, shop_name: shop?.name });
    load();
  };

  return (
    <div className="p-5 sm:p-8 max-w-4xl mx-auto animate-fade-in">
      <PageHeader
        title="Users"
        subtitle={`${users.length} users`}
        icon={UsersIcon}
        actions={<Button onClick={() => setInviteOpen(true)} className="bg-primary text-primary-foreground hover:bg-primary-strong"><UserPlus className="w-4 h-4 mr-1.5" /> Invite</Button>}
      />
      {loading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : (
        <div className="space-y-3">
          {users.map((u) => (
            <div key={u.id} className="rounded-2xl bg-card border border-border premium-shadow p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center font-semibold shrink-0">
                  {(u.full_name || u.email || '?').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="font-medium truncate">{u.full_name || 'Unnamed'}</div>
                  <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                </div>
              </div>
              {u.id !== user.id ? (
                <div className="flex items-center gap-2">
                  <select value={u.role} onChange={(e) => updateRole(u.id, e.target.value)} className="h-9 rounded-lg border border-input bg-card px-2 text-sm font-medium">
                    <option value="admin">Admin</option>
                    <option value="manager">Manager</option>
                    <option value="cashier">Cashier</option>
                  </select>
                  <select value={u.shop_id || ''} onChange={(e) => updateShop(u.id, e.target.value)} className="h-9 rounded-lg border border-input bg-card px-2 text-sm font-medium">
                    <option value="">No shop</option>
                    {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              ) : (
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${ROLE_COLORS[u.role] || 'bg-secondary'} flex items-center gap-1 w-fit`}>
                  <Shield className="w-3 h-3" /> {u.role} (you)
                </span>
              )}
            </div>
          ))}
          {users.length === 0 && <p className="text-sm text-muted-foreground text-center py-16">No users found.</p>}
        </div>
      )}
      <InviteDialog open={inviteOpen} shops={shops} onClose={() => setInviteOpen(false)} onDone={() => { setInviteOpen(false); load(); }} user={user} />
    </div>
  );
}

function InviteDialog({ open, shops, onClose, onDone, user }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('cashier');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!email.trim()) return;
    setSaving(true);
    try {
      await base44.users.inviteUser(email.trim(), role);
      await logAction(user, 'user_invited', `${email} as ${role}`);
      onDone();
    } catch (e) { alert('Invite failed: ' + (e?.message || e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle className="font-display text-xl">Invite user</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs mb-1.5 block">Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cashier@odina.uz" type="email" />
          </div>
          <div>
            <Label className="text-xs mb-1.5 block">Role</Label>
            <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full h-10 rounded-lg border border-input bg-card px-3 text-sm font-medium">
              <option value="cashier">Cashier</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary-strong">{saving ? 'Inviting…' : 'Send invite'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}