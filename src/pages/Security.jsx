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
import BusinessBackupPanel from '@/components/security/BusinessBackupPanel';
import DataCleanupPanel from '@/components/security/DataCleanupPanel';

export default function Security() {
  const { user } = useOutletContext();
  const [users, setUsers] = useState([]);
  const [canManageAdmins, setCanManageAdmins] = useState(false);
  const [pinSet, setPinSet] = useState(false);
  const [audit, setAudit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await base44.functions.invoke('security-admin', { action: 'status' });
      const data = response?.data || response;
      setUsers(data?.users || []);
      setCanManageAdmins(data?.can_manage_admins === true);
      setPinSet(Boolean(data?.pin_set));
      setAudit(data?.audit || []);
      setLoadError('');
    } catch {
      setLoadError('Xavfsizlik holatini yuklab bo‘lmadi. Yangilab qayta urinib ko‘ring.');
    } finally {
      setLoading(false);
    }
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
      {loadError && (
        <div role="alert" className="mb-5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadError}
        </div>
      )}
      {loading ? (
        <div className="space-y-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-28 rounded-2xl bg-secondary animate-pulse" />)}</div>
      ) : (
        <div className="space-y-5">
          <SecurityPosture users={users} pinSet={pinSet} />
          <RoleMatrix />
          <div className="grid lg:grid-cols-2 gap-5">
            <PinManager onSaved={() => setReloadKey((k) => k + 1)} />
            <StaffAccessPanel users={users} currentUser={user} canManageAdmins={canManageAdmins} onChanged={() => setReloadKey((k) => k + 1)} />
          </div>
          <SecurityAuditFeed entries={audit} />
          <BusinessBackupPanel user={user} />
          <DataCleanupPanel />
        </div>
      )}
    </div>
  );
}