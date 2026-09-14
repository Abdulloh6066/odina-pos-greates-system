import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Shield, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import PageHeader from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import SecurityPosture from '@/components/security/SecurityPosture';
import RoleMatrix from '@/components/security/RoleMatrix';
import PinManager from '@/components/security/PinManager';
import StaffAccessPanel from '@/components/security/StaffAccessPanel';
import SecurityAuditFeed from '@/components/security/SecurityAuditFeed';

export default function Security() {
  const { user } = useOutletContext();
  const [users, setUsers] = useState([]);
  const [pinSet, setPinSet] = useState(false);
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, sec, ah] = await Promise.all([
        base44.entities.User.list(),
        base44.entities.SecuritySettings.list().catch(() => []),
        base44.entities.ActionHistory.list('-created_date', 30),
      ]);
      setUsers(u || []);
      setPinSet(Boolean((sec || []).some((s) => s.pin_hash)));
      setAudit(ah || []);
    } catch {
      /* admin-only reads; surface empty state on failure */
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [reloadKey, load]);

  return (
    <div className="odina-page p-5 sm:p-8 max-w-5xl mx-auto animate-fade-in">
      <PageHeader
        title="Xavfsizlik"
        subtitle="Tizim himoyasi va kirish nazorati · faqat Egasi / Admin"
        icon={Shield}
        actions={(
          <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} disabled={loading} className="min-h-11 rounded-xl">
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Yangilash</span>
          </Button>
        )}
      />
      {loading ? (
        <div className="space-y-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : (
        <div className="space-y-5">
          <SecurityPosture users={users} pinSet={pinSet} />
          <RoleMatrix />
          <div className="grid lg:grid-cols-2 gap-5">
            <PinManager user={user} onSaved={() => setReloadKey((k) => k + 1)} />
            <StaffAccessPanel users={users} currentUser={user} onChanged={() => setReloadKey((k) => k + 1)} />
          </div>
          <SecurityAuditFeed entries={audit} />
        </div>
      )}
    </div>
  );
}