import { canAccess } from './pos.js';

// Share the exact same lazy loaders between React routes and navigation preloading.
// Preloading downloads code only: it never fetches or modifies business records.
export const PAGE_LOADERS = {
  admin: () => import('@/pages/AdminPanel'),
  dashboard: () => import('@/pages/Dashboard'),
  pos: () => import('@/pages/POS'),
  orders: () => import('@/pages/Orders'),
  tables: () => import('@/pages/RestaurantTables'),
  customers: () => import('@/pages/Customers'),
  products: () => import('@/pages/Products'),
  categories: () => import('@/pages/Categories'),
  users: () => import('@/pages/Users'),
  reports: () => import('@/pages/Reports'),
  discounts: () => import('@/pages/DiscountCodes'),
  settings: () => import('@/pages/Settings'),
  sales: () => import('@/pages/SalesHistory'),
  shifts: () => import('@/pages/Shifts'),
  cashouts: () => import('@/pages/CashOutHistory'),
  recipients: () => import('@/pages/CashRecipients'),
  warehouse: () => import('@/pages/Warehouse'),
  waste: () => import('@/pages/Waste'),
  budget: () => import('@/pages/Budget'),
  screens: () => import('@/pages/ProductionScreen'),
  profit: () => import('@/pages/ProfitReport'),
  audit: () => import('@/pages/AuditExport'),
  security: () => import('@/pages/Security'),
  dailyexport: () => import('@/pages/DailyExport'),
};

const ROUTE_KEYS = {
  '/admin': 'admin',
  '/': 'dashboard',
  '/pos': 'pos',
  '/orders': 'orders',
  '/tables': 'tables',
  '/customers': 'customers',
  '/products': 'products',
  '/3d-plus': 'products',
  '/categories': 'categories',
  '/users': 'users',
  '/reports': 'reports',
  '/discounts': 'discounts',
  '/settings': 'settings',
  '/sales': 'sales',
  '/shifts': 'shifts',
  '/cash-outs': 'cashouts',
  '/cash-recipients': 'recipients',
  '/warehouse': 'warehouse',
  '/waste': 'waste',
  '/budget': 'budget',
  '/production-screen': 'screens',
  '/profit': 'profit',
  '/audit': 'audit',
  '/security': 'security',
  '/daily-export': 'dailyexport',
};

const inFlight = new Map();

export function getPreloadKey(path, role) {
  const pathname = String(path || '').split(/[?#]/, 1)[0];
  const key = ROUTE_KEYS[pathname];
  return key && canAccess(role, key) ? key : null;
}

export function preloadPage(key) {
  const loader = PAGE_LOADERS[key];
  if (!loader) return Promise.resolve(null);
  if (!inFlight.has(key)) {
    const promise = loader().catch((error) => {
      inFlight.delete(key);
      throw error;
    });
    inFlight.set(key, promise);
  }
  return inFlight.get(key);
}

export function preloadRoute(path, role) {
  const key = getPreloadKey(path, role);
  return key ? preloadPage(key) : Promise.resolve(null);
}

// Only warm a handful of likely destinations after the browser becomes idle.
// In particular, do not eagerly download the large Reports bundle or all pages.
const LIKELY_ROUTES = {
  admin: ['/pos', '/tables', '/warehouse', '/users', '/security'],
  manager: ['/warehouse', '/customers', '/sales'],
  cashier: ['/orders', '/tables', '/warehouse', '/sales'],
  accountant: ['/products', '/warehouse', '/sales'],
  production: ['/warehouse', '/products'],
  warehouse: [],
};

export function likelyRoutesForRole(role) {
  return (LIKELY_ROUTES[role] || []).filter((path) => getPreloadKey(path, role));
}
