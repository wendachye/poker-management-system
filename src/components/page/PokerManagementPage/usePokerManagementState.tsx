"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { toast } from "sonner";
import { useLocale, useMessages } from "next-intl";
import { managementRequest } from "@/lib/management-request";
import { prototypeEnabled } from "@/prototype/config";
import type { Command } from "@/domain/commands";
import type { StaffCommand } from "@/domain/staff";
import type { LocationCommand } from "@/domain/locations";
import type { EntryType, Snapshot } from "@/domain/model";
import {
  currentDay,
  emptyStore,
  playersForDay,
  tablesForDay,
  totalsForDay,
} from "@/domain/selectors";
export type Operation =
  | {
      kind: "transaction";
      type?: EntryType;
      playerId?: string;
      tableId?: string;
    }
  | { kind: "check-in"; playerId?: string; tableId?: string; seat?: number }
  | { kind: "move"; playerId?: string; tableId?: string; seat?: number }
  | { kind: "player"; playerId: string }
  | { kind: "edit-player"; playerId: string };
export function usePokerManagementState() {
  const { user, refresh: refreshAuth } = useAuth();
  const locale = useLocale();
  const messages = useMessages() as { ui?: Record<string, string> };
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryRequired, setRetryRequired] = useState(false);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [operation, setOperation] = useState<Operation | null>(null);
  const inFlight = useRef(false);
  const latestRevision = useRef(-1);
  const activeBranch = useRef<string | null>(null);
  const uncertain = useRef<{
    fingerprint: string;
    payload: string;
    endpoint: string;
  } | null>(null);
  const accept = useCallback((next: Snapshot) => {
    if (activeBranch.current && activeBranch.current !== next.branch.id) {
      if (!prototypeEnabled) {
        window.location.reload();
        return;
      }
      latestRevision.current = -1;
      setDrafts({});
      setOperation(null);
    }
    activeBranch.current = next.branch.id;
    if (next.revision >= latestRevision.current) {
      latestRevision.current = next.revision;
      setSnapshot(next);
    }
  }, []);
  const refresh = useCallback(async () => {
    try {
      const response = await managementRequest("/api/state", {
        cache: "no-store",
      });
      const data = await response.json();
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) throw new Error(data.error);
      accept(data);
      setRefreshError("");
      setNow(Date.now());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Cannot load branch records.";
      setError(message);
      setRefreshError(message);
    }
  }, [accept]);
  useEffect(() => {
    if (!prototypeEnabled) return;
    let disposed = false;
    let unsubscribe = () => {};
    void import("@/prototype/runtime").then((runtime) => {
      if (disposed) return;
      let generation = runtime.getPrototypeInfo().generation;
      unsubscribe = runtime.subscribePrototype(() => {
        const next = runtime.getPrototypeInfo();
        if (generation !== next.generation) {
          generation = next.generation;
          latestRevision.current = -1;
          activeBranch.current = null;
          uncertain.current = null;
          setRetryRequired(false);
          setDrafts({});
          setOperation(null);
          setError("");
          setNotice("");
        }
        if (!inFlight.current) void refresh();
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [refresh]);
  useEffect(() => {
    if (!user) return;
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!document.hidden && !inFlight.current) void refresh();
    }, 15000);
    const focus = () => {
      if (!inFlight.current) void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [user, refresh]);
  async function submit(
    command: Command | StaffCommand | LocationCommand,
    endpoint = "/api/state",
  ) {
    if (!snapshot || inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const fingerprint = JSON.stringify(command);
      if (
        uncertain.current &&
        (uncertain.current.fingerprint !== fingerprint ||
          uncertain.current.endpoint !== endpoint)
      )
        throw new Error(
          "Retry the previous request before submitting a different operation.",
        );
      const payload =
        uncertain.current?.payload ??
        JSON.stringify({
          branchId: snapshot.branch.id,
          operationId: crypto.randomUUID(),
          revision: snapshot.revision,
          command,
        });
      uncertain.current = { fingerprint, payload, endpoint };
      const response = await managementRequest(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const data = await response.json();
      if (response.status === 401) {
        window.location.assign("/login");
        return false;
      }
      if (!response.ok) {
        if (response.status < 500) uncertain.current = null;
        if (response.status === 409) await refresh();
        throw new Error(data.error);
      }
      uncertain.current = null;
      accept(data);
      if (
        command.kind === "UPDATE_SETTINGS" ||
        command.kind === "CREATE_LOCATION"
      ) {
        // The mutation is already committed; a failed navigation refresh must not report a failed save.
        try {
          await refreshAuth();
        } catch {}
      }
      setNow(Date.now());
      setNotice("Saved successfully.");
      const message =
        command.kind === "REQUEST" || command.kind === "CORRECT"
          ? "Request sent for approval."
          : command.kind === "CHECK_IN"
            ? "Player checked in. Use Buy-in to request chips."
            : "Saved successfully.";
      const key = message
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      toast.success(
        locale === "en" ? message : (messages.ui?.[key] ?? message),
      );
      return true;
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The request failed. Refresh records before retrying.",
      );
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
      setRetryRequired(uncertain.current !== null);
    }
  }
  const store = snapshot?.store ?? emptyStore();
  const day = currentDay(store);
  const players = playersForDay(store);
  function draft(key: string, fallback = "") {
    return drafts[key] ?? fallback;
  }
  function setDraft(key: string, value: string) {
    setDrafts((current) => ({ ...current, [key]: value }));
  }
  return {
    operation,
    startOperation: (next: Operation) => {
      setError("");
      setOperation(next);
    },
    closeOperation: () => setOperation(null),
    snapshot,
    store,
    day,
    user: snapshot?.user,
    players,
    tables: tablesForDay(store),
    totals: totalsForDay(store),
    activePlayers: players.filter((player) => player.status === "ACTIVE"),
    pendingApprovals: store.approvals.filter(
      (request) => request.status === "PENDING",
    ),
    busy,
    error,
    refreshError,
    notice,
    now,
    locked: day?.status !== "OPEN",
    submit,
    submitStaff: (command: StaffCommand) => submit(command, "/api/staff"),
    submitLocation: (command: LocationCommand) =>
      submit(command, "/api/locations"),
    refresh,
    setError,
    draft,
    setDraft,
    retryRequired,
    retryLast: () =>
      uncertain.current
        ? submit(
            JSON.parse(uncertain.current.fingerprint) as
              Command | StaffCommand | LocationCommand,
            uncertain.current.endpoint,
          )
        : Promise.resolve(false),
  };
}
export type PokerManagementState = ReturnType<typeof usePokerManagementState>;
