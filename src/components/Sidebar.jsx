import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Archive, ArrowRightLeft, BarChart3, Banknote, Boxes, Building2, Cake, ChevronDown,
  Circle, Clock, LayoutDashboard, LogOut, PanelLeftClose, PanelLeftOpen,
  ReceiptText, Settings, ShoppingCart, Tags, Ticket, Truck, Users, Warehouse,
} from 'lucide-react';
import { MENU_ITEMS, canAccess } from '@/lib/pos';
import { base44 } from '@/api/base44Client';

const ICONS = {
  LayoutDashboard, ShoppingCart, Cake, Tags, BarChart3, Ticket,
  ReceiptText, Clock, Banknote, Building2, Warehouse, Users, Settings,
  Ombor: Warehouse, Xodimlar: Users, Sozlamalar: Settings,
};

const KASSA_CHILD_KEYS = ['products', 'categories', 'sales', 'cashouts', 'recipients'];
const WAREHOUSE_CHILDREN = [
  { key: 'warehouse-ingredients', label: 'Masalliqlar va qadoqlar', path: '/warehouse?tab=ingredients', icon: Archive, tab: 'ingredients' },
  { key: 'warehouse-products', label: 'Tayyor mahsulotlar', path: '/warehouse?tab=products', icon: Boxes, tab: 'products', roles: ['admin', 'cashier', 'accountant', 'production'] },
  { key: 'warehouse-suppliers', label: 'Kirim va qarzlar', path: '/warehouse?tab=suppliers', icon: Truck, tab: 'suppliers', roles: ['admin', 'warehouse', 'accountant'] },
  { key: 'warehouse-transfers', label: 'Transferlar', path: '/warehouse?tab=transfers', icon: ArrowRightLeft, tab: 'transfers', roles: ['admin', 'cashier', 'accountant', 'production'] },
  { key: 'warehouse-history', label: 'Ombor tarixi', path: '/warehouse?tab=history', icon: Clock, tab: 'history' },
];

export default function Sidebar({ user, mobileOpen, onClose, collapsed, onToggle }) {
  const role = user?.role || 'cashier';
  const location = useLocation();
  const items = MENU_ITEMS.filter((item) => canAccess(role, item.key));
  const hasKassa = items.some((item) => item.key === 'pos');
  const kassaChildren = hasKassa ? items.filter((item) => KASSA_CHILD_KEYS.includes(item.key)) : [];
  const topItems = items.filter((item) => !hasKassa || !KASSA_CHILD_KEYS.includes(item.key));
  const kassaPaths = ['/pos', ...kassaChildren.map((item) => item.path)];
  const kassaActive = kassaPaths.includes(location.pathname);
  const warehouseActive = location.pathname === '/warehouse';
  const warehouseTab = new URLSearchParams(location.search).get('tab') || 'ingredients';
  const [kassaOpen, setKassaOpen] = useState(kassaActive);
  const [warehouseOpen, setWarehouseOpen] = useState(warehouseActive);

  useEffect(() => {
    if (kassaActive) setKassaOpen(true);
  }, [kassaActive]);

  useEffect(() => {
    if (warehouseActive) setWarehouseOpen(true);
  }, [warehouseActive]);

  const handleLogout = async () => {
    await base44.auth.logout();
  };

  const renderRegularItem = (item) => {
    const Icon = ICONS[item.icon] || Circle;
    return (
      <NavLink
        key={item.key}
        to={item.path}
        end={item.path === '/'}
        onClick={onClose}
        title={collapsed ? item.label : undefined}
        className={({ isActive }) =>
          `group flex items-center gap-3 py-2.5 rounded-xl text-sm font-medium transition-all ${collapsed ? 'px-3.5 lg:justify-center lg:px-2' : 'px-3.5'} ${
            isActive
              ? 'bg-primary text-primary-foreground premium-shadow'
              : 'text-foreground/70 hover:bg-secondary hover:text-foreground'
          }`
        }
      >
        <Icon className="w-[18px] h-[18px] shrink-0" strokeWidth={2} />
        <span className={`truncate ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
      </NavLink>
    );
  };

  const renderGroup = ({ item, children, active, open, setOpen, ParentIcon }) => (
    <div key={item.key}>
      <NavLink
        to={item.path}
        onClick={() => {
          if (collapsed) onToggle();
          setOpen((current) => collapsed ? true : !current);
        }}
        title={collapsed ? item.label : undefined}
        className={`group flex items-center gap-3 py-2.5 rounded-xl text-sm font-medium transition-all ${collapsed ? 'px-3.5 lg:justify-center lg:px-2' : 'px-3.5'} ${
          active
            ? 'bg-primary text-primary-foreground premium-shadow'
            : 'text-foreground/70 hover:bg-secondary hover:text-foreground'
        }`}
      >
        <ParentIcon className="w-[18px] h-[18px] shrink-0" strokeWidth={2} />
        <span className={`flex-1 truncate ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} ${collapsed ? 'lg:hidden' : ''}`} />
      </NavLink>

      <div className={`grid transition-[grid-template-rows,opacity] duration-200 ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'} ${collapsed ? 'lg:hidden' : ''}`}>
        <div className="overflow-hidden">
          <div className="ml-5 mt-1 mb-2 pl-3 border-l border-primary/35 space-y-1">
            {children.map((child) => {
              const ChildIcon = child.icon || Circle;
              return (
                <NavLink
                  key={child.key}
                  to={child.path}
                  onClick={onClose}
                  className={`flex items-center gap-2.5 min-h-10 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                    child.active
                      ? 'bg-primary/15 text-primary-strong'
                      : 'text-foreground/65 hover:bg-secondary hover:text-foreground'
                  }`}
                >
                  <ChildIcon className="w-4 h-4 shrink-0" strokeWidth={2} />
                  <span className="truncate">{child.label}</span>
                </NavLink>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  const content = (
    <div className="flex flex-col h-full">
      <div className={`py-6 flex items-center gap-3 ${collapsed ? 'px-5 lg:px-3 lg:justify-center' : 'px-5'}`}>
        <div className="w-11 h-11 rounded-2xl bg-primary flex items-center justify-center premium-shadow shrink-0">
          <Cake className="w-6 h-6 text-primary-foreground" strokeWidth={2.2} />
        </div>
        <div className={`min-w-0 ${collapsed ? 'lg:hidden' : ''}`}>
          <div className="font-display text-xl font-bold leading-tight tracking-tight">Odina Shop</div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Qandolat · Kassa</div>
        </div>
      </div>

      <nav className="flex-1 px-3 space-y-1 overflow-y-auto scrollbar-thin">
        {topItems.map((item) => {
          if (item.key === 'pos') {
            return renderGroup({
              item,
              active: kassaActive,
              open: kassaOpen,
              setOpen: setKassaOpen,
              ParentIcon: ShoppingCart,
              children: kassaChildren.map((child) => ({
                ...child,
                icon: ICONS[child.icon] || Circle,
                active: location.pathname === child.path,
              })),
            });
          }

          if (item.key === 'warehouse') {
            return renderGroup({
              item: { ...item, path: '/warehouse?tab=ingredients' },
              active: warehouseActive,
              open: warehouseOpen,
              setOpen: setWarehouseOpen,
              ParentIcon: Warehouse,
              children: WAREHOUSE_CHILDREN.filter((child) => !child.roles || child.roles.includes(role)).map((child) => ({
                ...child,
                active: warehouseActive && warehouseTab === child.tab,
              })),
            });
          }

          return renderRegularItem(item);
        })}
      </nav>

      <div className="p-3 border-t border-border">
        <div className={`flex items-center gap-3 py-2 rounded-xl ${collapsed ? 'px-2 lg:justify-center lg:px-0' : 'px-2'}`}>
          <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold text-foreground/80 shrink-0">
            {(user?.full_name || user?.email || '?').charAt(0).toUpperCase()}
          </div>
          <div className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
            <div className="text-sm font-medium truncate">{user?.full_name || user?.email}</div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{role}</div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          title={collapsed ? 'Chiqish' : undefined}
          className={`mt-1 w-full flex items-center gap-3 py-2.5 rounded-xl text-sm font-medium text-foreground/70 hover:bg-secondary hover:text-foreground transition-colors ${collapsed ? 'px-3.5 lg:justify-center lg:px-2' : 'px-3.5'}`}
        >
          <LogOut className="w-[18px] h-[18px]" strokeWidth={2} />
          <span className={collapsed ? 'lg:hidden' : ''}>Chiqish</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className={`relative hidden lg:flex shrink-0 flex-col bg-sidebar border-r border-sidebar-border h-screen sticky top-0 transition-[width] duration-200 ${collapsed ? 'w-20' : 'w-64'}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Menyuni ochish' : 'Menyuni yopish'}
          title={collapsed ? 'Menyuni ochish' : 'Menyuni yopish'}
          className="absolute -right-3 top-7 z-20 w-7 h-7 rounded-full border border-sidebar-border bg-card text-foreground/70 shadow-md flex items-center justify-center hover:bg-primary hover:text-primary-foreground transition-colors touch-manipulation"
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
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
