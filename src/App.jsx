import { lazy, Suspense, useEffect } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Outlet, useLocation } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import OdinaDialogProvider from '@/components/ui/odina-dialog-provider';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import RoleRoute from '@/components/RoleRoute';
// Auth pages
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
// App shell stays eager; feature pages load only when their route is opened.
import Layout from '@/components/Layout';
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const POS = lazy(() => import('@/pages/POS'));
const Orders = lazy(() => import('@/pages/Orders'));
const Customers = lazy(() => import('@/pages/Customers'));
const Products = lazy(() => import('@/pages/Products'));
const Categories = lazy(() => import('@/pages/Categories'));
const Users = lazy(() => import('@/pages/Users'));
const Reports = lazy(() => import('@/pages/Reports'));
const DiscountCodes = lazy(() => import('@/pages/DiscountCodes'));
const Settings = lazy(() => import('@/pages/Settings'));
const SalesHistory = lazy(() => import('@/pages/SalesHistory'));
const Shifts = lazy(() => import('@/pages/Shifts'));
const CashOutHistory = lazy(() => import('@/pages/CashOutHistory'));
const CashRecipients = lazy(() => import('@/pages/CashRecipients'));
const Warehouse = lazy(() => import('@/pages/Warehouse'));
const Waste = lazy(() => import('@/pages/Waste'));
const Budget = lazy(() => import('@/pages/Budget'));
const ProductionScreen = lazy(() => import('@/pages/ProductionScreen'));
const ProfitReport = lazy(() => import('@/pages/ProfitReport'));
const AuditExport = lazy(() => import('@/pages/AuditExport'));
const Security = lazy(() => import('@/pages/Security'));
const DailyExport = lazy(() => import('@/pages/DailyExport'));

const ROUTE_TITLES = {
  '/': 'Bosh sahifa',
  '/login': 'Kirish',
  '/register': 'Ro‘yxatdan o‘tish',
  '/forgot-password': 'Parolni tiklash',
  '/reset-password': 'Yangi parol',
  '/pos': 'Kassa',
  '/orders': 'Buyurtmalar',
  '/customers': 'Mijozlar',
  '/products': 'Mahsulotlar',
  '/categories': 'Kategoriyalar',
  '/users': 'Xodimlar',
  '/reports': 'Hisobotlar',
  '/discounts': 'Chegirmalar',
  '/settings': 'Sozlamalar',
  '/sales': 'Savdolar tarixi',
  '/shifts': 'Smenalar',
  '/cash-outs': 'Kassadan pul olish',
  '/cash-recipients': 'Qabul qiluvchilar',
  '/warehouse': 'Ombor',
  '/waste': 'Chiqitlar',
  '/budget': 'Budjet',
  '/production-screen': 'Ishlab chiqarish',
  '/profit': 'Tannarx va foyda',
  '/audit': 'Nazorat va eksport',
  '/security': 'Xavfsizlik',
  '/daily-export': 'Kunlik eksport',
};

function RouteTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    const pageTitle = ROUTE_TITLES[pathname];
    document.title = pageTitle ? `${pageTitle} · Odina POS` : 'Odina POS';
  }, [pathname]);
  return null;
}

const AuthGate = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-secondary border-t-primary rounded-full animate-spin"></div>
      </div>
    );
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'user_disabled') {
      return (
        <div className="fixed inset-0 flex items-center justify-center p-6">
          <div className="odina-panel rounded-2xl bg-card border border-border premium-shadow-lg p-6 max-w-sm text-center space-y-3">
            <h2 className="font-display text-xl font-bold">Hisob o‘chirilgan</h2>
            <p className="text-sm text-muted-foreground">Tizimga kirish vaqtincha to‘xtatilgan. Administrator bilan bog‘laning.</p>
            <button onClick={() => navigateToLogin()} className="odina-button odina-button-primary inline-flex items-center justify-center rounded-xl px-4 h-11 text-sm font-semibold">
              Tizimdan chiqish
            </button>
          </div>
        </div>
      );
    } else if (authError.type === 'auth_required') {
      navigateToLogin();
      return null;
    }
  }

  return <Outlet />;
};

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <OdinaDialogProvider>
        <Router>
          <RouteTitle />
          <ScrollToTop />
          <Suspense fallback={<div className="fixed inset-0 flex items-center justify-center"><div className="w-8 h-8 border-4 border-secondary border-t-primary rounded-full animate-spin" /></div>}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route element={<AuthGate />}>
              <Route path="/production-screen" element={<RoleRoute pageKey="screens"><ProductionScreen /></RoleRoute>} />
              <Route element={<Layout />}>
                <Route path="/" element={<RoleRoute pageKey="dashboard"><Dashboard /></RoleRoute>} />
                <Route path="/pos" element={<RoleRoute pageKey="pos"><POS /></RoleRoute>} />
                <Route path="/orders" element={<RoleRoute pageKey="orders"><Orders /></RoleRoute>} />
                <Route path="/customers" element={<RoleRoute pageKey="customers"><Customers /></RoleRoute>} />
                <Route path="/products" element={<RoleRoute pageKey="products"><Products /></RoleRoute>} />
                <Route path="/categories" element={<RoleRoute pageKey="categories"><Categories /></RoleRoute>} />
                <Route path="/users" element={<RoleRoute pageKey="users"><Users /></RoleRoute>} />
                <Route path="/reports" element={<RoleRoute pageKey="reports"><Reports /></RoleRoute>} />
                <Route path="/discounts" element={<RoleRoute pageKey="discounts"><DiscountCodes /></RoleRoute>} />
                <Route path="/settings" element={<RoleRoute pageKey="settings"><Settings /></RoleRoute>} />
                <Route path="/sales" element={<RoleRoute pageKey="sales"><SalesHistory /></RoleRoute>} />
                <Route path="/shifts" element={<RoleRoute pageKey="shifts"><Shifts /></RoleRoute>} />
                <Route path="/cash-outs" element={<RoleRoute pageKey="cashouts"><CashOutHistory /></RoleRoute>} />
                <Route path="/cash-recipients" element={<RoleRoute pageKey="recipients"><CashRecipients /></RoleRoute>} />
                <Route path="/warehouse" element={<RoleRoute pageKey="warehouse"><Warehouse /></RoleRoute>} />
                <Route path="/waste" element={<RoleRoute pageKey="waste"><Waste /></RoleRoute>} />
                <Route path="/budget" element={<RoleRoute pageKey="budget"><Budget /></RoleRoute>} />
                <Route path="/profit" element={<RoleRoute pageKey="profit"><ProfitReport /></RoleRoute>} />
                <Route path="/audit" element={<RoleRoute pageKey="audit"><AuditExport /></RoleRoute>} />
                <Route path="/security" element={<RoleRoute pageKey="security"><Security /></RoleRoute>} />
                <Route path="/daily-export" element={<RoleRoute pageKey="dailyexport"><DailyExport /></RoleRoute>} />
              </Route>
            </Route>
            <Route path="*" element={<PageNotFound />} />
          </Routes>
          </Suspense>
        </Router>
        <Toaster />
        </OdinaDialogProvider>
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App