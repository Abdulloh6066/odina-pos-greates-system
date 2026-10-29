import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, LockKeyhole } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

const AdminAccessContext = createContext(null);
const IDLE_MS = 5 * 60 * 1000;
export const isAdminShortcut = (event) => Boolean(event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey
  && !event.repeat && !event.isComposing && (event.code === 'KeyA' || String(event.key).toLowerCase() === 'a'));

export const useAdminAccess = () => useContext(AdminAccessContext);

export default function AdminAccessProvider({ children }) {
  const { user, offlineSession } = useAuth();
  const navigate = useNavigate();
  const [session, setSession] = useState(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const sessionRef = useRef(null);
  const submitting = useRef(false);
  const identity = String(user?.id || '');
  const eligible = user?.role === 'admin' && user.active !== false && !offlineSession;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;

  const lock = useCallback(() => {
    generation.current++;
    sessionRef.current = null;
    submitting.current = false;
    setSession(null);
    setPassword('');
    setOpen(false);
    setBusy(false);
    setError('');
  }, []);

  useEffect(() => {
    lock();
    return () => { generation.current++; sessionRef.current = null; };
  }, [identity, eligible, lock]);

  const checkSession = useCallback(async () => {
    const saved = sessionRef.current;
    if (!saved || saved.userId !== identity || saved.expiresAt <= Date.now() || !eligibleRef.current) return false;
    const currentGeneration = generation.current;
    try {
      await base44.functions.invoke('security-admin', { action: 'admin_panel_session', token: saved.token });
      return currentGeneration === generation.current && identityRef.current === identity && eligibleRef.current;
    } catch {
      if (currentGeneration === generation.current) lock();
      return false;
    }
  }, [identity, lock]);

  const requestOpen = useCallback(async () => {
    if (!eligibleRef.current) return;
    if (sessionRef.current && await checkSession()) { navigate('/admin'); return; }
    if (!eligibleRef.current) return;
    generation.current++;
    setPassword('');
    setError(navigator.onLine === false ? 'Admin panelga kirish uchun internet kerak.' : '');
    setOpen(true);
  }, [checkSession, navigate]);

  useEffect(() => {
    const shortcut = (event) => {
      if (!eligibleRef.current || !isAdminShortcut(event)) return;
      event.preventDefault();
      void requestOpen();
    };
    window.addEventListener('keydown', shortcut);
    window.addEventListener('offline', lock);
    return () => {
      window.removeEventListener('keydown', shortcut);
      window.removeEventListener('offline', lock);
    };
  }, [requestOpen, lock]);

  useEffect(() => {
    if (!session) return undefined;
    let idleTimer;
    const expire = () => { lock(); };
    const resetIdle = () => {
      if (session.expiresAt <= Date.now()) { lock(); return; }
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(expire, Math.min(IDLE_MS, session.expiresAt - Date.now()));
    };
    const absoluteTimer = window.setTimeout(expire, Math.max(0, session.expiresAt - Date.now()));
    resetIdle();
    window.addEventListener('pointerdown', resetIdle);
    window.addEventListener('keydown', resetIdle);
    window.addEventListener('focus', resetIdle);
    return () => {
      window.clearTimeout(idleTimer);
      window.clearTimeout(absoluteTimer);
      window.removeEventListener('pointerdown', resetIdle);
      window.removeEventListener('keydown', resetIdle);
      window.removeEventListener('focus', resetIdle);
    };
  }, [session, lock]);

  const submit = async (event) => {
    event.preventDefault();
    if (!eligibleRef.current || submitting.current || !password) return;
    if (navigator.onLine === false) { setError('Admin panelga kirish uchun internet kerak.'); return; }
    submitting.current = true;
    const currentGeneration = generation.current;
    setBusy(true);
    setError('');
    const entered = password;
    setPassword('');
    try {
      const response = await base44.functions.invoke('security-admin', { action: 'admin_panel_unlock', password: entered });
      const data = response.data;
      if (currentGeneration !== generation.current || identityRef.current !== identity || !eligibleRef.current) return;
      if (!data?.ok || !data.token || !Number.isFinite(data.expires_at) || data.expires_at <= Date.now()) throw new Error('Kirish tasdiqlanmadi.');
      const next = { token: data.token, expiresAt: data.expires_at, userId: identity };
      sessionRef.current = next;
      setSession(next);
      setOpen(false);
      navigate('/admin');
    } catch (failure) {
      if (currentGeneration === generation.current) {
        const retryAfter = Number(failure?.response?.data?.retry_after);
        setError((failure?.response?.data?.error || 'Kirishni tekshirib bo‘lmadi. Internet aloqasini tekshiring.')
          + (retryAfter > 2 ? ' Taxminan ' + Math.ceil(retryAfter / 60) + ' daqiqadan keyin urinib ko‘ring.' : ''));
      }
    } finally {
      if (currentGeneration === generation.current) { submitting.current = false; setBusy(false); }
    }
  };

  const unlocked = eligible && session?.userId === identity && session.expiresAt > Date.now();
  return (
    <AdminAccessContext.Provider value={{ eligible, unlocked, requestOpen, checkSession, lock, expiresAt: session?.expiresAt || 0 }}>
      {children}
      <Dialog open={open && eligible} onOpenChange={(next) => {
        if (!next) { generation.current++; submitting.current = false; setBusy(false); setPassword(''); setError(''); }
        setOpen(next);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <span className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-olive/15 text-foreground"><ShieldCheck className="h-6 w-6" /></span>
            <DialogTitle>Admin panelga kirish</DialogTitle>
            <DialogDescription>Egasi / Admin uchun himoyalangan boshqaruv. Parol serverda tekshiriladi.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="admin-panel-password">Admin paroli</Label>
              <Input id="admin-panel-password" type="password" autoComplete="off" autoFocus maxLength={256}
                value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} className="h-12 rounded-xl" />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy || !password} className="h-12 w-full rounded-xl gap-2">
              <LockKeyhole className="h-4 w-4" />{busy ? 'Tekshirilmoqda…' : 'Admin panelni ochish'}
            </Button>
            <p className="text-xs text-muted-foreground">Ctrl + Alt + A · 5 daqiqa harakatsizlikdan so‘ng avtomatik qulflanadi.</p>
          </form>
        </DialogContent>
      </Dialog>
    </AdminAccessContext.Provider>
  );
}
