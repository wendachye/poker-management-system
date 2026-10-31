import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";

export type MixedClock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

const clock: MixedClock = {
  now: () => performance.now(),
  sleep: async (ms, signal) => {
    await setTimeout(ms, undefined, { signal });
  },
};

export type MixedReaderCoverage = {
  startedMs: number;
  finishedMs: number;
  completedRounds: number;
  stopReason: "phase-ended" | "round-limit" | "failed";
};

export class MixedScheduleError extends Error {
  constructor(
    readonly category:
      "INVALID_SCHEDULE" | "READER_CAP_EXHAUSTED" | "PHASE_CANCELLED",
    readonly coverage?: MixedReaderCoverage,
  ) {
    super(category);
    this.name = "MixedScheduleError";
  }
}

function validInteger(value: number, minimum: number) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function abortedSleep(error: unknown, signal: AbortSignal) {
  return (
    signal.aborted && error instanceof Error && error.name === "AbortError"
  );
}

/** Pace zero-based cycle starts from the first at startedMs to the last at
 * startedMs + durationMs. Falling behind never adds another delay. Short runs
 * skip this helper; sustained pacing needs at least two cycles and a duration.
 */
export async function waitForMixedCycle(
  startedMs: number,
  cycle: number,
  cycles: number,
  durationMs: number,
  signal: AbortSignal,
  timer: MixedClock = clock,
) {
  if (
    !Number.isFinite(startedMs) ||
    startedMs < 0 ||
    !validInteger(cycles, 2) ||
    !validInteger(cycle, 0) ||
    cycle >= cycles ||
    !validInteger(durationMs, 1) ||
    durationMs > 2_147_483_647 ||
    startedMs + durationMs > Number.MAX_SAFE_INTEGER
  )
    throw new MixedScheduleError("INVALID_SCHEDULE");
  const target = startedMs + (cycle / (cycles - 1)) * durationMs;
  while (!signal.aborted) {
    const remaining = target - timer.now();
    if (remaining <= 0) return;
    try {
      await timer.sleep(remaining, signal);
    } catch (error) {
      if (abortedSleep(error, signal))
        throw new MixedScheduleError("PHASE_CANCELLED");
      throw error;
    }
  }
  throw new MixedScheduleError("PHASE_CANCELLED");
}

/** Cancellation is observed between awaited rounds and pauses. The current
 * read always drains before this worker finishes; no read promise is raced or
 * retried. Supplying coverage keeps final progress inspectable on any failure.
 */
export async function runMixedReader(
  options: {
    roundLimit: number;
    pauseMs: number;
    sustained: boolean;
    coverage?: MixedReaderCoverage;
  },
  phaseSignal: AbortSignal,
  readRound: (round: number) => Promise<void>,
  timer: MixedClock = clock,
) {
  if (
    !validInteger(options.roundLimit, 1) ||
    !validInteger(options.pauseMs, 0) ||
    options.pauseMs > 2_147_483_647 ||
    typeof options.sustained !== "boolean"
  )
    throw new MixedScheduleError("INVALID_SCHEDULE");
  const coverage: MixedReaderCoverage = options.coverage ?? {
    startedMs: 0,
    finishedMs: 0,
    completedRounds: 0,
    stopReason: "failed",
  };
  coverage.startedMs = timer.now();
  coverage.finishedMs = coverage.startedMs;
  coverage.completedRounds = 0;
  coverage.stopReason = "failed";
  try {
    while (!phaseSignal.aborted) {
      if (coverage.completedRounds === options.roundLimit) {
        if (options.sustained)
          throw new MixedScheduleError("READER_CAP_EXHAUSTED", coverage);
        coverage.stopReason = "round-limit";
        return coverage;
      }
      await readRound(coverage.completedRounds);
      coverage.completedRounds++;
      if (phaseSignal.aborted) break;
      // A completed finite run needs no final pause. Sustained runs check the
      // cap immediately too, rather than hiding exhausted coverage in a pause.
      if (coverage.completedRounds === options.roundLimit) continue;
      if (options.pauseMs > 0) {
        try {
          await timer.sleep(options.pauseMs, phaseSignal);
        } catch (error) {
          if (abortedSleep(error, phaseSignal)) break;
          throw error;
        }
      }
    }
    coverage.stopReason = "phase-ended";
    return coverage;
  } finally {
    coverage.finishedMs = timer.now();
  }
}
