"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { Branch, Staff } from "@/domain/model";
import { useRouter } from "next/navigation";
import { managementJson } from "@/lib/management-request";
import { ManagementResponseError } from "@/lib/management-response";
import { authReceipt, okReceipt } from "@/lib/management-contracts";
import { prototypeEnabled } from "@/prototype/config";
type Auth = {
  user: Staff | null;
  branches: Branch[];
  loading: boolean;
  error: string;
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
  const refresh = useCallback(async () => {
    try {
      const data = authReceipt(
        await managementJson<unknown>("/api/auth", {
          cache: "no-store",
        }),
      );
      setUser(data.user);
      setBranches(data.branches);
      setError("");
      return data.user;
    } catch (error) {
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
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve()
      .then(refresh)
      .catch(() => {});
  }, [refresh]);
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
    await managementJson<{ user: Staff }>("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!(await refresh()))
      throw new Error("Your session has expired. Sign in again.");
  }
  async function logout() {
    if (prototypeEnabled) {
      const locale =
        window.location.pathname.split("/")[1] === "zh" ? "zh" : "en";
      router.replace(`/${locale}/login`);
      return;
    }
    okReceipt(
      await managementJson<unknown>("/api/auth", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    setUser(null);
    setBranches([]);
    // Clear protected in-memory records and drafts when signing out.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }
  async function switchBranch(branchId: string) {
    okReceipt(
      await managementJson<unknown>("/api/branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId }),
      }),
    );
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
