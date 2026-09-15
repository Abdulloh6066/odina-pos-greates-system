import React, { createContext, useState, useContext, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { appParams } from '@/lib/app-params';
import { createAxiosClient } from '@base44/sdk/dist/utils/axios-client';

const AuthContext = createContext();

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
      role: APP_ROLES.has(storedUser?.role) ? storedUser.role : sessionUser.role,
      shop_id: storedUser?.shop_id || sessionUser.shop_id || '',
      shop_name: storedUser?.shop_name || sessionUser.shop_name || '',
      active: storedUser?.active ?? sessionUser.active,
    };
  } catch (error) {
    console.warn('Stored user profile could not be refreshed; session profile will be used.', error);
    return sessionUser;
  }
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [appPublicSettings, setAppPublicSettings] = useState(null); // Contains only { id, public_settings }

  useEffect(() => {
    checkAppState();
  }, []);

  const checkAppState = async () => {
    try {
      setIsLoadingPublicSettings(true);
      setAuthError(null);
      
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
        const publicSettings = await appClient.get(`/prod/public-settings/by-id/${appParams.appId}`);
        setAppPublicSettings(publicSettings);
        
        // Always ask Base44 for the current user. Published apps can authenticate
        // with the existing browser session even when there is no token in the URL.
        await checkUserAuth();
        setIsLoadingPublicSettings(false);
      } catch (appError) {
        console.error('App state check failed:', appError);
        
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

  const checkUserAuth = async () => {
    try {
      // Now check if the user is authenticated
      setIsLoadingAuth(true);
      let currentUser = await base44.auth.me();

      // Taklif qilingan xodim birinchi kirganda Odina ichidagi lavozimi
      // va ish joyini xavfsiz backend orqali avtomatik oladi.
      try {
        const assignmentResponse = await base44.functions.invoke('staff-invite', { action: 'claim' });
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
        const accessResponse = await base44.functions.invoke('staff-email-check', {});
        const access = accessResponse?.data || accessResponse;
        if (!access?.allowed) {
          setUser(null);
          setIsAuthenticated(false);
          setAuthError({ type: 'user_not_registered', message: 'Xodim ruxsati yo‘q' });
          setIsLoadingAuth(false);
          setAuthChecked(true);
          return;
        }
      } catch (accessError) {
        console.warn('Staff access verification failed:', accessError);
        setUser(null);
        setIsAuthenticated(false);
        setAuthError({ type: 'user_not_registered', message: 'Xodim ruxsatini tekshirib bo‘lmadi' });
        setIsLoadingAuth(false);
        setAuthChecked(true);
        return;
      }

      const hydrated = await hydrateAppUser(currentUser);
      // O'z-o'zidan ro'yxatdan o'tgan (role="user") yoki lavozimi xodimlarga
      // kirmaydigan hisoblar xodimlar ro'yxatida yo'q — ularga ilova ochilmaydi.
      if (!APP_ROLES.has(hydrated?.role)) {
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
        setUser(null);
        setIsAuthenticated(false);
        setAuthError({ type: 'user_disabled', message: 'Hisob o‘chirilgan' });
        setIsLoadingAuth(false);
        setAuthChecked(true);
        return;
      }
      setUser(hydrated);
      setIsAuthenticated(true);
      setIsLoadingAuth(false);
      setAuthChecked(true);
    } catch (error) {
      console.error('User auth check failed:', error);
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      
      // If user auth fails, it might be an expired token
      if (error.status === 401 || error.status === 403) {
        setAuthError({
          type: 'auth_required',
          message: 'Authentication required'
        });
      }
    }
  };

  const logout = (shouldRedirect = true) => {
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
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};