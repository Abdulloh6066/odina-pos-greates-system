import React, { createContext, useState, useContext, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { appParams } from '@/lib/app-params';
import { createAxiosClient } from '@base44/sdk/dist/utils/axios-client';
import { rememberOfflineStaff, readOfflineStaff, clearOfflineRestart, restartRead } from '@/lib/offline-restart';
import { isPosNetworkError } from '@/lib/pos-network';

const AuthContext = createContext();
export const AdminShopScopeContext = createContext(null);

const APP_ROLES = new Set(['admin', 'manager', 'cashier', 'accountant', 'production', 'warehouse']);

const normalizeAppUser = (value) => {
  if (!value) return value;
  const nested = value?.data || {};
  const rootRole = String(value?.role || '');
  const nestedRole = String(nested?.role || '');
  const role = APP_ROLES.has(rootRole)
    ? rootRole
    : (APP_ROLES.has(nestedRole) ? nestedRole : (rootRole || nestedRole));

  return {
    ...value,
    role,
    shop_id: value?.shop_id || nested?.shop_id || '',
    shop_name: value?.shop_name || nested?.shop_name || '',
  };
};

const hydrateAppUser = async (value) => {
  const sessionUser = normalizeAppUser(value);
  if (!sessionUser?.id) return sessionUser;

  try {
    const storedUser = normalizeAppUser(await base44.entities.User.get(sessionUser.id));
    return {
      ...sessionUser,
      full_name: storedUser?.display_name || storedUser?.data?.display_name || storedUser?.full_name || sessionUser.full_name,
      role: storedUser?.role || '',
      shop_id: storedUser?.shop_id || '',
      shop_name: storedUser?.shop_name || '',
      active: storedUser?.active !== false && storedUser?.data?.active !== false,
    };
  } catch (error) {
    console.warn('Stored user profile could not be refreshed.', error);
    throw error;
  }
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [offlineSession, setOfflineSession] = useState(false);

  const restoreOffline = async () => {
    const saved = await readOfflineStaff(appParams.appId);
    if (!saved) return false;
    setUser(saved);
    setOfflineSession(true);
    setIsAuthenticated(false); // Local continuity is not a new authenticated session.
    setAuthError(null);
    setAuthChecked(true);
    setIsLoadingAuth(false);
    setIsLoadingPublicSettings(false);
    return true;
  };

  useEffect(() => {
    if (!offlineSession) return undefined;
    const reconnect = () => { if (navigator.onLine !== false) void checkUserAuth(true); };
    window.addEventListener('online', reconnect);
    window.addEventListener('focus', reconnect);
    return () => { window.removeEventListener('online', reconnect); window.removeEventListener('focus', reconnect); };
  }, [offlineSession]);
  const [appPublicSettings, setAppPublicSettings] = useState(null); // Contains only { id, public_settings }

  useEffect(() => {
    checkAppState();
  }, []);

  const checkAppState = async () => {
    try {
      setIsLoadingPublicSettings(true);
      setAuthError(null);
      if (navigator.onLine === false) {
        if (!(await restoreOffline())) {
          setAuthError({ type: 'offline_unavailable', message: 'Offline kassa tayyor emas yoki seans muddati tugagan. Internetga ulanib, tizimga kiring va Kassani oching.' });
          setIsLoadingAuth(false);
          setIsLoadingPublicSettings(false);
        }
        return;
      }
      
      // First, check app public settings (with token if available)
      // This will tell us if auth is required, user not registered, etc.
      const appClient = createAxiosClient({
        baseURL: `/api/apps/public`,
        headers: {
          'X-App-Id': appParams.appId
        },
        token: appParams.token, // Include token if available
        interceptResponses: true
      });
      
      try {
        const publicSettings = await restartRead(() => appClient.get(`/prod/public-settings/by-id/${appParams.appId}`));
        setAppPublicSettings(publicSettings);
        
        // Always ask Base44 for the current user. Published apps can authenticate
        // with the existing browser session even when there is no token in the URL.
        await checkUserAuth();
        setIsLoadingPublicSettings(false);
      } catch (appError) {
        console.error('App state check failed:', appError);
        if (isPosNetworkError(appError) && await restoreOffline()) return;
        if ([401, 403].includes(Number(appError.status || appError.response?.status))) clearOfflineRestart();
        
        // Handle app-level errors
        if (appError.status === 403 && appError.data?.extra_data?.reason) {
          const reason = appError.data.extra_data.reason;
          if (reason === 'auth_required') {
            setAuthError({
              type: 'auth_required',
              message: 'Authentication required'
            });
          } else if (reason === 'user_not_registered') {
            setAuthError({
              type: 'user_not_registered',
              message: 'User not registered for this app'
            });
          } else {
            setAuthError({
              type: reason,
              message: appError.message
            });
          }
        } else {
          setAuthError({
            type: 'unknown',
            message: appError.message || 'Failed to load app'
          });
        }
        setIsLoadingPublicSettings(false);
        setIsLoadingAuth(false);
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      setAuthError({
        type: 'unknown',
        message: error.message || 'An unexpected error occurred'
      });
      setIsLoadingPublicSettings(false);
      setIsLoadingAuth(false);
    }
  };

  const checkUserAuth = async (background = false) => {
    try {
      // Reconnection must not unmount an in-progress local cart.
      if (!background) setIsLoadingAuth(true);
      if (navigator.onLine === false && await restoreOffline()) return;
      let currentUser = await restartRead(() => base44.auth.me());

      // Taklif qilingan xodim birinchi kirganda Odina ichidagi lavozimi
      // va ish joyini xavfsiz backend orqali avtomatik oladi.
      try {
        const assignmentResponse = await restartRead(() => base44.functions.invoke('staff-invite', { action: 'claim' }));
        const assignment = assignmentResponse?.data || assignmentResponse;
        if (assignment?.applied) {
          currentUser = await base44.auth.me();
        }
      } catch (assignmentError) {
        // Taklif yozuvi bo‘lmagan eski foydalanuvchilar odatdagidek kiraveradi.
        console.warn('Staff assignment check failed:', assignmentError);
      }

      // Server-side self check: the backend ignores caller-supplied emails and
      // verifies only the authenticated account. This prevents public email
      // enumeration while keeping the staff allowlist enforced after auth.
      try {
        const accessResponse = await restartRead(() => base44.functions.invoke('staff-email-check', {}));
        const access = accessResponse?.data || accessResponse;
        if (!access?.allowed) {
          clearOfflineRestart();
          setOfflineSession(false);
          setUser(null);
          setIsAuthenticated(false);
          setAuthError({ type: 'user_not_registered', message: 'Xodim ruxsati yo‘q' });
          setIsLoadingAuth(false);
          setAuthChecked(true);
          return;
        }
      } catch (accessError) {
        console.warn('Staff access verification failed:', accessError);
        if (isPosNetworkError(accessError) && await restoreOffline()) return;
        clearOfflineRestart();
        setOfflineSession(false);
        setUser(null);
        setIsAuthenticated(false);
        setAuthError({ type: 'user_not_registered', message: 'Xodim ruxsatini tekshirib bo‘lmadi' });
        setIsLoadingAuth(false);
        setAuthChecked(true);
        return;
      }

      const hydrated = await restartRead(() => hydrateAppUser(currentUser));
      // O'z-o'zidan ro'yxatdan o'tgan (role="user") yoki lavozimi xodimlarga
      // kirmaydigan hisoblar xodimlar ro'yxatida yo'q — ularga ilova ochilmaydi.
      if (!APP_ROLES.has(hydrated?.role)) {
        clearOfflineRestart();
        setOfflineSession(false);
        setUser(null);
        setIsAuthenticated(false);
        setAuthError({ type: 'user_not_registered', message: 'Xodim lavozimi yo‘q' });
        setIsLoadingAuth(false);
        setAuthChecked(true);
        return;
      }
      // A staff account the owner deactivated must be locked out of the app
      // immediately — backend functions already reject inactive users, but the
      // frontend should not render the app shell for them.
      if (hydrated?.active === false) {
        clearOfflineRestart();
        setOfflineSession(false);
        setUser(null);
        setIsAuthenticated(false);
        setAuthError({ type: 'user_disabled', message: 'Hisob o‘chirilgan' });
        setIsLoadingAuth(false);
        setAuthChecked(true);
        return;
      }
      await rememberOfflineStaff(hydrated, appParams.appId);
      setOfflineSession(false);
      setAuthError(null);
      setUser(hydrated);
      setIsAuthenticated(true);
      setIsLoadingAuth(false);
      setAuthChecked(true);
    } catch (error) {
      console.error('User auth check failed:', error);
      if (isPosNetworkError(error) && await restoreOffline()) return;
      clearOfflineRestart();
      setOfflineSession(false);
      setUser(null);
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      
      // If user auth fails, it might be an expired token
      if ([401, 403].includes(Number(error.status || error.response?.status))) {
        setAuthError({ type: 'auth_required', message: 'Authentication required' });
      } else {
        setAuthError({ type: 'offline_unavailable', message: 'Kassani tiklab bo‘lmadi. Internetga ulanib qayta tekshiring; saqlangan savdolar qurilmada qoladi.' });
      }
    }
  };

  const logout = (shouldRedirect = true) => {
    clearOfflineRestart();
    setOfflineSession(false);
    setUser(null);
    setIsAuthenticated(false);
    
    if (shouldRedirect) {
      // Use the SDK's logout method which handles token cleanup and redirect
      base44.auth.logout(window.location.href);
    } else {
      // Just remove the token without redirect
      base44.auth.logout();
    }
  };

  const navigateToLogin = () => {
    // Use the SDK's redirectToLogin method
    base44.auth.redirectToLogin(window.location.href);
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      offlineSession,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  const adminShopScope = useContext(AdminShopScopeContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return adminShopScope ? { ...context, adminShopScope } : context;
};