import { database } from "@/server/database";
import {
  failure,
  json,
  prototypeApiResponse,
  sessionToken,
} from "@/server/http";
import { readCsv, readPage } from "@/server/queries";
import { randomUUID } from "node:crypto";
import { DomainError } from "@/domain/operations";
import { csvExportBusyDetails } from "@/server/csv-export-work";
import {
  decodeExportAccess,
  encodeExportAccess,
  EXPORT_ACCESS_HEADER,
} from "@/lib/export-access";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const disabled = prototypeApiResponse();
  if (disabled) return disabled;
  try {
    const params = new URL(request.url).searchParams;
    const format = params.get("format");
    params.delete("format");
    const input = Object.fromEntries(params);
    if (format === "csv") {
      const expected = decodeExportAccess(
        request.headers.get(EXPORT_ACCESS_HEADER),
      );
      if (!expected)
        throw new DomainError("Reload the report before exporting.");
      const result = await readCsv(
        database(),
        await sessionToken(),
        input,
        expected,
        request.signal,
      );
      return new Response(result.value, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${result.filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Request-ID": randomUUID(),
          [EXPORT_ACCESS_HEADER]: encodeExportAccess(result.access),
        },
      });
    }
    return json(await readPage(database(), await sessionToken(), input));
  } catch (error) {
    const busy = csvExportBusyDetails(error);
    if (busy) {
      const response = json({ error: busy.message }, busy.status);
      response.headers.set("Retry-After", String(busy.retryAfterSeconds));
      return response;
    }
    return failure(error);
  }
}
