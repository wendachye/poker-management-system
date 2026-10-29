import "server-only";
import { DomainError } from "../domain/operations";

const busyMarker = Symbol.for("poker.csv-export.busy");
const busyMessage =
  "Another report is being exported. Please try again shortly.";

class CsvExportBusyError extends DomainError {
  readonly [busyMarker] = true;
  readonly retryAfterSeconds = 1;
  constructor() {
    super(busyMessage, 503);
  }
}

/** A stable marker recognizes busy errors from another server bundle or HMR. */
export function csvExportBusyDetails(error: unknown): {
  status: 503;
  retryAfterSeconds: 1;
  message: string;
} | null {
  try {
    if (!(error instanceof Error)) return null;
    const candidate = error as CsvExportBusyError;
    const marked = candidate[busyMarker];
    const status = candidate.status;
    const retryAfterSeconds = candidate.retryAfterSeconds;
    return marked === true && status === 503 && retryAfterSeconds === 1
      ? { status: 503, retryAfterSeconds: 1, message: busyMessage }
      : null;
  } catch {
    return null;
  }
}

type CsvExportWork = <T>(work: () => T | Promise<T>) => Promise<T>;

function createCsvExportGate(): CsvExportWork {
  let active = false;
  return async function withCsvExportWork<T>(work: () => T | Promise<T>) {
    if (active) throw new CsvExportBusyError();
    active = true;
    try {
      // Await the actual transaction, including commit/rollback and release.
      // A caller abandoning its response must not admit another export early.
      return await work();
    } finally {
      active = false;
    }
  };
}

const runtime = globalThis as typeof globalThis & {
  pokerCsvExportWork?: CsvExportWork;
};

/** One active export per process, with no queued export holding a connection. */
export const withCsvExportWork = (runtime.pokerCsvExportWork ??=
  createCsvExportGate());
