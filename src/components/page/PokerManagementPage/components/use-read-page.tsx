"use client";
import { useEffect, useState } from "react";
import type { ReadPage, ReadQuery } from "@/domain/read-model";
import { prototypeEnabled } from "@/prototype/config";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { useText } from "./shared";
import { managementRequest } from "@/lib/management-request";
import { readManagementResponse } from "@/lib/management-response";
import { readQueryParams } from "@/lib/read-page";

export async function downloadReadCsv(query: ReadQuery, filename: string) {
  const params = readQueryParams(query);
  params.set("format", "csv");
  const response = await managementRequest("/api/read?" + params, {
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) await readManagementResponse(response);
  if (!response.headers.get("content-type")?.startsWith("text/csv"))
    throw new Error("Cannot download report. Please try again.");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useReadPage<T>(query: ReadQuery, enabled = true) {
  const { read, snapshot, readGeneration, registerRead } =
    usePokerManagementContext();
  const key = JSON.stringify(query);
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data: ReadPage<T>;
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const branchId = snapshot?.branch.id;
  const revision = snapshot?.revision;
  useEffect(() => {
    if (prototypeEnabled || !enabled || !branchId) return;
    const controller = new AbortController();
    const parsed = JSON.parse(key) as ReadQuery;
    const unregister = registerRead(parsed);
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoading(true);
      setError("");
      try {
        const data = await read<T>(parsed, controller.signal);
        if (!controller.signal.aborted) setResult({ key, data });
      } catch (error) {
        if (
          !controller.signal.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        )
          setError(
            error instanceof Error ? error.message : "Cannot load records.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    });
    return () => {
      controller.abort();
      unregister();
    };
  }, [
    key,
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
    data: result?.key === key ? result.data : null,
    error,
    loading:
      !prototypeEnabled &&
      enabled &&
      (loading || (result?.key !== key && !error)),
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
