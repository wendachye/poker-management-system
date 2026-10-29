import type { Snapshot } from "../domain/model";
import type { ReadQuery } from "../domain/read-model";
import {
  checkedExportAccess,
  decodeExportAccess,
  encodeExportAccess,
  EXPORT_ACCESS_HEADER,
  sameExportAccess,
} from "./export-access";
import { matchesOperationalAccess } from "./operational-access";
import {
  ManagementResponseError,
  readManagementResponse,
} from "./management-response";
import { readQueryParams } from "./read-page";

/** Obtain a verified report before the caller creates a browser download. */
export async function readReportCsv(
  query: ReadQuery,
  context: Pick<Snapshot, "user" | "branch">,
  request: (path: string, init: RequestInit) => Promise<Response>,
  callerSignal?: AbortSignal,
): Promise<Blob> {
  if (!matchesOperationalAccess(context.user, context))
    throw new Error("Reload the report before exporting.");
  const access = checkedExportAccess({
    actorId: context.user.id,
    branchId: context.branch.id,
    role: context.user.role,
  });
  if (!access || !["report", "range"].includes(query.resource))
    throw new Error("Reload the report before exporting.");
  const params = readQueryParams(query);
  params.set("format", "csv");
  const deadline = AbortSignal.timeout(45000);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadline])
    : deadline;
  try {
    signal.throwIfAborted();
    const response = await request("/api/read?" + params, {
      cache: "no-store",
      signal,
      headers: { [EXPORT_ACCESS_HEADER]: encodeExportAccess(access) },
    });
    signal.throwIfAborted();
    if (!response.ok) await readManagementResponse(response);
    const receipt = decodeExportAccess(
      response.headers.get(EXPORT_ACCESS_HEADER),
    );
    if (!receipt || !sameExportAccess(access, receipt))
      throw new ManagementResponseError(
        "Staff access or venue changed. Refresh the report before exporting.",
        409,
        null,
      );
    if (
      !/^text\/csv(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    )
      throw new Error("Cannot download report. Please try again.");
    signal.throwIfAborted();
    const value = await response.blob();
    signal.throwIfAborted();
    if (value.size > 4_000_000)
      throw new Error("Cannot download report. Please try again.");
    return value;
  } catch (error) {
    if (callerSignal?.aborted)
      throw new DOMException("Report download cancelled.", "AbortError");
    if (deadline.aborted)
      throw new ManagementResponseError(
        "Report download timed out. Try exporting again.",
        408,
        null,
      );
    if (error instanceof ManagementResponseError) throw error;
    throw new Error("Cannot download report. Please try again.");
  }
}
