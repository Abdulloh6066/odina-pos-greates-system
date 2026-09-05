import { base44 } from '@/api/base44Client';

export const PAYMENT_METHODS = [
  { id: 'cash', label: 'Naqd pul', short: 'Naqd pul', group: 'cash' },
  { id: 'uzcard', label: 'Uzcard', short: 'Uzcard', group: 'card' },
  { id: 'humo', label: 'Humo', short: 'Humo', group: 'card' },
  { id: 'click', label: 'Click', short: 'Click', group: 'online' },
  { id: 'payme', label: 'Payme', short: 'Payme', group: 'online' },
  { id: 'bank_transfer', label: 'Bank o‘tkazmasi', short: 'Bank', group: 'bank' },
  { id: 'other', label: 'Boshqa onlayn', short: 'Other', group: 'online' },
];

export const ROLE_MENU = {
  admin: ['dashboard', 'pos', 'warehouse', 'products', 'categories', 'reports', 'discounts', 'sales', 'shifts', 'cashouts', 'recipients', 'budget', 'users', 'settings'],
  cashier: ['pos', 'warehouse', 'sales', 'shifts', 'cashouts'],
  accountant: ['dashboard', 'warehouse', 'products', 'categories', 'reports', 'discounts', 'sales', 'shifts'],
  production: ['warehouse', 'products'],
  warehouse: ['warehouse'],
};

export const ROLE_HOME = {
  admin: '/',
  cashier: '/pos',
  accountant: '/',
  production: '/products',
  warehouse: '/warehouse',
};

export const MENU_ITEMS = [
  { key: 'dashboard', label: 'Bosh sahifa', path: '/', icon: 'LayoutDashboard' },
  { key: 'pos', label: 'Kassa', path: '/pos', icon: 'ShoppingCart' },
  { key: 'warehouse', label: 'Ombor', path: '/warehouse', icon: 'Ombor' },
  { key: 'products', label: 'Mahsulotlar', path: '/products', icon: 'Cake' },
  { key: 'categories', label: 'Kategoriyalar', path: '/categories', icon: 'Tags' },
  { key: 'reports', label: 'Hisobotlar', path: '/reports', icon: 'BarChart3' },
  { key: 'discounts', label: 'Chegirma kodlari', path: '/discounts', icon: 'Ticket' },
  { key: 'sales', label: 'Savdolar tarixi', path: '/sales', icon: 'ReceiptText' },
  { key: 'shifts', label: 'Smenalar', path: '/shifts', icon: 'Clock' },
  { key: 'cashouts', label: 'Kassadan pul olish tarixi', path: '/cash-outs', icon: 'Banknote' },
  { key: 'recipients', label: 'Qabul qiluvchilar', path: '/cash-recipients', icon: 'Building2' },
  { key: 'budget', label: 'Budget', path: '/budget', icon: 'WalletCards' },
  { key: 'users', label: 'Xodimlar', path: '/users', icon: 'Xodimlar' },
  { key: 'settings', label: 'Sozlamalar', path: '/settings', icon: 'Sozlamalar' },
];

export function formatNum(n) {
  return Number(Number(n || 0).toFixed(0)).toLocaleString('en-US').replace(/,/g, ' ');
}

export function formatUZS(n) {
  return formatNum(n) + ' UZS';
}

export function canAccess(role, key) {
  return (ROLE_MENU[role] || []).includes(key);
}

export async function logAction(user, action, details = '') {
  try {
    await base44.entities.ActionHistory.create({
      user_id: user?.id,
      user_name: user?.full_name || user?.email || 'System',
      action,
      details,
    });
  } catch (e) {
    // logging should never break the main flow
  }
}

export function todayISO() {
  return new Date().toISOString();
}

export function isSameDay(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}