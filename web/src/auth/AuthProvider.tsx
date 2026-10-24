import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';

export type Role = 'admin' | 'uploader' | 'viewer';
export type CurrentUser = { id: string; email: string; name: string; role: Role };

type StatusResponse = { needsSetup: boolean; authenticated: boolean; user: CurrentUser | null };

type AuthState = {
  loading: boolean;
  needsSetup: boolean;
  user: CurrentUser | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  loading: true,
  needsSetup: false,
  user: null,
  refresh: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ loading: boolean; needsSetup: boolean; user: CurrentUser | null }>({
    loading: true,
    needsSetup: false,
    user: null,
  });

  const refresh = useCallback(async () => {
    try {
      const status = await api<StatusResponse>('/api/auth/status');
      setState({ loading: false, needsSetup: status.needsSetup, user: status.user });
    } catch {
      setState({ loading: false, needsSetup: false, user: null });
    }
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setState((s) => ({ ...s, user: null }));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ ...state, refresh, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
