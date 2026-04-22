"use client";

import { createContext, useContext } from "react";

import {
  type PokerManagementState,
  usePokerManagementState,
} from "./usePokerManagementState";

const PokerManagementContext = createContext<PokerManagementState | null>(null);

export function PokerManagementProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const state = usePokerManagementState();

  return (
    <PokerManagementContext.Provider value={state}>
      {children}
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
