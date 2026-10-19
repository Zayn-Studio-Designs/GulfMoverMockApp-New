import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Demo workspace mode. This is presentation-layer only — it filters which
 * navigation the interface shows (customer vs ATCO staff). It grants no real
 * permissions: every route remains reachable by URL and the demo banner
 * explains that no real access control exists in this prototype.
 *
 * New sessions start in Customer mode because most demo viewers are being
 * shown the booking experience. The mode is remembered per browser.
 */

export type WorkMode = 'customer' | 'staff';

const KEY = 'gm-demo-workspace';

function loadMode(): WorkMode {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === 'staff' || raw === 'customer' ? raw : 'customer';
  } catch {
    return 'customer';
  }
}

interface WorkModeContextValue {
  mode: WorkMode;
  isCustomer: boolean;
  setMode: (mode: WorkMode) => void;
  toggleMode: () => void;
}

const WorkModeContext = createContext<WorkModeContextValue | undefined>(undefined);

export function WorkModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<WorkMode>(loadMode);

  useEffect(() => {
    try {
      if (mode === 'customer') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch {
      // Storage unavailable: the mode simply resets on next load.
    }
  }, [mode]);

  const setMode = useCallback((next: WorkMode) => setModeState(next), []);
  const toggleMode = useCallback(() => setModeState(m => (m === 'customer' ? 'staff' : 'customer')), []);
  const value = useMemo(() => ({ mode, isCustomer: mode === 'customer', setMode, toggleMode }), [mode, setMode, toggleMode]);
  return <WorkModeContext.Provider value={value}>{children}</WorkModeContext.Provider>;
}

export function useWorkMode(): WorkModeContextValue {
  const ctx = useContext(WorkModeContext);
  if (!ctx) throw new Error('useWorkMode must be used within a WorkModeProvider');
  return ctx;
}
