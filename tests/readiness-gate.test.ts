import assert from "node:assert/strict";
import { test } from "node:test";
import type { HealthOutcome } from "../src/server/health";
import { createReadinessGate } from "../src/server/readiness-gate";

const ready = { ready: true, mode: "operations" } as const;
const missingSchema = {
  ready: false,
  mode: "operations",
  reason: "SCHEMA",
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
class Clock {
  value = 0;
  private next = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.value;
  schedule = (callback: () => void, delayMs: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.value + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  };
  get pendingTimers() {
    return this.timers.size;
  }
  advance(milliseconds: number) {
    const target = this.value + milliseconds;
    while (true) {
      const first = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      this.value = first[1].at;
      this.timers.delete(first[0]);
      first[1].callback();
    }
    this.value = target;
  }
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function fixture() {
  const clock = new Clock();
  return {
    clock,
    gate: createReadinessGate({ now: clock.now, schedule: clock.schedule }),
  };
}

test("readiness gate accepts only bounded positive integer cache and deadline budgets", () => {
  for (const key of ["ttlMs", "deadlineMs"] as const) {
    for (const value of [0, -1, 0.5, NaN, Infinity, 60001])
      assert.throws(
        () => createReadinessGate({ [key]: value }),
        /integer from 1 to 60000/,
      );
    for (const value of [1, 60000])
      assert.doesNotThrow(() => createReadinessGate({ [key]: value }));
  }
  assert.throws(
    () => createReadinessGate({ now: 1 as unknown as () => number }),
    /must be functions/,
  );
  assert.throws(
    () => createReadinessGate({ schedule: 1 as unknown as () => () => void }),
    /must be functions/,
  );
});

test("a burst shares one probe and serves only coarse immutable metadata during the TTL", async () => {
  const { clock, gate } = fixture();
  const pending = deferred<HealthOutcome>();
  let starts = 0;
  const probe = () => {
    starts++;
    return pending.promise;
  };
  const requests = Array.from({ length: 100 }, () => gate.read("A", probe));
  assert.equal(starts, 1);
  assert.equal(clock.pendingTimers, 1);
  pending.resolve(ready);
  const results = await Promise.all(requests);
  assert.ok(results.every((outcome) => outcome.ready));
  assert.ok(results.every((outcome) => Object.isFrozen(outcome)));
  assert.deepEqual(Object.keys(results[0]).sort(), ["mode", "ready"]);
  assert.equal(clock.pendingTimers, 0);
  clock.advance(999);
  assert.deepEqual(await gate.read("A", probe), ready);
  assert.equal(starts, 1);
  clock.advance(1);
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return missingSchema;
    }),
    missingSchema,
  );
  assert.equal(starts, 2);
});

test("successful cache lifetime starts at probe completion rather than its start", async () => {
  const { clock, gate } = fixture();
  const pending = deferred<HealthOutcome>();
  let starts = 0;
  const request = gate.read("A", () => {
    starts++;
    return pending.promise;
  });
  clock.advance(900);
  pending.resolve(ready);
  assert.deepEqual(await request, ready);
  clock.advance(999);
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return missingSchema;
    }),
    ready,
  );
  assert.equal(starts, 1);
  clock.advance(1);
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return missingSchema;
    }),
    missingSchema,
  );
  assert.equal(starts, 2);
});

test("a failed probe is briefly cached and a fresh result replaces it after expiry", async () => {
  const { clock, gate } = fixture();
  let starts = 0;
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return missingSchema;
    }),
    missingSchema,
  );
  clock.advance(999);
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return ready;
    }),
    missingSchema,
  );
  assert.equal(starts, 1);
  clock.advance(1);
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return ready;
    }),
    ready,
  );
  assert.equal(starts, 2);
});

test("the response deadline fails closed while retaining the only underlying probe slot", async () => {
  const { clock, gate } = fixture();
  const pending = deferred<HealthOutcome>();
  let starts = 0,
    settled = false;
  const request = gate.read("A", () => {
    starts++;
    return pending.promise;
  });
  void request.then(() => {
    settled = true;
  });
  clock.advance(1999);
  await flush();
  assert.equal(settled, false);
  clock.advance(1);
  const timedOut = await request;
  assert.deepEqual(timedOut, {
    ready: false,
    mode: "operations",
    reason: "PROBE_TIMEOUT",
    code: "ETIMEDOUT",
  });
  assert.equal(clock.pendingTimers, 0);
  clock.advance(10000);
  const afterDeadline = await Promise.all(
    Array.from({ length: 100 }, () =>
      gate.read("A", async () => {
        starts++;
        return ready;
      }),
    ),
  );
  assert.ok(
    afterDeadline.every(
      (outcome) => !outcome.ready && outcome.reason === "PROBE_TIMEOUT",
    ),
  );
  assert.equal(
    starts,
    1,
    "An HTTP deadline cannot release a still-running database probe",
  );
  pending.resolve(ready);
  await flush();
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return missingSchema;
    }),
    missingSchema,
  );
  assert.equal(starts, 2, "Late success must not become a new cached success");
});

test("late settlement neither changes a timeout result nor extends its cache lifetime", async () => {
  const { clock, gate } = fixture();
  const pending = deferred<HealthOutcome>();
  let starts = 0;
  const request = gate.read("A", () => {
    starts++;
    return pending.promise;
  });
  clock.advance(2000);
  const timedOut = await request;
  clock.advance(900);
  pending.resolve(ready);
  await flush();
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return ready;
    }),
    timedOut,
  );
  assert.equal(starts, 1);
  clock.advance(100);
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return ready;
    }),
    ready,
  );
  assert.equal(starts, 2);
});

test("a resolved probe cannot beat an overdue deadline whose timer callback has not run", async () => {
  const { clock, gate } = fixture();
  const pending = deferred<HealthOutcome>();
  let starts = 0;
  const request = gate.read("A", () => {
    starts++;
    return pending.promise;
  });
  clock.value = 2500; // Advance monotonic time without delivering queued timers.
  pending.resolve(ready);
  assert.deepEqual(await request, {
    ready: false,
    mode: "operations",
    reason: "PROBE_TIMEOUT",
    code: "ETIMEDOUT",
  });
  assert.equal(clock.pendingTimers, 0);
  clock.value = 3499;
  assert.equal(
    (
      await gate.read("A", async () => {
        starts++;
        return ready;
      })
    ).ready,
    false,
  );
  assert.equal(starts, 1);
  clock.value = 3500;
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return ready;
    }),
    ready,
  );
  assert.equal(starts, 2);
});

test("a caller arriving after the budget resolves waiting callers before overdue timer delivery", async () => {
  const { clock, gate } = fixture();
  const pending = deferred<HealthOutcome>();
  let starts = 0;
  const first = gate.read("A", () => {
    starts++;
    return pending.promise;
  });
  clock.value = 2500;
  const later = await gate.read("A", async () => {
    starts++;
    return ready;
  });
  assert.deepEqual(later, {
    ready: false,
    mode: "operations",
    reason: "PROBE_TIMEOUT",
    code: "ETIMEDOUT",
  });
  assert.deepEqual(await first, later);
  assert.equal(starts, 1);
  assert.equal(clock.pendingTimers, 0);
  clock.value = 5000;
  assert.equal(
    (
      await gate.read("A", async () => {
        starts++;
        return ready;
      })
    ).ready,
    false,
  );
  assert.equal(
    starts,
    1,
    "The late timer must not permit a second underlying probe",
  );
  pending.resolve(ready);
  await flush();
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return missingSchema;
    }),
    missingSchema,
  );
  assert.equal(starts, 2);
});

test("invalid clocks fail closed without starting a new probe or retaining a cached success", async () => {
  for (const value of [NaN, Infinity, -1]) {
    let starts = 0;
    const gate = createReadinessGate({ now: () => value });
    const outcome = await gate.read("A", async () => {
      starts++;
      return ready;
    });
    assert.equal(outcome.ready, false);
    assert.equal(starts, 0);
  }
  const { clock, gate } = fixture();
  assert.deepEqual(await gate.read("A", async () => ready), ready);
  clock.value = -1;
  assert.equal((await gate.read("A", async () => ready)).ready, false);
});

test("a clock that moves backwards while probing cannot acknowledge fresh readiness", async () => {
  const { clock, gate } = fixture();
  const pending = deferred<HealthOutcome>();
  clock.value = 100;
  const request = gate.read("A", () => pending.promise);
  clock.value = 50;
  pending.resolve(ready);
  assert.deepEqual(await request, {
    ready: false,
    mode: "operations",
    reason: "PROBE_TIMEOUT",
    code: "ETIMEDOUT",
  });
  assert.equal(clock.pendingTimers, 0);
});

test("changing the configuration resolves old callers busy and cannot overlap its draining probe", async () => {
  const { clock, gate } = fixture();
  const pending = deferred<HealthOutcome>();
  let starts = 0;
  const old = gate.read("A", () => {
    starts++;
    return pending.promise;
  });
  const changed = await gate.read("B", async () => {
    starts++;
    return ready;
  });
  assert.deepEqual(changed, {
    ready: false,
    mode: "operations",
    reason: "PROBE_BUSY",
  });
  assert.deepEqual(await old, changed);
  assert.equal(starts, 1);
  assert.equal(clock.pendingTimers, 0);
  assert.deepEqual(
    await gate.read("B", async () => {
      starts++;
      return ready;
    }),
    changed,
  );
  pending.resolve(ready);
  await flush();
  assert.deepEqual(
    await gate.read("B", async () => {
      starts++;
      return missingSchema;
    }),
    missingSchema,
  );
  assert.equal(starts, 2);
});

test("an A-to-B-to-A configuration change cannot accept the old A probe after its late completion", async () => {
  const { gate } = fixture();
  const pending = deferred<HealthOutcome>();
  let starts = 0;
  const old = gate.read("A", () => {
    starts++;
    return pending.promise;
  });
  await gate.read("B", async () => {
    starts++;
    return ready;
  });
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return ready;
    }),
    { ready: false, mode: "operations", reason: "PROBE_BUSY" },
  );
  assert.equal((await old).ready, false);
  pending.resolve(ready);
  await flush();
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return missingSchema;
    }),
    missingSchema,
  );
  assert.equal(starts, 2);
});

test("explicit invalidation also prevents stale success when the bypassed configuration never calls read", async () => {
  const { gate } = fixture();
  const pending = deferred<HealthOutcome>();
  let starts = 0;
  const old = gate.read("A", () => {
    starts++;
    return pending.promise;
  });
  gate.invalidate();
  assert.deepEqual(await old, {
    ready: false,
    mode: "operations",
    reason: "PROBE_BUSY",
  });
  gate.invalidate();
  assert.equal(
    (
      await gate.read("A", async () => {
        starts++;
        return ready;
      })
    ).ready,
    false,
  );
  pending.resolve(ready);
  await flush();
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return missingSchema;
    }),
    missingSchema,
  );
  assert.equal(starts, 2);
});

test("only one key is cached and switching back requires another probe", async () => {
  const { gate } = fixture();
  let starts = 0;
  for (const key of ["A", "B", "A"])
    assert.deepEqual(
      await gate.read(key, async () => {
        starts++;
        return ready;
      }),
      ready,
    );
  assert.equal(starts, 3);
});

test("synchronous throws and rejected probes produce bounded generic failures without leaked details", async () => {
  const { clock, gate } = fixture();
  const failure = {
    ready: false,
    mode: "operations",
    reason: "DATABASE",
    code: "UNKNOWN",
  };
  assert.deepEqual(
    await gate.read("A", () => {
      throw new Error("private-password SELECT private-records");
    }),
    failure,
  );
  assert.equal(clock.pendingTimers, 0);
  clock.advance(1000);
  assert.deepEqual(
    await gate.read("A", () =>
      Promise.reject({ message: "private-data", code: "private-code" }),
    ),
    failure,
  );
  assert.equal(clock.pendingTimers, 0);
});

test("cache outcomes cannot retain request IDs, response bodies or mutable query context", async () => {
  const { gate } = fixture();
  const input = {
    ...ready,
    requestId: "private-reference",
    password: "private-password",
    response: Response.json({ privatePlayer: true }),
  };
  const outcome = await gate.read("A", async () => input);
  assert.deepEqual(outcome, ready);
  assert.equal(Reflect.set(outcome, "ready", false), false);
  assert.deepEqual(await gate.read("A", async () => missingSchema), ready);
  gate.invalidate();
  const malformed = await gate.read(
    "A",
    async () =>
      Response.json({ privatePlayer: true }) as unknown as HealthOutcome,
  );
  assert.deepEqual(malformed, {
    ready: false,
    mode: "operations",
    reason: "DATABASE",
    code: "UNKNOWN",
  });
  assert.doesNotMatch(JSON.stringify(malformed), /private/);
});

test("a missing response timer fails closed before starting any database work", async () => {
  let starts = 0;
  const gate = createReadinessGate({
    schedule() {
      throw new Error("Timer unavailable");
    },
  });
  assert.deepEqual(
    await gate.read("A", async () => {
      starts++;
      return ready;
    }),
    {
      ready: false,
      mode: "operations",
      reason: "PROBE_TIMEOUT",
      code: "ETIMEDOUT",
    },
  );
  assert.equal(starts, 0);
});
