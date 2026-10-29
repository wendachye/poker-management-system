"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReadPage, ReadQuery } from "@/domain/read-model";
import type { Snapshot } from "@/domain/model";
import { prototypeEnabled } from "@/prototype/config";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { useText } from "./shared";
import { managementRequest } from "@/lib/management-request";
import { readReportCsv } from "@/lib/report-export";
import {
  readSearchDelay,
  type ReadSearchRequest,
} from "@/lib/read-search-delay";

export async function downloadReadCsv(
  query: ReadQuery,
  filename: string,
  context: Pick<Snapshot, "user" | "branch">,
  signal?: AbortSignal,
) {
  const checkCancellation = () => {
    if (signal?.aborted)
      throw new DOMException("Report download cancelled.", "AbortError");
  };
  checkCancellation();
  const value = await readReportCsv(query, context, managementRequest, signal);
  checkCancellation();
  const url = URL.createObjectURL(value);
  try {
    checkCancellation();
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    checkCancellation();
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function useReadCsvDownload() {
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    mounted.current = true;
    // Effect reconnection can preserve React state after cancelling its export.
    // A new owner's work must not be cleared by this deferred idle reset.
    void Promise.resolve().then(() => {
      if (mounted.current && !inFlight.current) setBusy(false);
    });
    return () => {
      mounted.current = false;
      const controller = inFlight.current;
      inFlight.current = null;
      controller?.abort();
    };
  }, []);
  const download = useCallback(
    async (
      query: ReadQuery,
      filename: string,
      context: Pick<Snapshot, "user" | "branch">,
    ) => {
      if (!mounted.current || inFlight.current) return;
      const controller = new AbortController();
      inFlight.current = controller;
      setBusy(true);
      try {
        await downloadReadCsv(
          { ...query },
          filename,
          {
            user: { ...context.user },
            branch: { ...context.branch },
          },
          controller.signal,
        );
      } catch (error) {
        // Leaving a view is not an export error on the newly selected screen.
        if (!controller.signal.aborted) throw error;
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
          if (mounted.current) setBusy(false);
        }
      }
    },
    [],
  );
  return { busy, download };
}

export function useReadPage<T>(query: ReadQuery, enabled = true) {
  const { read, snapshot, readGeneration, registerRead } =
    usePokerManagementContext();
  const key = JSON.stringify(query);
  const branchId = snapshot?.branch.id;
  const staffId = snapshot?.user.id;
  const role = snapshot?.user.role;
  const access = useMemo(
    () => ({ enabled, branchId, staffId, role, read }),
    [enabled, branchId, staffId, role, read],
  );
  const eligible = enabled && !!branchId && !!staffId && !!role;
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    access: typeof access;
    data: ReadPage<T>;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    access: typeof access;
    message: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const previousRequest = useRef<ReadSearchRequest | null>(null);
  const currentResult =
    eligible && result?.access === access && result.key === key;
  const error =
    eligible && failure?.access === access && failure.key === key
      ? failure.message
      : "";
  const revision = snapshot?.revision;
  useEffect(() => {
    const parsed = JSON.parse(key) as ReadQuery;
    const request = {
      query: parsed,
      branchId,
      revision,
      attempt,
      readGeneration,
      enabled,
      readIdentity: access,
      registerReadIdentity: registerRead,
    };
    const delay = readSearchDelay(previousRequest.current, request);
    previousRequest.current = request;
    if (prototypeEnabled || !eligible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unregister = () => {};
    const load = async () => {
      if (controller.signal.aborted) return;
      try {
        unregister = registerRead(parsed);
        const data = await read<T>(parsed, controller.signal);
        if (!controller.signal.aborted) setResult({ key, access, data });
      } catch (error) {
        if (
          !controller.signal.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        )
          setFailure({
            key,
            access,
            message:
              error instanceof Error ? error.message : "Cannot load records.",
          });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setLoading(true);
      setFailure(null);
      if (delay) timer = setTimeout(() => void load(), delay);
      else void load();
    });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      unregister();
    };
  }, [
    key,
    access,
    eligible,
    branchId,
    revision,
    attempt,
    enabled,
    read,
    readGeneration,
    registerRead,
  ]);
  return {
    live: !prototypeEnabled,
    data: currentResult ? result.data : null,
    error,
    loading:
      !prototypeEnabled && eligible && (loading || (!currentResult && !error)),
    retry: () => retry((value) => value + 1),
  };
}

export function ReadStatus({
  state,
}: {
  state: { loading: boolean; error: string; retry: () => void };
}) {
  const t = useText();
  if (state.error)
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          <p>{t(state.error)}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={state.retry}
          >
            {t("Retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  return state.loading ? (
    <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
      {t("Loading records…")}
    </p>
  ) : null;
}
