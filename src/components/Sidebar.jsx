import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  Cake, LayoutDashboard, ShoppingCart, Tags, BarChart3, Ticket,
  ReceiptText, Clock, Banknote, Warehouse, Users, Settings, LogOut, Circle,
} from 'lucide-react';
import { MENU_ITEMS, canAccess } from '@/lib/pos';
import { base44 } from '@/api/base44Client';

const ICONS = {
  LayoutDashboard, ShoppingCart, Cake, Tags, BarChart3, Ticket,
  ReceiptText, Clock, Banknote, Warehouse, Users, Settings,
};

export default function Sidebar({ user, mobileOpen, onClose }) {
  const role = user?.role || 'cashier';
  const items = MENU_ITEMS.filter((i) => canAccess(role, i.key));

  const handleLogout = async () => {
    await base44.auth.logout();
  };

  const content = (
    <div className="flex flex-col h-full">
      <div className="px-5 py-6 flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-primary flex items-center justify-center premium-shadow shrink-0">
          <Cake className="w-6 h-6 text-primary-foreground" strokeWidth={2.2} />
        </div>
        <div className="min-w-0">
          <div className="font-display text-xl font-bold leading-tight tracking-tight">Odina Shop</div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Patisserie · POS</div>
        </div>
      </div>

      <nav className="flex-1 px-3 space-y-1 overflow-y-auto scrollbar-thin">
        {items.map((item) => {
          const Icon = ICONS[item.icon] || Circle;
          return (
            <NavLink
              key={item.key}
              to={item.path}
              end={item.path === '/'}
              onClick={onClose}
              className={({ isActive }) =>
                `group flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-primary text-primary-foreground premium-shadow'
                    : 'text-foreground/70 hover:bg-secondary hover:text-foreground'
                }`
              }
            >
              <Icon className="w-[18px] h-[18px] shrink-0" strokeWidth={2} />
              <span className="truncate">{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-3 px-2 py-2 rounded-xl">
          <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold text-foreground/80 shrink-0">
            {(user?.full_name || user?.email || '?').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{user?.full_name || user?.email}</div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{role}</div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="mt-1 w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-foreground/70 hover:bg-secondary hover:text-foreground transition-colors"
        >
          <LogOut className="w-[18px] h-[18px]" strokeWidth={2} />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:flex w-64 shrink-0 flex-col bg-sidebar border-r border-sidebar-border h-screen sticky top-0">
        {content}
      </aside>
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-foreground/30 backdrop-blur-sm" onClick={onClose} />
          <aside className="absolute left-0 top-0 h-full w-72 bg-sidebar border-r border-sidebar-border shadow-2xl animate-fade-in">
            {content}
          </aside>
        </div>
      )}
    </>
  );
}