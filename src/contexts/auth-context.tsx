"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { Branch, Staff } from "@/domain/model";
type Auth = {
  user: Staff | null;
  branches: Branch[];
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchBranch: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
};
const Context = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Staff | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/auth", { cache: "no-store" });
      const data = await response.json();
      setUser(response.ok ? data.user : null);
      setBranches(response.ok ? data.branches : []);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh().catch(() => setLoading(false));
  }, [refresh]);
  async function login(username: string, password: string) {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    await refresh();
  }
  async function logout() {
    const response = await fetch("/api/auth", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error("Could not sign out. Please try again.");
    setUser(null);
    setBranches([]);
    window.location.assign("/login");
  }
  async function switchBranch(branchId: string) {
    const response = await fetch("/api/branch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branchId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    window.location.assign("/dashboard");
  }
  return (
    <Context.Provider
      value={{ user, branches, loading, login, logout, switchBranch, refresh }}
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
