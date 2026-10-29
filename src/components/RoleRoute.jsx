import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { canAccess, ROLE_HOME } from '@/lib/pos';

export default function RoleRoute({ pageKey, children }) {
  const { user, offlineSession } = useAuth();
  if (offlineSession && pageKey !== 'pos') return <Navigate to="/pos" replace />;
  if (user?.role === 'manager' && (!user.shop_id || user.active === false)) {
    return <div className="p-8 text-center text-muted-foreground">Boshqaruvchiga faol ish joyi biriktirilishi kerak. Administrator bilan bog‘laning: @Abdulloh1100.</div>;
  }
  if (!user || !canAccess(user.role, pageKey)) {
    return <Navigate to={ROLE_HOME[user?.role] || '/pos'} replace />;
  }
  return children;
}