import assert from "node:assert/strict";
import test from "node:test";
import {
  MixedScheduleError,
  runMixedReader,
  waitForMixedCycle,
  type MixedClock,
  type MixedReaderCoverage,
} from "../scripts/mixed-workload-schedule";

function autoClock(started = 100) {
  let current = started;
  const pauses: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      pauses.push(ms);
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
    pauses,
  } satisfies MixedClock & {
    advance(ms: number): void;
    pauses: number[];
  };
}

function controlledSleepClock() {
  let current = 100;
  let listeners = 0;
  let finish: (() => void) | undefined;
  const timer: MixedClock = {
    now: () => current,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          signal?.removeEventListener("abort", abort);
          listeners--;
          finish = undefined;
        };
        const abort = () => {
          cleanup();
          reject(new DOMException("Private abort reason", "AbortError"));
        };
        if (signal?.aborted) {
          reject(new DOMException("Private abort reason", "AbortError"));
          return;
        }
        listeners++;
        signal?.addEventListener("abort", abort, { once: true });
        finish = () => {
          current += ms;
          cleanup();
          resolve();
        };
      }),
  };
  return {
    timer,
    listeners: () => listeners,
    finish: () => {
      assert.ok(finish, "a sleep must be pending");
      finish();
    },
  };
}

const coverage = (): MixedReaderCoverage => ({
  startedMs: -1,
  finishedMs: -1,
  completedRounds: -1,
  stopReason: "failed",
});

function category(expected: MixedScheduleError["category"]) {
  return (error: unknown) => {
    assert.ok(error instanceof MixedScheduleError);
    assert.equal(error.category, expected);
    assert.equal(error.message, expected);
    return true;
  };
}

test("mixed cycle starts span the requested monotonic interval", async () => {
  const timer = autoClock();
  const signal = new AbortController().signal;
  const starts: number[] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    await waitForMixedCycle(100, cycle, 4, 900, signal, timer);
    starts.push(timer.now());
  }
  assert.deepEqual(starts, [100, 400, 700, 1000]);
  assert.deepEqual(timer.pauses, [300, 300, 300]);
});

test("late financial cycles run immediately without adding a catch-up delay", async () => {
  const timer = autoClock(800);
  const signal = new AbortController().signal;
  await waitForMixedCycle(100, 1, 4, 900, signal, timer);
  await waitForMixedCycle(100, 2, 4, 900, signal, timer);
  assert.deepEqual(timer.pauses, []);
  await waitForMixedCycle(100, 3, 4, 900, signal, timer);
  assert.deepEqual(timer.pauses, [200]);
});

test("pacing rechecks the monotonic deadline after an early timer completion", async () => {
  const timer = autoClock();
  const normal = timer.sleep;
  let first = true;
  timer.sleep = async (ms) => {
    await normal(first ? 10 : ms);
    first = false;
  };
  await waitForMixedCycle(100, 1, 2, 500, new AbortController().signal, timer);
  assert.equal(timer.now(), 600);
  assert.deepEqual(timer.pauses, [10, 490]);
});

test("pacing rejects invalid or unbounded configuration before sleeping", async () => {
  const signal = new AbortController().signal;
  const timer = autoClock();
  const cases = [
    [-1, 0, 2, 1],
    [NaN, 0, 2, 1],
    [Infinity, 0, 2, 1],
    [100, -1, 2, 1],
    [100, 0.5, 2, 1],
    [100, 2, 2, 1],
    [100, 0, 1, 1],
    [100, 0, 2.5, 1],
    [100, 0, 2, 0],
    [100, 0, 2, -1],
    [100, 0, 2, 1.5],
    [100, 0, 2, 2_147_483_648],
    [Number.MAX_SAFE_INTEGER, 0, 2, 1],
  ];
  for (const [start, cycle, cycles, duration] of cases)
    await assert.rejects(
      waitForMixedCycle(start, cycle, cycles, duration, signal, timer),
      category("INVALID_SCHEDULE"),
    );
  assert.deepEqual(timer.pauses, []);
});

test("an aborted phase stops writers before pacing without exposing its reason", async () => {
  const phase = new AbortController();
  phase.abort(new Error("Private phase detail"));
  const timer = autoClock();
  await assert.rejects(
    waitForMixedCycle(100, 0, 2, 100, phase.signal, timer),
    category("PHASE_CANCELLED"),
  );
  assert.deepEqual(timer.pauses, []);
});

test("aborting a pacing sleep releases its listener and stops the writer", async () => {
  const phase = new AbortController();
  const control = controlledSleepClock();
  const waiting = waitForMixedCycle(
    100,
    1,
    2,
    100,
    phase.signal,
    control.timer,
  );
  assert.equal(control.listeners(), 1);
  phase.abort();
  await assert.rejects(waiting, category("PHASE_CANCELLED"));
  assert.equal(control.listeners(), 0);
});

test("finite readers retain their round limit and omit a trailing pause", async () => {
  const timer = autoClock();
  const reads: number[] = [];
  const progress = coverage();
  const result = await runMixedReader(
    { roundLimit: 3, pauseMs: 25, sustained: false, coverage: progress },
    new AbortController().signal,
    async (round) => {
      reads.push(round);
      timer.advance(10);
    },
    timer,
  );
  assert.equal(result, progress);
  assert.deepEqual(reads, [0, 1, 2]);
  assert.deepEqual(timer.pauses, [25, 25]);
  assert.deepEqual(progress, {
    startedMs: 100,
    finishedMs: 180,
    completedRounds: 3,
    stopReason: "round-limit",
  });
});

test("sustained readers fail visibly if their cap precedes the phase end", async () => {
  const timer = autoClock();
  const progress = coverage();
  const reads: number[] = [];
  await assert.rejects(
    runMixedReader(
      { roundLimit: 2, pauseMs: 5, sustained: true, coverage: progress },
      new AbortController().signal,
      async (round) => {
        reads.push(round);
        timer.advance(10);
      },
      timer,
    ),
    (error: unknown) => {
      category("READER_CAP_EXHAUSTED")(error);
      assert.equal((error as MixedScheduleError).coverage, progress);
      return true;
    },
  );
  assert.deepEqual(reads, [0, 1]);
  assert.deepEqual(timer.pauses, [5]);
  assert.deepEqual(progress, {
    startedMs: 100,
    finishedMs: 125,
    completedRounds: 2,
    stopReason: "failed",
  });
});

test("a phase ending on the last permitted read succeeds instead of reporting cap exhaustion", async () => {
  const phase = new AbortController();
  const result = await runMixedReader(
    { roundLimit: 1, pauseMs: 5, sustained: true },
    phase.signal,
    async () => phase.abort(),
    autoClock(),
  );
  assert.equal(result.stopReason, "phase-ended");
  assert.equal(result.completedRounds, 1);
});

test("a cancelled reader never starts another read and releases a pending pause", async () => {
  const phase = new AbortController();
  const control = controlledSleepClock();
  const reads: number[] = [];
  const work = runMixedReader(
    { roundLimit: 5, pauseMs: 25, sustained: true },
    phase.signal,
    async (round) => {
      reads.push(round);
    },
    control.timer,
  );
  await Promise.resolve();
  assert.equal(control.listeners(), 1);
  phase.abort();
  const result = await work;
  assert.equal(control.listeners(), 0);
  assert.deepEqual(reads, [0]);
  assert.equal(result.stopReason, "phase-ended");
  assert.equal(result.completedRounds, 1);
});

test("phase cancellation drains an in-flight read before reporting completion", async () => {
  const phase = new AbortController();
  const timer = autoClock();
  let release!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  let calls = 0;
  const work = runMixedReader(
    { roundLimit: 5, pauseMs: 25, sustained: true },
    phase.signal,
    async () => {
      calls++;
      await heldRead;
      timer.advance(50);
    },
    timer,
  ).then((result) => {
    settled = true;
    return result;
  });
  phase.abort();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(calls, 1);
  release();
  const result = await work;
  assert.equal(settled, true);
  assert.equal(result.finishedMs, 150);
  assert.equal(result.completedRounds, 1);
  assert.equal(result.stopReason, "phase-ended");
  assert.deepEqual(timer.pauses, []);
});

test("read failures propagate unchanged with final coverage and no retry", async () => {
  const timer = autoClock();
  const progress = coverage();
  const failure = new Error("Fictional SQL failure");
  let calls = 0;
  await assert.rejects(
    runMixedReader(
      { roundLimit: 5, pauseMs: 25, sustained: true, coverage: progress },
      new AbortController().signal,
      async () => {
        calls++;
        timer.advance(30);
        throw failure;
      },
      timer,
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(calls, 1);
  assert.deepEqual(progress, {
    startedMs: 100,
    finishedMs: 130,
    completedRounds: 0,
    stopReason: "failed",
  });
  assert.deepEqual(timer.pauses, []);
});

test("aborting a phase does not hide a failing in-flight read", async () => {
  const phase = new AbortController();
  const failure = new Error("Fictional pending read failure");
  await assert.rejects(
    runMixedReader(
      { roundLimit: 2, pauseMs: 0, sustained: true },
      phase.signal,
      async () => {
        phase.abort();
        throw failure;
      },
      autoClock(),
    ),
    (error: unknown) => error === failure,
  );
});

test("non-abort timer failures propagate without retry or misclassification", async () => {
  const phase = new AbortController();
  const failure = new Error("Fictional timer failure");
  const timer: MixedClock = {
    now: () => 100,
    sleep: async () => {
      phase.abort();
      throw failure;
    },
  };
  await assert.rejects(
    waitForMixedCycle(100, 1, 2, 100, phase.signal, timer),
    (error: unknown) => error === failure,
  );
  const second = new AbortController();
  const progress = coverage();
  let calls = 0;
  await assert.rejects(
    runMixedReader(
      { roundLimit: 2, pauseMs: 25, sustained: true, coverage: progress },
      second.signal,
      async () => {
        calls++;
      },
      timer,
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(calls, 1);
  assert.equal(progress.completedRounds, 1);
  assert.equal(progress.stopReason, "failed");
});

test("pre-aborted reader records phase end without scheduling reads or timers", async () => {
  const phase = new AbortController();
  phase.abort();
  const timer = autoClock();
  const result = await runMixedReader(
    { roundLimit: 2, pauseMs: 25, sustained: true },
    phase.signal,
    async () => assert.fail("cancelled reader must not execute"),
    timer,
  );
  assert.deepEqual(result, {
    startedMs: 100,
    finishedMs: 100,
    completedRounds: 0,
    stopReason: "phase-ended",
  });
  assert.deepEqual(timer.pauses, []);
});

test("reader rejects unsafe allocation and timer values before any work", async () => {
  const timer = autoClock();
  for (const [roundLimit, pauseMs] of [
    [0, 25],
    [-1, 25],
    [1.5, 25],
    [Number.MAX_SAFE_INTEGER + 1, 25],
    [1, -1],
    [1, 0.5],
    [1, Infinity],
    [1, 2_147_483_648],
  ])
    await assert.rejects(
      runMixedReader(
        { roundLimit, pauseMs, sustained: true },
        new AbortController().signal,
        async () => assert.fail("invalid reader must not execute"),
        timer,
      ),
      category("INVALID_SCHEDULE"),
    );
  assert.deepEqual(timer.pauses, []);
});
