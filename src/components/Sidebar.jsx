import React, { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  Archive, ArrowRightLeft, BarChart3, Banknote, BookOpen, Boxes, Building2, Cake, ChefHat, ChevronDown,
  Circle, Clock, ClipboardList, LayoutDashboard, LogOut, Monitor, PanelLeftClose, PanelLeftOpen,
  ReceiptText, Settings, ShoppingCart, Tags, Ticket, Trash2, Truck, Users, WalletCards, Warehouse,
} from 'lucide-react';
import OdinaBrand from '@/components/brand/OdinaBrand';
import { MENU_ITEMS, canAccess } from '@/lib/pos';
import { base44 } from '@/api/base44Client';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';

const ICONS = {
  LayoutDashboard, ShoppingCart, ClipboardList, Cake, Tags, BarChart3, Ticket,
  ReceiptText, Clock, Banknote, Building2, WalletCards, Warehouse, Users, Settings, Trash2, Monitor,
  Ombor: Warehouse, Xodimlar: Users, Sozlamalar: Settings,
};

const KASSA_CHILD_KEYS = ['products', 'categories', 'sales', 'cashouts', 'recipients'];
const SCREENS_CHILDREN = [
  { key: 'production-screen', label: 'Ishlab chiqarish ekrani', path: '/production-screen', icon: ChefHat, roles: ['admin', 'production'] },
];
const WAREHOUSE_CHILDREN = [
  { key: 'warehouse-ingredients', label: 'Masalliqlar va qadoqlar', path: '/warehouse?tab=ingredients', icon: Archive, tab: 'ingredients' },
  { key: 'warehouse-products', label: 'Tayyor mahsulotlar', path: '/warehouse?tab=products', icon: Boxes, tab: 'products', roles: ['admin', 'manager', 'cashier', 'accountant', 'production'] },
  { key: 'warehouse-suppliers', label: 'Kirim va qarzlar', path: '/warehouse?tab=suppliers', icon: Truck, tab: 'suppliers', roles: ['admin', 'manager', 'warehouse', 'accountant'] },
  { key: 'warehouse-recipes', label: 'Retseptlar', path: '/warehouse?tab=recipes', icon: BookOpen, tab: 'recipes', roles: ['admin', 'manager', 'accountant', 'production'] },
  { key: 'warehouse-production', label: 'Ishlab chiqarish', path: '/warehouse?tab=production', icon: ChefHat, tab: 'production', roles: ['admin', 'manager', 'accountant', 'production'] },
  { key: 'warehouse-transfers', label: 'Transferlar', path: '/warehouse?tab=transfers', icon: ArrowRightLeft, tab: 'transfers', roles: ['admin', 'manager', 'cashier', 'accountant', 'production'] },
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
  const screensActive = location.pathname === '/production-screen';
  const warehouseTab = new URLSearchParams(location.search).get('tab') || 'ingredients';
  const [kassaOpen, setKassaOpen] = useState(kassaActive);
  const [warehouseOpen, setWarehouseOpen] = useState(warehouseActive);
  const [screensOpen, setScreensOpen] = useState(screensActive);

  useEffect(() => {
    if (kassaActive) setKassaOpen(true);
  }, [kassaActive]);

  useEffect(() => {
    if (warehouseActive) setWarehouseOpen(true);
  }, [warehouseActive]);

  useEffect(() => {
    if (screensActive) setScreensOpen(true);
  }, [screensActive]);

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
          `odina-nav-link group flex min-h-11 items-center gap-3 py-2.5 rounded-xl text-sm font-semibold transition-colors ${collapsed ? 'px-3.5 lg:justify-center lg:px-2' : 'px-3.5'} ${
            isActive
              ? 'bg-brand-olive/20 text-foreground shadow-[inset_3px_0_0_hsl(var(--brand-olive))]'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
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
      <div data-active={active} className={`odina-nav-group flex items-center rounded-xl border transition-colors ${active ? 'bg-brand-olive/20 border-brand-olive/35 text-foreground' : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
        <NavLink
          to={item.path}
          onClick={() => {
            if (collapsed) onToggle();
            setOpen(true);
            onClose();
          }}
          title={collapsed ? item.label : undefined}
          aria-label={item.label}
          className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold ${collapsed ? 'lg:justify-center lg:px-2' : ''}`}
        >
          <ParentIcon className="w-[18px] h-[18px] shrink-0" strokeWidth={2} />
          <span className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
        </NavLink>
        {children.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-label={`${item.label} bo‘limlarini ${open ? 'yopish' : 'ochish'}`}
            aria-expanded={open}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-brand-olive/15 ${collapsed ? 'lg:hidden' : ''}`}
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {open && children.length > 0 && (
        <div className={`odina-nav-children ml-5 mt-1 mb-2 pl-2 border-l-2 border-brand-sand/60 space-y-1 ${collapsed ? 'lg:hidden' : ''}`}>
          {children.map((child) => {
            const ChildIcon = child.icon || Circle;
            return (
              <Link
                key={child.key}
                to={child.path}
                onClick={onClose}
                aria-current={child.active ? 'page' : undefined}
                className={`odina-nav-child flex items-center gap-2.5 min-h-11 px-3 py-2 rounded-xl text-[13px] leading-snug font-medium transition-colors ${child.active ? 'bg-primary/25 text-brand-ink' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
              >
                <ChildIcon className="w-4 h-4 shrink-0" strokeWidth={2} />
                <span className="min-w-0 break-words">{child.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );

  const content = (
    <div className="odina-sidebar-content flex flex-col h-full min-h-0">
      <div className={`odina-sidebar-brand py-6 flex items-center gap-3 ${collapsed ? 'px-5 lg:px-3 lg:justify-center' : 'px-5'}`}>
        <OdinaBrand collapsed={collapsed} />
      </div>

      <nav aria-label="Asosiy menyu" className="flex-1 min-h-0 px-3 pb-3 space-y-1 overflow-y-auto overscroll-contain scrollbar-thin">
        <p className={`odina-nav-label ${collapsed ? 'lg:hidden' : ''}`}>ISH MAYDONI</p>
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

          if (item.key === 'screens') {
            return renderGroup({
              item,
              active: screensActive,
              open: screensOpen,
              setOpen: setScreensOpen,
              ParentIcon: Monitor,
              children: SCREENS_CHILDREN.filter((child) => !child.roles || child.roles.includes(role)).map((child) => ({
                ...child,
                active: location.pathname === child.path,
              })),
            });
          }

          return renderRegularItem(item);
        })}
      </nav>

      <div className="odina-sidebar-account p-3 safe-bottom border-t border-border bg-brand-sand/10">
        <div className={`flex items-center gap-3 py-2 rounded-xl ${collapsed ? 'px-2 lg:justify-center lg:px-0' : 'px-2'}`}>
          <div className="odina-user-avatar w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold text-foreground/80 shrink-0">
            {(user?.full_name || user?.email || '?').charAt(0).toUpperCase()}
          </div>
          <div className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
            <div className="text-sm font-medium truncate">{user?.full_name || user?.email}</div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{{ admin: 'Egasi', manager: 'Boshqaruvchi', cashier: 'Kassir', accountant: 'Hisobchi', production: 'Ishlab chiqarish', warehouse: 'Omborchi' }[role] || role}</div>
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
      <aside className={`odina-sidebar relative hidden lg:flex shrink-0 flex-col bg-sidebar border-r border-sidebar-border h-dvh sticky top-0 transition-[width] duration-200 ${collapsed ? 'w-20' : 'w-64'}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Menyuni ochish' : 'Menyuni yopish'}
          title={collapsed ? 'Menyuni ochish' : 'Menyuni yopish'}
          className="odina-sidebar-toggle absolute -right-5 top-6 z-20 w-11 h-11 rounded-full border border-sidebar-border bg-card text-foreground/70 shadow-md flex items-center justify-center hover:bg-primary hover:text-primary-foreground transition-colors touch-manipulation"
        >
          {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
        </button>
        {content}
      </aside>
      <Sheet open={mobileOpen} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="left" className="odina-sidebar-sheet w-72 max-w-[calc(100%-2rem)] p-0 bg-sidebar">
          <SheetTitle className="sr-only">Odina Cake menyusi</SheetTitle>
          <SheetDescription className="sr-only">Kerakli bo‘limni tanlang.</SheetDescription>
          {content}
        </SheetContent>
      </Sheet>
    </>
  );
}