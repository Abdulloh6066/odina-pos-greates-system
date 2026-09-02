import { base44 } from '@/api/base44Client';

export const PAYMENT_METHODS = [
  { id: 'cash', label: 'Cash', short: 'Cash', group: 'cash' },
  { id: 'uzcard', label: 'Uzcard', short: 'Uzcard', group: 'card' },
  { id: 'humo', label: 'Humo', short: 'Humo', group: 'card' },
  { id: 'click', label: 'Click', short: 'Click', group: 'online' },
  { id: 'payme', label: 'Payme', short: 'Payme', group: 'online' },
  { id: 'bank_transfer', label: 'Bank transfer', short: 'Bank', group: 'bank' },
  { id: 'other', label: 'Other online', short: 'Other', group: 'online' },
];

export const ROLE_MENU = {
  admin: ['dashboard', 'pos', 'products', 'categories', 'reports', 'discounts', 'sales', 'shifts', 'users', 'settings'],
  manager: ['dashboard', 'pos', 'products', 'categories', 'reports', 'discounts', 'sales', 'shifts'],
  cashier: ['pos', 'sales', 'shifts'],
};

export const MENU_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', path: '/', icon: 'LayoutDashboard' },
  { key: 'pos', label: 'POS', path: '/pos', icon: 'ShoppingCart' },
  { key: 'products', label: 'Products', path: '/products', icon: 'Cake' },
  { key: 'categories', label: 'Categories', path: '/categories', icon: 'Tags' },
  { key: 'reports', label: 'Reports', path: '/reports', icon: 'BarChart3' },
  { key: 'discounts', label: 'Discount Codes', path: '/discounts', icon: 'Ticket' },
  { key: 'sales', label: 'Sales History', path: '/sales', icon: 'ReceiptText' },
  { key: 'shifts', label: 'Shifts', path: '/shifts', icon: 'Clock' },
  { key: 'users', label: 'Users', path: '/users', icon: 'Users' },
  { key: 'settings', label: 'Settings', path: '/settings', icon: 'Settings' },
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