"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Snapshot } from "@/domain/model";
import {
  matchesClosingTaskScope,
  type ClosingTaskScope,
} from "@/lib/closing-task";

type ResumeClosing = { scope: ClosingTaskScope; requestId: number };
type ClosingTaskContextValue = {
  task: ClosingTaskScope | null;
  requested: ResumeClosing | null;
  begin: () => void;
  cancel: () => void;
  requestResume: () => void;
  acceptResume: (request: ResumeClosing, snapshot: Snapshot) => boolean;
  dismissResume: (request: ResumeClosing) => void;
};
const ClosingTaskContext = createContext<ClosingTaskContextValue | null>(null);

type ClosingTaskState = {
  scope: ClosingTaskScope | null;
  task: ClosingTaskScope | null;
  requested: ResumeClosing | null;
};

/** Reset only temporary task state; keep the surrounding shell and forms mounted. */
export function ClosingTaskProvider({
  scope,
  children,
}: {
  scope: ClosingTaskScope | null;
  children: ReactNode;
}) {
  const [state, setState] = useState<ClosingTaskState>({
    scope,
    task: null,
    requested: null,
  });
  if (state.scope?.key !== scope?.key)
    setState({ scope, task: null, requested: null });
  const current = useRef(state);
  const nextRequest = useRef(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    current.current = state;
  }, [state]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const publish = useCallback((next: ClosingTaskState) => {
    current.current = next;
    setState(next);
  }, []);
  const cancel = useCallback(() => {
    if (!mounted.current) return;
    publish({ ...current.current, task: null, requested: null });
  }, [publish]);
  const begin = useCallback(() => {
    const latest = current.current;
    if (!mounted.current || !latest.scope) return;
    publish({ ...latest, task: latest.scope, requested: null });
  }, [publish]);
  const requestResume = useCallback(() => {
    const latest = current.current;
    if (!mounted.current || !latest.task || latest.requested) return;
    publish({
      ...latest,
      requested: { scope: latest.task, requestId: ++nextRequest.current },
    });
  }, [publish]);
  const dismissResume = useCallback(
    (request: ResumeClosing) => {
      const latest = current.current;
      if (!mounted.current || latest.requested !== request) return;
      publish({ ...latest, requested: null });
    },
    [publish],
  );
  const acceptResume = useCallback(
    (request: ResumeClosing, snapshot: Snapshot) => {
      const latest = current.current;
      if (
        !mounted.current ||
        latest.requested !== request ||
        latest.task !== request.scope ||
        latest.scope?.key !== request.scope.key
      )
        return false;
      if (!matchesClosingTaskScope(request.scope, snapshot)) {
        cancel();
        return false;
      }
      dismissResume(request);
      return true;
    },
    [cancel, dismissResume],
  );
  return (
    <ClosingTaskContext.Provider
      value={{
        task: state.task,
        requested: state.requested,
        begin,
        cancel,
        requestResume,
        acceptResume,
        dismissResume,
      }}
    >
      {children}
    </ClosingTaskContext.Provider>
  );
}

export function useClosingTask() {
  const context = useContext(ClosingTaskContext);
  if (!context)
    throw new Error("useClosingTask must be used within ClosingTaskProvider");
  return context;
}
