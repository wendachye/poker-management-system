"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/contexts/auth-context";
import { toast } from "sonner";
import { useLocale, useMessages } from "next-intl";
import { usePathname } from "@/i18n/navigation";
import { managementJson } from "@/lib/management-request";
import { ManagementResponseError } from "@/lib/management-response";
import { snapshotReceipt } from "@/lib/management-contracts";
import {
  operationRecoveryReceipt,
  operationSnapshotReceipt,
} from "@/lib/operation-recovery";
import {
  clearPendingOperation,
  listPendingOperations,
  PendingOperationStorageError,
  pendingOperation,
  writePendingOperation,
  type PendingOperation,
} from "@/lib/pending-operation";
import { createBackgroundRefresh } from "@/lib/background-refresh";
import { approvalDecisionMessage } from "@/lib/approval-decision-message";
import { prototypeEnabled } from "@/prototype/config";
import { matchesOperationalAccess } from "@/lib/operational-access";
import type { Command, SeatSwapParticipant } from "@/domain/commands";
import type { StaffCommand } from "@/domain/staff";
import type { LocationCommand } from "@/domain/locations";
import type { EntryType, Snapshot } from "@/domain/model";
import type { ReadPage, ReadQuery } from "@/domain/read-model";
import { readPageReceipt, readQueryParams } from "@/lib/read-page";
import {
  checkedInVisit,
  type CheckInContinuation,
} from "./components/check-in-continuation";
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
  | { kind: "swap"; first: SeatSwapParticipant; second: SeatSwapParticipant }
  | { kind: "player"; playerId: string }
  | { kind: "edit-player"; playerId: string };
export function usePokerManagementState() {
  const { user, refresh: refreshAuth } = useAuth();
  const locale = useLocale();
  const pathname = usePathname();
  const messages = useMessages() as { ui?: Record<string, string> };
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryRequired, setRetryRequired] = useState(false);
  const [recoveryCheckpoint, setRecoveryCheckpoint] =
    useState<PendingOperation | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  const [checkpointWriteFailed, setCheckpointWriteFailed] = useState(false);
  const [recoveredResult, setRecoveredResult] = useState<
    "saved" | "cancelled" | null
  >(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [operation, setOperation] = useState<Operation | null>(null);
  const [readGeneration, setReadGeneration] = useState(0);
  const inFlight = useRef(false);
  const latestRevision = useRef(-1);
  const acceptedSnapshot = useRef<Snapshot | null>(null);
  const authenticatedStaff = useRef(user);
  useLayoutEffect(() => {
    authenticatedStaff.current = user;
  }, [user]);
  const activeBranch = useRef<string | null>(null);
  const readFocus = useRef<{
    playerId?: string;
    approvalId?: string;
    receiptId?: string;
  }>({});
  const pageQueries = useRef(new Map<symbol, ReadQuery>());
  const reviewedRevision = useRef<number | undefined>(undefined);
  const operationIntent = useRef<AbortController | null>(null);
  useEffect(() => () => operationIntent.current?.abort(), [pathname]);
  const uncertain = useRef<{
    fingerprint: string;
    payload: string;
    endpoint: string;
    checkpoint?: PendingOperation;
  } | null>(null);
  const synchronizeRecovery = useCallback(() => {
    if (prototypeEnabled || !user) return;
    try {
      const checkpoints = listPendingOperations(window.localStorage, {
        actorId: user.id,
        branchId: user.branchId,
      });
      setRecoveryCheckpoint(
        checkpoints.find(
          (checkpoint) =>
            checkpoint.operationId !==
            uncertain.current?.checkpoint?.operationId,
        ) ?? null,
      );
      setRecoveryError("");
    } catch (error) {
      setRecoveryError(
        error instanceof Error
          ? error.message
          : "Cannot access request recovery information in this browser.",
      );
    }
  }, [user]);
  useEffect(() => {
    if (prototypeEnabled || !user) return;
    void Promise.resolve().then(synchronizeRecovery);
    window.addEventListener("storage", synchronizeRecovery);
    window.addEventListener("focus", synchronizeRecovery);
    return () => {
      window.removeEventListener("storage", synchronizeRecovery);
      window.removeEventListener("focus", synchronizeRecovery);
    };
  }, [synchronizeRecovery, user]);
  const checkAccess = useCallback((next: Snapshot) => {
    if (
      !prototypeEnabled &&
      !matchesOperationalAccess(authenticatedStaff.current, next)
    ) {
      // A first or delayed response must match the identity displayed to staff.
      window.location.reload();
      return false;
    }
    return true;
  }, []);
  const accept = useCallback(
    (next: Snapshot) => {
      if (!checkAccess(next)) return false;
      const previousUser = acceptedSnapshot.current?.user;
      if (
        !prototypeEnabled &&
        previousUser &&
        (previousUser.id !== next.user.id ||
          previousUser.role !== next.user.role)
      ) {
        // Another tab may have changed the signed-in staff or their permissions.
        window.location.reload();
        return false;
      }
      if (activeBranch.current && activeBranch.current !== next.branch.id) {
        if (!prototypeEnabled) {
          window.location.reload();
          return false;
        }
        latestRevision.current = -1;
        setDrafts({});
        setOperation(null);
      }
      activeBranch.current = next.branch.id;
      if (next.revision >= latestRevision.current) {
        latestRevision.current = next.revision;
        acceptedSnapshot.current = next;
        setSnapshot(next);
        return true;
      }
      return false;
    },
    [checkAccess],
  );
  const refresh = useCallback(async () => {
    try {
      const query = new URLSearchParams(
        prototypeEnabled ? {} : readFocus.current,
      );
      const focus = readFocus.current;
      const pageQuery =
        !prototypeEnabled && !Object.keys(focus).length
          ? [...pageQueries.current.values()].at(-1)
          : undefined;
      const data = pageQuery
        ? readPageReceipt(
            await managementJson<unknown>(
              "/api/read?" + readQueryParams(pageQuery),
              { cache: "no-store" },
            ),
          ).context
        : snapshotReceipt(
            await managementJson<unknown>(
              "/api/state" + (query.size ? "?" + query : ""),
              {
                cache: "no-store",
              },
            ),
          );
      if (
        focus !== readFocus.current ||
        (pageQuery && pageQuery !== [...pageQueries.current.values()].at(-1))
      )
        return;
      accept(data);
      setRefreshError("");
      setNow(Date.now());
    } catch (error) {
      if (error instanceof ManagementResponseError && error.status === 401) {
        // A full navigation clears protected drafts and records after session expiry.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
        return;
      }
      const message =
        error instanceof Error ? error.message : "Cannot load branch records.";
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
          acceptedSnapshot.current = null;
          activeBranch.current = null;
          readFocus.current = {};
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
    const refreshInBackground = createBackgroundRefresh(
      refresh,
      () => inFlight.current,
    );
    void refreshInBackground();
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!document.hidden) void refreshInBackground();
    }, 15000);
    const focus = () => {
      void refreshInBackground();
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
    if (!checkAccess(snapshot)) return false;
    const wasUncertain = uncertain.current !== null;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setRecoveredResult(null);
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
      let checkpoint = uncertain.current?.checkpoint;
      let payload = uncertain.current?.payload;
      if (!payload) {
        const operationId = crypto.randomUUID();
        if (!prototypeEnabled) {
          try {
            const previous = listPendingOperations(window.localStorage, {
              actorId: snapshot.user.id,
              branchId: snapshot.branch.id,
            });
            if (previous.length) {
              setRecoveryCheckpoint(previous[0]);
              throw new Error(
                "Check the previous request before submitting another operation.",
              );
            }
            checkpoint = pendingOperation({
              version: 1,
              operationId,
              actorId: snapshot.user.id,
              branchId: snapshot.branch.id,
              endpoint,
              createdAt: Date.now(),
            });
            // Persist only recovery metadata, before sending any command.
            writePendingOperation(window.localStorage, checkpoint);
            setCheckpointWriteFailed(false);
            setRecoveryError("");
          } catch (error) {
            synchronizeRecovery();
            if (error instanceof PendingOperationStorageError) {
              setCheckpointWriteFailed(true);
              setRecoveryError(error.message);
            }
            throw error;
          }
        }
        payload = JSON.stringify({
          branchId: snapshot.branch.id,
          actorId: snapshot.user.id,
          operationId,
          revision: reviewedRevision.current ?? snapshot.revision,
          command,
        });
      }
      uncertain.current = { fingerprint, payload, endpoint, checkpoint };
      const data = operationSnapshotReceipt(
        await managementJson<unknown>(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }),
        { actorId: snapshot.user.id, branchId: snapshot.branch.id },
      );
      if (checkpoint) clearPendingOperation(window.localStorage, checkpoint);
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
      const message =
        command.kind === "DECIDE"
          ? approvalDecisionMessage(data.store, command.approvalId)
          : command.kind === "CORRECT"
            ? "Reversal sent for approval."
            : command.kind === "REQUEST"
              ? "Request sent for approval."
              : command.kind === "CHECK_IN"
                ? "Player checked in."
                : command.kind === "CLOSE_DAY"
                  ? "Business day closed."
                  : "Saved successfully.";
      setNotice(message);
      const key = message
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      toast.success(
        locale === "en" ? message : (messages.ui?.[key] ?? message),
      );
      return true;
    } catch (error) {
      if (error instanceof ManagementResponseError) {
        if (!error.uncertain) {
          // A later rejection cannot prove that an earlier uncertain attempt
          // did not commit. Keep its checkpoint for the locked server check.
          if (!wasUncertain && uncertain.current?.checkpoint) {
            try {
              clearPendingOperation(
                window.localStorage,
                uncertain.current.checkpoint,
              );
            } catch {}
          }
          uncertain.current = null;
        }
        if (error.status === 401) {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign("/login");
          return false;
        }
        if (error.status === 409) await refresh();
      }
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
      synchronizeRecovery();
    }
  }
  async function recoverLast() {
    const checkpoint = recoveryCheckpoint ?? uncertain.current?.checkpoint;
    if (!checkpoint || !snapshot || inFlight.current) return;
    if (!checkAccess(snapshot)) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setRecoveredResult(null);
    try {
      const result = operationRecoveryReceipt(
        await managementJson<unknown>("/api/operations/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operationId: checkpoint.operationId,
            actorId: checkpoint.actorId,
            branchId: checkpoint.branchId,
          }),
        }),
        checkpoint,
      );
      clearPendingOperation(window.localStorage, checkpoint);
      if (uncertain.current?.checkpoint?.operationId === checkpoint.operationId)
        uncertain.current = null;
      accept(result.snapshot);
      setOperation(null);
      setDrafts({});
      setNow(Date.now());
      const message =
        result.status === "saved"
          ? "The previous request was saved. Review the refreshed records before continuing."
          : "The previous request was not saved and its old request is cancelled. You can enter it again.";
      setNotice(message);
      setRecoveredResult(result.status);
      try {
        await refreshAuth();
      } catch {}
    } catch (error) {
      if (error instanceof ManagementResponseError && error.status === 401) {
        // The checkpoint survives sign-in; recovery never stores the command.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/login");
        return;
      }
      setError(
        error instanceof Error
          ? error.message
          : "Cannot check the previous request. Try again before continuing.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
      setRetryRequired(uncertain.current !== null);
      synchronizeRecovery();
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
  const read = useCallback(
    async <T,>(
      query: ReadQuery,
      signal?: AbortSignal,
      focused = false,
    ): Promise<ReadPage<T>> => {
      const expectedFocus = readFocus.current;
      const params = readQueryParams(query);
      const page = readPageReceipt<T>(
        await managementJson<unknown>("/api/read?" + params, {
          cache: "no-store",
          signal,
        }).catch((error: unknown) => {
          if (
            error instanceof ManagementResponseError &&
            error.status === 401
          ) {
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            window.location.assign("/login");
          }
          throw error;
        }),
      );
      if (signal?.aborted) throw signal.reason;
      if (!checkAccess(page.context))
        throw new DOMException("Staff access changed.", "AbortError");
      if (page.revision < latestRevision.current)
        throw new ManagementResponseError(
          "Records changed. Refresh records, review them and try again.",
          409,
          null,
        );
      if (focused && expectedFocus !== readFocus.current)
        throw new DOMException("Request superseded.", "AbortError");
      const current = acceptedSnapshot.current;
      if (
        !prototypeEnabled &&
        current &&
        (current.branch.id !== page.branchId ||
          current.user.id !== page.context.user.id ||
          current.user.role !== page.context.user.role)
      ) {
        accept(page.context);
        throw new DOMException("Staff access changed.", "AbortError");
      }
      if (focused || !Object.keys(readFocus.current).length)
        if (!accept(page.context))
          throw new DOMException("Request superseded.", "AbortError");
      setRefreshError("");
      return page;
    },
    [accept, checkAccess],
  );
  const focusRead = useCallback(
    async (query: ReadQuery, signal?: AbortSignal) => {
      if (prototypeEnabled) return;
      if (signal?.aborted) throw signal.reason;
      const focus =
        query.resource === "receipt"
          ? { receiptId: query.id }
          : query.resource === "requests"
            ? { approvalId: query.id }
            : { playerId: query.playerId ?? query.id };
      const previous = readFocus.current;
      readFocus.current = focus;
      const release = () => {
        if (readFocus.current === focus) {
          readFocus.current = {};
          setReadGeneration((value) => value + 1);
        }
      };
      signal?.addEventListener("abort", release, { once: true });
      try {
        await read(query, signal, true);
        if (signal?.aborted) throw signal.reason;
        return release;
      } catch (error) {
        signal?.removeEventListener("abort", release);
        if (readFocus.current === focus) readFocus.current = previous;
        throw error;
      }
    },
    [read],
  );
  const registerRead = useCallback((query: ReadQuery) => {
    const token = Symbol();
    pageQueries.current.set(token, query);
    return () => {
      pageQueries.current.delete(token);
    };
  }, []);
  async function startOperation(next: Operation) {
    operationIntent.current?.abort();
    const controller = new AbortController();
    operationIntent.current = controller;
    const destination = window.location.pathname;
    setError("");
    try {
      if ("playerId" in next && next.playerId)
        await focusRead(
          { resource: "player", playerId: next.playerId },
          controller.signal,
        );
      if (
        controller.signal.aborted ||
        window.location.pathname !== destination
      ) {
        controller.abort();
        return;
      }
      setOperation(next);
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        return;
      setError(
        error instanceof Error ? error.message : "Cannot load player records.",
      );
    } finally {
      if (operationIntent.current === controller)
        operationIntent.current = null;
    }
  }
  return {
    operation,
    startOperation,
    closeOperation: () => {
      operationIntent.current?.abort();
      readFocus.current = {};
      setReadGeneration((value) => value + 1);
      setOperation(null);
    },
    read,
    registerRead,
    focusRead,
    clearReadFocus: () => {
      readFocus.current = {};
      setReadGeneration((value) => value + 1);
    },
    readGeneration,
    withReviewedRevision: async (
      revision: number | undefined,
      action: () => unknown | Promise<unknown>,
    ) => {
      const previous = reviewedRevision.current;
      reviewedRevision.current = revision;
      try {
        return await action();
      } finally {
        reviewedRevision.current = previous;
      }
    },
    finishCheckIn: (expected: CheckInContinuation, buyInNext: boolean) => {
      const visit = checkedInVisit(acceptedSnapshot.current, expected);
      if (!visit) {
        setOperation(null);
        return;
      }
      readFocus.current = buyInNext ? { playerId: visit.playerId } : {};
      setDrafts((current) => ({
        ...current,
        "player.search": visit.phone,
        "player.status": "",
        "player.type": "",
        "player.tag": "",
        "player.page": "0",
      }));
      setOperation(
        buyInNext
          ? {
              kind: "transaction",
              type: "Buy-in",
              playerId: visit.playerId,
              tableId: visit.tableId,
            }
          : null,
      );
    },
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
    draftValue: (key: string): string | undefined => drafts[key],
    setDraft,
    clearDraft: (key: string) =>
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      }),
    retryRequired:
      retryRequired ||
      !!recoveryCheckpoint ||
      !!recoveryError ||
      checkpointWriteFailed,
    recoveryCheckpoint,
    recoveryError:
      recoveryError ||
      (checkpointWriteFailed
        ? "Cannot access request recovery information in this browser."
        : ""),
    recoveredResult,
    synchronizeRecovery: () => {
      setCheckpointWriteFailed(false);
      synchronizeRecovery();
    },
    recoverLast,
    canRetryLast: retryRequired,
    canRecoverLast:
      !!recoveryCheckpoint || (!prototypeEnabled && retryRequired),
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
