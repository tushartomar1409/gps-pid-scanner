import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../api/auth.js';
import { setUnauthorizedHandler } from '../api/client.js';
import { clearToken, getToken, setToken } from './session.js';

const AuthContext = createContext(null);

/** status: 'loading' (restoring session) | 'authenticated' | 'anonymous' */
export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(() => (getToken() ? 'loading' : 'anonymous'));

  // Restore the session on app load.
  useEffect(() => {
    if (!getToken()) return undefined;
    let cancelled = false;
    authApi
      .profile()
      .then(({ data }) => {
        if (cancelled) return;
        setUser(data);
        setStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        clearToken();
        setUser(null);
        setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Any 401 from the API (expired/revoked token) ends the session.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setStatus('anonymous');
      navigate('/login?expired=1', { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  const login = useCallback(async (email, password) => {
    const { data } = await authApi.login(email, password);
    setToken(data.token);
    setUser(data.user);
    setStatus('authenticated');
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* stateless logout: clear locally even if the call fails */
    }
    clearToken();
    setUser(null);
    setStatus('anonymous');
    navigate('/login', { replace: true });
  }, [navigate]);

  const value = useMemo(() => ({ user, status, login, logout }), [user, status, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
