import { base44 } from '@/api/base44Client';
import { uzbekistanDateKey } from './uzbekistan-time.js';

export const PAYMENT_METHODS = [
  { id: 'cash', label: 'Naqd pul', short: 'Naqd pul', group: 'cash' },
  { id: 'bank_card', label: 'Bank card', short: 'Bank card', group: 'card' },
  { id: 'uzcard', label: 'UZCARD', short: 'UZCARD', group: 'card' },
  { id: 'humo', label: 'HUMO', short: 'HUMO', group: 'card' },
  { id: 'online', label: 'Online', short: 'Online', group: 'online' },
];

export const ROLE_MENU = {
  admin: ['dashboard', 'pos', 'orders', 'tables', 'customers', 'waste', 'warehouse', 'products', 'categories', 'reports', 'profit', 'audit', 'security', 'dailyexport', 'discounts', 'sales', 'shifts', 'cashouts', 'recipients', 'budget', 'users', 'settings', 'screens'],
  manager: ['dashboard', 'pos', 'orders', 'tables', 'customers', 'waste', 'warehouse', 'products', 'categories', 'reports', 'discounts', 'sales', 'shifts', 'cashouts', 'recipients'],
  cashier: ['pos', 'orders', 'tables', 'customers', 'waste', 'warehouse', 'sales', 'shifts', 'cashouts'],
  accountant: ['dashboard', 'customers', 'warehouse', 'products', 'categories', 'reports', 'profit', 'dailyexport', 'discounts', 'sales', 'shifts'],
  production: ['warehouse', 'products', 'customers', 'screens'],
  warehouse: ['warehouse'],
};

export const ROLE_HOME = {
  admin: '/',
  manager: '/',
  cashier: '/pos',
  accountant: '/',
  production: '/products',
  warehouse: '/warehouse',
};

export const MENU_ITEMS = [
  { key: 'dashboard', label: 'Bosh sahifa', path: '/', icon: 'LayoutDashboard' },
  { key: 'pos', label: 'Kassa', path: '/pos', icon: 'ShoppingCart' },
  { key: 'orders', label: 'Buyurtmalar', path: '/orders', icon: 'ClipboardList' },
  { key: 'tables', label: 'Stollar', path: '/tables', icon: 'Armchair' },
  { key: 'customers', label: 'Mijozlar', path: '/customers', icon: 'Contact' },
  { key: 'screens', label: 'Ekranlar', path: '/production-screen', icon: 'Monitor' },
  { key: 'waste', label: 'Chiqitlar', path: '/waste', icon: 'Trash2' },
  { key: 'warehouse', label: 'Ombor', path: '/warehouse', icon: 'Ombor' },
  { key: 'products', label: '3D +', path: '/3d-plus', icon: 'Cake' },
  { key: 'categories', label: 'Kategoriyalar', path: '/categories', icon: 'Tags' },
  { key: 'reports', label: 'Hisobotlar', path: '/reports', icon: 'BarChart3' },
  { key: 'profit', label: 'Tannarx va foyda', path: '/profit', icon: 'TrendingUp' },
  { key: 'audit', label: 'Nazorat va eksport', path: '/audit', icon: 'ShieldCheck' },
  { key: 'dailyexport', label: 'Kunlik eksport', path: '/daily-export', icon: 'FileSpreadsheet' },
  { key: 'security', label: 'Xavfsizlik', path: '/security', icon: 'Shield' },
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

export function tashkentDateKey(value = Date.now()) {
  return uzbekistanDateKey(value);
}

export function saleOccurredAt(sale) {
  return sale?.sold_at || sale?.created_date || sale?.created_at || '';
}

export function saleBusinessDate(sale) {
  return sale?.business_date || tashkentDateKey(saleOccurredAt(sale));
}

export function isSameDay(a, b) {
  const first = tashkentDateKey(a);
  return Boolean(first) && first === tashkentDateKey(b);
}