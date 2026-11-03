"use client";

import { createContext, useContext } from "react";
import { useAuth } from "@/contexts/auth-context";
import { ClosingTaskProvider } from "./components/closing-task";

import {
  type PokerManagementState,
  usePokerManagementState,
} from "./usePokerManagementState";

export const PokerManagementContext =
  createContext<PokerManagementState | null>(null);

export function PokerManagementProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const state = usePokerManagementState();
  const auth = useAuth();

  return (
    <PokerManagementContext.Provider value={state}>
      <ClosingTaskProvider
        scope={auth.error || auth.loading ? null : state.closingScope}
      >
        {children}
      </ClosingTaskProvider>
    </PokerManagementContext.Provider>
  );
}

export function usePokerManagementContext() {
  const context = useContext(PokerManagementContext);

  if (!context) {
    throw new Error(
      "usePokerManagementContext must be used within PokerManagementProvider",
    );
  }

  return context;
}
