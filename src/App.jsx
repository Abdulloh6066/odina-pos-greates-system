import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Outlet } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import RoleRoute from '@/components/RoleRoute';
// Auth pages
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
// App pages
import Layout from '@/components/Layout';
import Dashboard from '@/pages/Dashboard';
import POS from '@/pages/POS';
import Products from '@/pages/Products';
import Categories from '@/pages/Categories';
import Users from '@/pages/Users';
import Reports from '@/pages/Reports';
import DiscountCodes from '@/pages/DiscountCodes';
import Settings from '@/pages/Settings';
import SalesHistory from '@/pages/SalesHistory';
import Shifts from '@/pages/Shifts';
import CashOutHistory from '@/pages/CashOutHistory';
import CashRecipients from '@/pages/CashRecipients';
import Warehouse from '@/pages/Warehouse';
import Waste from '@/pages/Waste';
import Budget from '@/pages/Budget';

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
        <Router>
          <ScrollToTop />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route element={<AuthGate />}>
              <Route element={<Layout />}>
                <Route path="/" element={<RoleRoute pageKey="dashboard"><Dashboard /></RoleRoute>} />
                <Route path="/pos" element={<RoleRoute pageKey="pos"><POS /></RoleRoute>} />
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
              </Route>
            </Route>
            <Route path="*" element={<PageNotFound />} />
          </Routes>
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App