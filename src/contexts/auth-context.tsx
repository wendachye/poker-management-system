"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { Branch, Staff } from "@/domain/model";
import { useRouter } from "next/navigation";
import { managementJson } from "@/lib/management-request";
import { ManagementResponseError } from "@/lib/management-response";
import { authReceipt, okReceipt } from "@/lib/management-contracts";
import { prototypeEnabled } from "@/prototype/config";
import {
  clearSignOutIntent,
  readSignOutIntent,
  readSignOutUrlIntent,
  writeSignOutIntent,
  writeSignOutUrlIntent,
} from "@/lib/sign-out-intent";

const signOutFailed = "Could not finish signing out. Please try again.";
const signOutStorageFailed =
  "Your session ended. Allow browser storage and retry to continue.";
const signOutProtectionFailed =
  "Could not save sign-out protection. Keep this page open, allow browser storage and retry signing out.";
type Auth = {
  user: Staff | null;
  branches: Branch[];
  loading: boolean;
  error: string;
  signingOut: boolean;
  signOutBusy: boolean;
  signOutError: string;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchBranch: (id: string) => Promise<void>;
  refresh: () => Promise<Staff | null>;
};
const Context = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<Staff | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const pendingSignOut = useRef(false);
  const signOutInFlight = useRef(false);
  const authEpoch = useRef(0);
  const intentChecked = useRef(prototypeEnabled);
  const lockForSignOut = useCallback(() => {
    pendingSignOut.current = true;
    authEpoch.current++;
    setSigningOut(true);
    setUser(null);
    setBranches([]);
    setError("");
    setLoading(false);
  }, []);
  const hideForRestore = useCallback(() => {
    authEpoch.current++;
    setUser(null);
    setBranches([]);
    setError("");
    setLoading(true);
  }, []);
  const refresh = useCallback(async () => {
    if (!prototypeEnabled && (pendingSignOut.current || !intentChecked.current))
      throw new Error(signOutFailed);
    const epoch = authEpoch.current;
    try {
      const data = authReceipt(
        await managementJson<unknown>("/api/auth", {
          cache: "no-store",
        }),
      );
      if (
        !prototypeEnabled &&
        (pendingSignOut.current || epoch !== authEpoch.current)
      )
        throw new Error(signOutFailed);
      setUser(data.user);
      setBranches(data.branches);
      setError("");
      return data.user;
    } catch (error) {
      if (
        !prototypeEnabled &&
        (pendingSignOut.current || epoch !== authEpoch.current)
      )
        throw new Error(signOutFailed);
      if (error instanceof ManagementResponseError && error.status === 401) {
        setUser(null);
        setBranches([]);
        setError("");
        if (
          !prototypeEnabled &&
          window.location.pathname.split("/")[2] !== "login"
        ) {
          const locale =
            window.location.pathname.split("/")[1] === "zh" ? "zh" : "en";
          // Clear protected records and drafts after confirmed session revocation.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(`/${locale}/login`);
        }
        return null;
      }
      // A temporary service failure does not revoke a previously verified identity.
      setError(
        error instanceof Error ? error.message : "Cannot load staff access.",
      );
      throw error;
    } finally {
      if (
        prototypeEnabled ||
        (!pendingSignOut.current && epoch === authEpoch.current)
      )
        setLoading(false);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    void Promise.resolve()
      .then(() => {
        if (disposed) return;
        if (!prototypeEnabled) {
          intentChecked.current = true;
          if (
            readSignOutUrlIntent(() => window.location.href) ||
            readSignOutIntent(() => window.sessionStorage)
          ) {
            lockForSignOut();
            return;
          }
        }
        return refresh();
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [lockForSignOut, refresh]);
  useEffect(() => {
    if (prototypeEnabled) return;
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // Cached documents may predate a completed sign-out in this tab.
      flushSync(lockForSignOut);
      window.location.reload();
    };
    const hide = (event: PageTransitionEvent) => {
      if (event.persisted) flushSync(hideForRestore);
    };
    window.addEventListener("pageshow", restore);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pageshow", restore);
      window.removeEventListener("pagehide", hide);
    };
  }, [hideForRestore, lockForSignOut]);
  useEffect(() => {
    if (!prototypeEnabled) return;
    let disposed = false;
    let unsubscribe = () => {};
    void import("@/prototype/runtime").then(({ subscribePrototype }) => {
      if (disposed) return;
      unsubscribe = subscribePrototype(() => {
        void refresh().catch(() => {});
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [refresh]);
  async function login(username: string, password: string) {
    if (!prototypeEnabled && (pendingSignOut.current || !intentChecked.current))
      throw new Error(signOutFailed);
    const epoch = authEpoch.current;
    await managementJson<{ user: Staff }>("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (
      !prototypeEnabled &&
      (pendingSignOut.current || epoch !== authEpoch.current)
    )
      throw new Error(signOutFailed);
    const current = await refresh();
    if (
      !prototypeEnabled &&
      (pendingSignOut.current || epoch !== authEpoch.current)
    )
      throw new Error(signOutFailed);
    if (!current) throw new Error("Your session has expired. Sign in again.");
  }
  async function logout() {
    if (prototypeEnabled) {
      const locale =
        window.location.pathname.split("/")[1] === "zh" ? "zh" : "en";
      router.replace(`/${locale}/login`);
      return;
    }
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    lockForSignOut();
    setSignOutBusy(true);
    setSignOutError("");
    const stored = writeSignOutIntent(() => window.sessionStorage);
    const recorded = writeSignOutUrlIntent({
      url: () => window.location.href,
      state: () => window.history.state,
      replaceState: (state, unused, url) =>
        window.history.replaceState(state, unused, url),
    });
    if (!stored && !recorded) setSignOutError(signOutProtectionFailed);
    let confirmed = false;
    let cleared = false;
    try {
      okReceipt(
        await managementJson<unknown>("/api/auth", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      confirmed = true;
      cleared = clearSignOutIntent(() => window.sessionStorage);
      if (!cleared) throw new Error(signOutStorageFailed);
      const locale =
        window.location.pathname.split("/")[1] === "zh" ? "zh" : "en";
      // Retain this document's privacy barrier through navigation and Back.
      window.location.replace(`/${locale}/login`);
    } catch {
      const message =
        confirmed && !cleared
          ? signOutStorageFailed
          : !stored && !recorded
            ? signOutProtectionFailed
            : signOutFailed;
      setSignOutError(message);
      throw new Error(message);
    } finally {
      signOutInFlight.current = false;
      setSignOutBusy(false);
    }
  }
  async function switchBranch(branchId: string) {
    if (!prototypeEnabled && (pendingSignOut.current || !intentChecked.current))
      throw new Error(signOutFailed);
    const epoch = authEpoch.current;
    okReceipt(
      await managementJson<unknown>("/api/branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId }),
      }),
    );
    if (
      !prototypeEnabled &&
      (pendingSignOut.current || epoch !== authEpoch.current)
    )
      throw new Error(signOutFailed);
    if (prototypeEnabled) {
      await refresh();
      const locale =
        window.location.pathname.split("/")[1] === "zh" ? "zh" : "en";
      router.replace(`/${locale}/dashboard`);
      return;
    }
    // A location switch must discard the previous venue's cached data and drafts.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/dashboard");
  }
  return (
    <Context.Provider
      value={{
        user,
        branches,
        loading,
        error,
        signingOut,
        signOutBusy,
        signOutError,
        login,
        logout,
        switchBranch,
        refresh,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAuth() {
  const context = useContext(Context);
  if (!context) throw new Error("AuthProvider missing");
  return context;
}
