import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackgroundRefresh } from "../src/lib/background-refresh";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("simultaneous timer and focus requests share one pending refresh", async () => {
  const request = deferred();
  let reads = 0;
  const background = createBackgroundRefresh(
    () => {
      reads++;
      return request.promise;
    },
    () => false,
  );
  const first = background();
  const second = background();
  await Promise.resolve();
  assert.equal(first, second);
  assert.equal(reads, 1);
  request.resolve();
  await Promise.all([first, second]);
});

test("a completed background read does not suppress the next polling read", async () => {
  let reads = 0;
  const background = createBackgroundRefresh(
    async () => {
      reads++;
    },
    () => false,
  );
  await background();
  await background();
  assert.equal(reads, 2);
});

test("failed reads release the latch so a later focus can retry", async () => {
  let reads = 0;
  const background = createBackgroundRefresh(
    async () => {
      reads++;
      if (reads === 1) throw new Error("Temporarily unavailable");
    },
    () => false,
  );
  await assert.rejects(background(), /Temporarily unavailable/);
  await background();
  assert.equal(reads, 2);
});

test("background reads are skipped while a mutation is in progress", async () => {
  let busy = true;
  let reads = 0;
  const background = createBackgroundRefresh(
    async () => {
      reads++;
    },
    () => busy,
  );
  await background();
  assert.equal(reads, 0);
  busy = false;
  await background();
  assert.equal(reads, 1);
});

test("a mutation beginning before queued work prevents a background request", async () => {
  let busy = false;
  let reads = 0;
  const background = createBackgroundRefresh(
    async () => {
      reads++;
    },
    () => busy,
  );
  const queued = background();
  busy = true;
  await queued;
  assert.equal(reads, 0);
});

test("explicit refresh remains independent of an older pending background snapshot", async () => {
  const request = deferred();
  let reads = 0;
  const refresh = () => {
    reads++;
    return reads === 1 ? request.promise : Promise.resolve();
  };
  const background = createBackgroundRefresh(refresh, () => false);
  const poll = background();
  await Promise.resolve();
  await refresh();
  assert.equal(reads, 2);
  request.resolve();
  await poll;
});
