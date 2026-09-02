import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { canAccess, ROLE_HOME } from '@/lib/pos';

export default function RoleRoute({ pageKey, children }) {
  const { user } = useAuth();
  if (!user || !canAccess(user.role, pageKey)) {
    return <Navigate to={ROLE_HOME[user?.role] || '/pos'} replace />;
  }
  return children;
}
