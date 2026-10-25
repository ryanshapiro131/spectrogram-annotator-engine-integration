import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { apiJson, getToken, setToken, setUnauthorizedHandler } from '../api';

/*
 * Who is signed in, and whether this server uses sign-in at all.
 *
 * On start it reads GET /auth/config. When sign-in is off (no database or
 * no sign-in method configured) the app runs without accounts: no login
 * page, no projects, and the standalone /audio annotator works as before.
 * When it's on, a stored session token is checked with GET /auth/me.
 *
 * status: 'loading' | 'ready' | 'offline' (server unreachable)
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState('loading');
  const [config, setConfig] = useState({ auth_enabled: false, google_client_id: '', dev_login: false });
  const [user, setUser] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let cfg;
      try {
        cfg = await apiJson('/auth/config', { redirectOn401: false });
      } catch {
        if (!cancelled) setStatus('offline');
        return;
      }
      if (cancelled) return;
      setConfig(cfg);
      if (cfg.auth_enabled && getToken()) {
        try {
          const me = await apiJson('/auth/me', { redirectOn401: false });
          if (!cancelled) setUser(me.user);
        } catch (err) {
          if (err.status === 401) setToken(null);
        }
      }
      if (!cancelled) setStatus('ready');
    })();
    return () => { cancelled = true; };
  }, []);

  // A 401 from any API call: the session is gone, so back to the login page,
  // remembering where the user was.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      const here = window.location.pathname + window.location.search;
      if (!window.location.pathname.startsWith('/login')) {
        navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  // The reply of /auth/google or /auth/dev.
  const signIn = useCallback(({ token, user: u }) => {
    setToken(token);
    setUser(u);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    navigate('/login', { replace: true });
    // Google remembers the account choice for its one-tap prompt; harmless if not loaded.
    window.google?.accounts?.id?.disableAutoSelect?.();
  }, [navigate]);

  const value = useMemo(() => ({
    status,
    config,
    authEnabled: status === 'ready' && config.auth_enabled,
    user,
    signIn,
    signOut,
  }), [status, config, user, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

// Wraps pages that need a signed-in user when sign-in is on.
export function RequireAuth({ children }) {
  const { status, authEnabled, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div className="page-loading">Loading…</div>;
  if (authEnabled && !user) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}
