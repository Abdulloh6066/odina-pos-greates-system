import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { canAccess, ROLE_HOME, canUseWholesaleWorkspace } from '@/lib/pos';

export default function RoleRoute({ pageKey, children }) {
  const { user, offlineSession, adminShopScope } = useAuth();
  if (offlineSession && pageKey !== 'pos') return <Navigate to="/pos" replace />;
  if (user?.role === 'manager' && (!user.shop_id || user.active === false)) {
    return <div className="p-8 text-center text-muted-foreground">Boshqaruvchiga faol ish joyi biriktirilishi kerak. Administrator bilan bog‘laning: @Abdulloh1100.</div>;
  }
  if (!user || !canAccess(user.role, pageKey)) {
    return <Navigate to={ROLE_HOME[user?.role] || '/pos'} replace />;
  }
  if (pageKey === 'wholesale') {
    if (user.role === 'admin' && !adminShopScope?.ready) return <p role="status" className="p-8">Ish joyi yuklanmoqda…</p>;
    if (!canUseWholesaleWorkspace(user, adminShopScope)) return <Navigate to={ROLE_HOME[user.role] || '/'} replace />;
  }
  return children;
}