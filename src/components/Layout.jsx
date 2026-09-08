import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import OdinaBrand from './brand/OdinaBrand';
import { base44 } from '@/api/base44Client';

export default function Layout() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('odina-sidebar-collapsed') === 'true');
  const location = useLocation();

  useEffect(() => {
    let active = true;
    base44.auth.me()
      .then((u) => active && setUser(u))
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => { setMobileOpen(false); }, [location.pathname, location.search]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem('odina-sidebar-collapsed', String(next));
      return next;
    });
  };

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="w-9 h-9 border-4 border-secondary border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background flex">
      <Sidebar
        user={user}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="odina-mobile-header lg:hidden flex items-center justify-between px-4 h-14 shrink-0 border-b border-brand-sand/50 bg-card sticky top-0 z-30">
          <button type="button" aria-label="Menyuni ochish" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} className="h-11 w-11 -ml-2 rounded-xl flex items-center justify-center text-brand-ink hover:bg-secondary">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <OdinaBrand compact />
          <div className="w-9" />
        </div>
        <main className="odina-workspace flex-1 min-w-0">
          <Outlet context={{ user, sidebarCollapsed, reloadUser: async () => { const u = await base44.auth.me(); setUser(u); } }} />
        </main>
      </div>
    </div>
  );
}