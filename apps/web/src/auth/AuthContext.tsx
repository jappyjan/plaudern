import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { AuthStatusDto, AuthUserDto } from '@plaudern/contracts';
import { UNAUTHORIZED_EVENT } from '../lib/api';
import { getAuthStatus, getMe, logout as apiLogout } from '../lib/auth';

interface AuthContextValue {
  /** True until the initial "who am I?" probe resolves. */
  loading: boolean;
  user: AuthUserDto | null;
  status: AuthStatusDto | null;
  /** Re-probe the session (after login/registration). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AuthUserDto | null>(null);
  const [status, setStatus] = useState<AuthStatusDto | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [me, authStatus] = await Promise.all([getMe(), getAuthStatus()]);
      setUser(me);
      setStatus(authStatus);
    } catch {
      // API unreachable — leave user as-is; the pages surface their own errors.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any API call answering 401 means the session expired server-side.
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ loading, user, status, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
