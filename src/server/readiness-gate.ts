import "server-only";
import type { HealthOutcome } from "./health";

type GateOptions = {
  ttlMs?: number;
  deadlineMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
};

const reasons = new Set([
  "CONFIGURATION",
  "DATABASE",
  "SCHEMA",
  "PROTOTYPE_FLAGS",
  "PROBE_TIMEOUT",
  "PROBE_BUSY",
]);
const unavailable = Object.freeze({
  ready: false,
  mode: "operations",
  reason: "DATABASE",
  code: "UNKNOWN",
} satisfies HealthOutcome);
const timeout = Object.freeze({
  ready: false,
  mode: "operations",
  reason: "PROBE_TIMEOUT",
  code: "ETIMEDOUT",
} satisfies HealthOutcome);
const busy = Object.freeze({
  ready: false,
  mode: "operations",
  reason: "PROBE_BUSY",
} satisfies HealthOutcome);

function bounded(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1 || value > 60_000)
    throw new Error(`${name} must be an integer from 1 to 60000.`);
  return value;
}

/** Retain only immutable coarse metadata, never a Response, ID or query result. */
function copyOutcome(input: HealthOutcome): HealthOutcome {
  try {
    const { ready, mode } = input;
    if (mode !== "operations" && mode !== "prototype") return unavailable;
    if (ready === true) return Object.freeze({ ready, mode });
    if (ready !== false) return unavailable;
    const { reason, code } = input;
    if (!reasons.has(reason)) return unavailable;
    return Object.freeze({
      ready,
      mode,
      reason,
      ...(code === undefined
        ? {}
        : {
            code:
              typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
                ? code
                : "UNKNOWN",
          }),
    });
  } catch {
    return unavailable;
  }
}

/** One cache entry and one underlying probe per process. A response deadline
 * never releases the probe slot before the actual database work has settled.
 */
export function createReadinessGate(options: GateOptions = {}) {
  const ttlMs = bounded(options.ttlMs ?? 1000, "Readiness TTL");
  const deadlineMs = bounded(options.deadlineMs ?? 2000, "Readiness deadline");
  const now = options.now ?? (() => performance.now());
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  if (typeof now !== "function" || typeof schedule !== "function")
    throw new Error("Readiness clock and scheduler must be functions.");
  let currentKey: string | undefined;
  let generation = Symbol();
  let cache:
    | {
        key: string;
        generation: symbol;
        outcome: HealthOutcome;
        expiresAt: number;
      }
    | undefined;
  type Flight = {
    key: string;
    generation: symbol;
    result: Promise<HealthOutcome>;
    resolve: (outcome: HealthOutcome) => void;
    cancel: () => void;
    resolved: boolean;
    deadlineAt: number;
  };
  let active: Flight | undefined;
  let lastTime = -Infinity;

  const time = () => {
    try {
      const value = now();
      if (!Number.isFinite(value) || value < 0 || value < lastTime)
        return Infinity;
      lastTime = value;
      return value;
    } catch {
      return Infinity;
    }
  };
  function finish(flight: Flight, outcome: HealthOutcome, retain: boolean) {
    if (flight.resolved) return;
    const completed = retain ? time() : undefined;
    // Promise continuations can run before a delayed timer callback. The budget
    // must still apply when accepting a result after the monotonic deadline.
    const result =
      retain && (!Number.isFinite(completed) || completed! >= flight.deadlineAt)
        ? timeout
        : outcome;
    flight.resolved = true;
    try {
      flight.cancel();
    } catch {}
    if (
      retain &&
      generation === flight.generation &&
      currentKey === flight.key
    ) {
      cache = Number.isFinite(completed)
        ? {
            key: flight.key,
            generation,
            outcome: result,
            expiresAt: completed! + ttlMs,
          }
        : undefined;
    }
    flight.resolve(result);
  }
  function invalidate() {
    generation = Symbol();
    cache = undefined;
    if (active) finish(active, busy, false);
  }
  function read(
    key: string,
    probe: () => Promise<HealthOutcome>,
  ): Promise<HealthOutcome> {
    if (typeof key !== "string" || key.length < 1 || key.length > 256)
      return Promise.resolve(unavailable);
    if (key !== currentKey) {
      invalidate();
      currentKey = key;
    }
    const observed = time();
    if (!Number.isFinite(observed)) {
      cache = undefined;
      if (active) finish(active, timeout, false);
      return Promise.resolve(timeout);
    }
    if (cache) {
      if (
        cache.generation === generation &&
        cache.key === key &&
        observed < cache.expiresAt
      )
        return Promise.resolve(cache.outcome);
      cache = undefined;
    }
    if (active) {
      if (active.key !== key || active.generation !== generation)
        return Promise.resolve(busy);
      if (!active.resolved && observed >= active.deadlineAt)
        finish(active, timeout, true);
      return active.result;
    }
    let resolve!: (outcome: HealthOutcome) => void;
    const result = new Promise<HealthOutcome>((done) => {
      resolve = done;
    });
    const flight: Flight = {
      key,
      generation,
      result,
      resolve,
      cancel: () => {},
      resolved: false,
      deadlineAt: observed + deadlineMs,
    };
    active = flight;
    try {
      flight.cancel = schedule(() => finish(flight, timeout, true), deadlineMs);
    } catch {
      finish(flight, timeout, true);
      active = undefined;
      return result;
    }
    if (flight.resolved) {
      try {
        flight.cancel();
      } catch {}
      active = undefined;
      return result;
    }
    let running: Promise<HealthOutcome>;
    try {
      running = Promise.resolve(probe());
    } catch {
      running = Promise.resolve(unavailable);
    }
    void running.then(
      (outcome) => {
        finish(flight, copyOutcome(outcome), true);
        if (active === flight) active = undefined;
      },
      () => {
        finish(flight, unavailable, true);
        if (active === flight) active = undefined;
      },
    );
    return result;
  }
  return { read, invalidate };
}
