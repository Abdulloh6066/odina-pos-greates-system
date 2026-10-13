import React, { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import OdinaBrand from './brand/OdinaBrand';
import { useAuth } from '@/lib/AuthContext';

export default function Layout() {
  const { user, isLoadingAuth, checkUserAuth } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('odina-sidebar-collapsed') === 'true');
  const [posCompact, setPosCompact] = useState(() => localStorage.getItem('odina-pos-density') === 'compact');
  const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const location = useLocation();
  const compactPOS = location.pathname === '/pos' && posCompact;
  const effectiveSidebarCollapsed = compactPOS ? !compactSidebarOpen : sidebarCollapsed;
  const togglePosCompact = () => {
    const next = !posCompact;
    setPosCompact(next);
    setCompactSidebarOpen(false);
    localStorage.setItem('odina-pos-density', next ? 'compact' : 'normal');
  };
  const screenMode = location.pathname === '/pos' && new URLSearchParams(location.search).get('screen') === '1';

  useEffect(() => { setMobileOpen(false); }, [location.pathname, location.search]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  const toggleSidebar = () => {
    if (compactPOS) { setCompactSidebarOpen((open) => !open); return; }
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem('odina-sidebar-collapsed', String(next));
      return next;
    });
  };

  if (isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="w-9 h-9 border-4 border-secondary border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  const pageFallback = (
    <div role="status" aria-label="Sahifa yuklanmoqda" className="odina-page p-5 sm:p-8 space-y-4 animate-pulse">
      <div className="h-8 w-48 rounded-xl bg-secondary" />
      <div className="h-24 rounded-2xl bg-secondary" />
      <div className="h-40 rounded-2xl bg-secondary" />
    </div>
  );

  if (screenMode) {
    return (
      <div className="odina-redesign-shell min-h-dvh bg-background flex flex-col">
        <main className="odina-workspace odina-workbench flex-1 min-w-0" data-page={location.pathname}>
          <Suspense fallback={pageFallback}>
            <Outlet context={{ user, sidebarCollapsed: false, posCompact, togglePosCompact, reloadUser: checkUserAuth, screenMode: true }} />
          </Suspense>
        </main>
      </div>
    );
  }

  return (
    <div className="odina-redesign-shell min-h-dvh bg-background flex">
      <Sidebar
        user={user}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        collapsed={effectiveSidebarCollapsed}
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
        <main className="odina-workspace odina-workbench flex-1 min-w-0" data-page={location.pathname}>
          <Suspense fallback={pageFallback}>
            <Outlet context={{ user, sidebarCollapsed: effectiveSidebarCollapsed, posCompact, togglePosCompact, reloadUser: checkUserAuth, screenMode: false }} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
