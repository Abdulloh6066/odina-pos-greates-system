import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { base44 } from '@/api/base44Client';

export default function Layout() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    let active = true;
    base44.auth.me()
      .then((u) => active && setUser(u))
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="w-9 h-9 border-4 border-secondary border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex">
      <Sidebar user={user} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="lg:hidden flex items-center justify-between px-4 h-14 border-b border-border bg-card sticky top-0 z-30">
          <button onClick={() => setMobileOpen(true)} className="p-2 -ml-2 text-foreground">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <span className="font-display text-lg font-semibold tracking-tight">Odina Shop</span>
          <div className="w-9" />
        </div>
        <main className="flex-1 min-w-0">
          <Outlet context={{ user, reloadUser: async () => { const u = await base44.auth.me(); setUser(u); } }} />
        </main>
      </div>
    </div>
  );
}