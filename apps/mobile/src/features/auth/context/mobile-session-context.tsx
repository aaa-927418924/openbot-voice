import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { mobileAnalytics } from "@/features/analytics/mobile-analytics";
import {
  type MobileProfileChange,
  type MobileSession,
  MobileSessionExpiredError,
} from "@/features/auth/api/mobile-auth";
import {
  createEphemeralLocalMobileProfile,
  readLocalMobileProfile,
  updateLocalMobileProfile,
} from "@/features/auth/model/local-mobile-profile";
import { queryClient } from "@/shared/lib/query-client";

interface MobileSessionContextValue {
  loading: boolean;
  session: MobileSession | null;
  sessionScope: number;
  refreshProfile: () => Promise<void>;
  handleSessionError: (error: unknown, initiatingSession: MobileSession) => void;
  connect: (session: MobileSession) => void;
  signOut: () => Promise<void>;
  updateProfile: (change: MobileProfileChange) => Promise<void>;
}

const MobileSessionContext = createContext<MobileSessionContextValue | null>(null);

export function MobileSessionProvider({ children }: PropsWithChildren) {
  // The device profile only supplies account presentation. It must not block the workspace while
  // the native file system hydrates it, so start with an in-memory profile and replace it on success.
  const [sessionState, setSessionState] = useState<MobileSession | null>(() => createEphemeralLocalMobileProfile());
  const sessionRef = useRef<MobileSession | null>(sessionState);
  const sessionScope = useRef(0);
  const refreshProfile = useCallback(async () => undefined, []);

  const setCurrentSession = useCallback((session: MobileSession | null) => {
    if (sessionRef.current?.sessionToken !== session?.sessionToken || sessionRef.current?.apiUrl !== session?.apiUrl) {
      sessionScope.current += 1;
      queryClient.removeQueries({ queryKey: ["account-sessions"] });
    }
    mobileAnalytics.setUser(null);
    sessionRef.current = session;
    setSessionState(session);
  }, []);

  const handleSessionError = useCallback((_error: unknown, _initiatingSession: MobileSession) => undefined, []);

  useEffect(() => {
    let active = true;
    const scope = sessionScope.current;
    mobileAnalytics.setEnabled(false);
    void readLocalMobileProfile()
      .then((stored) => {
        if (active && scope === sessionScope.current) setCurrentSession(stored);
      })
      .catch(() => {
        // Keep the in-memory profile active without replacing a damaged file or blocking app startup.
      });
    return () => {
      active = false;
    };
  }, [setCurrentSession]);

  const signOut = useCallback(async () => undefined, []);

  const updateProfile = useCallback(
    async (change: MobileProfileChange) => {
      const current = sessionRef.current;
      if (!current) throw new MobileSessionExpiredError();
      if (!current.localOnly) throw new Error("Account profiles are disabled in local-only mode.");
      setCurrentSession(await updateLocalMobileProfile(current, change));
    },
    [setCurrentSession],
  );

  const value = useMemo<MobileSessionContextValue>(
    () => ({
      loading: false,
      session: sessionState,
      sessionScope: sessionScope.current,
      refreshProfile,
      handleSessionError,
      connect: (next) => {
        if (!next.localOnly) throw new Error("Account sign-in is disabled in local-only mode.");
        setCurrentSession(next);
      },
      signOut,
      updateProfile,
    }),
    [sessionState, setCurrentSession, signOut, updateProfile, handleSessionError, refreshProfile],
  );

  return <MobileSessionContext.Provider value={value}>{children}</MobileSessionContext.Provider>;
}

export function useMobileSession(): MobileSessionContextValue {
  const value = useContext(MobileSessionContext);
  if (!value) throw new Error("useMobileSession must be used within MobileSessionProvider.");
  return value;
}
