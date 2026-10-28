import "server-only";
import { DomainError } from "../domain/operations";

const admissionError = Symbol.for("poker.authentication.admission-error");

/** Only errors created by the authentication admission module carry this marker. */
export class AuthAdmissionError extends DomainError {
  readonly [admissionError] = true;
  constructor(
    message: string,
    status: 429 | 503,
    readonly retryAfterSeconds: number,
  ) {
    super(message, status);
  }
}

/** Sample marked error values once before using them in a response. */
export function authAdmissionDetails(error: unknown): {
  status: 429 | 503;
  retryAfterSeconds: number;
  message: string;
} | null {
  try {
    if (!(error instanceof Error)) return null;
    const candidate = error as AuthAdmissionError;
    const marked = candidate[admissionError];
    const status = candidate.status;
    const retryAfterSeconds = candidate.retryAfterSeconds;
    const message = candidate.message;
    return marked === true &&
      (status === 429 || status === 503) &&
      Number.isInteger(retryAfterSeconds) &&
      retryAfterSeconds >= 1 &&
      retryAfterSeconds <= 900 &&
      typeof message === "string" &&
      message.length <= 1000
      ? { status, retryAfterSeconds, message }
      : null;
  } catch {
    return null;
  }
}

/** The marker also survives duplicated server bundles and development refreshes. */
export function authAdmissionRetryAfter(error: unknown): number | null {
  return authAdmissionDetails(error)?.retryAfterSeconds ?? null;
}

export type WorkLimits = Readonly<{
  active: number;
  queued: number;
  waitMs: number;
}>;

function busy() {
  return new AuthAdmissionError(
    "The service is busy. Try again shortly.",
    503,
    5,
  );
}

/** A bounded FIFO; timeouts remove queued jobs, never release running work early. */
export function createWorkGate(limits: WorkLimits) {
  if (
    !Number.isInteger(limits.active) ||
    limits.active < 1 ||
    !Number.isInteger(limits.queued) ||
    limits.queued < 0 ||
    !Number.isInteger(limits.waitMs) ||
    limits.waitMs < 1
  )
    throw new Error("Use positive work limits and a nonnegative queue size.");
  let active = 0;
  const queue: Array<{
    start: () => void;
    expire: () => void;
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  return function run<T>(work: () => Promise<T>): Promise<T> {
    if (active >= limits.active && queue.length >= limits.queued)
      return Promise.reject(busy());
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        void Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            active--;
            let next;
            while ((next = queue.shift())) {
              clearTimeout(next.timer);
              // Timer delivery can lag behind native completion on a busy loop.
              if (performance.now() >= next.deadline) {
                next.expire();
                continue;
              }
              next.start();
              break;
            }
          });
      };
      if (active < limits.active) start();
      else {
        const pending = {
          start,
          expire: () => reject(busy()),
          deadline: performance.now() + limits.waitMs,
          timer: setTimeout(() => {
            const index = queue.indexOf(pending);
            if (index !== -1) {
              queue.splice(index, 1);
              reject(busy());
            }
          }, limits.waitMs),
        };
        queue.push(pending);
      }
    });
  };
}

export const PASSWORD_WORK_LIMITS = {
  active: 4,
  queued: 64,
  waitMs: 5000,
} as const;

type WorkGate = ReturnType<typeof createWorkGate>;
const runtime = globalThis as typeof globalThis & {
  pokerPasswordWork?: WorkGate;
};
// A process-wide gate prevents separate route bundles from each starting four KDFs.
export const withPasswordWork = (runtime.pokerPasswordWork ??=
  createWorkGate(PASSWORD_WORK_LIMITS));
