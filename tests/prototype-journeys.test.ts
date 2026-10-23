import test from "node:test";
import assert from "node:assert/strict";
import {
  getPrototypeInfo,
  prototypeRequest,
  resetPrototype,
  setPrototypePersona,
  startPrototypeJourney,
} from "../src/prototype/runtime";
import {
  journeyProgress,
  type PrototypeJourneyId,
} from "../src/prototype/journeys";
import type { Snapshot } from "../src/domain/model";
import type { Command } from "../src/domain/commands";

async function snapshot(): Promise<Snapshot> {
  const response = await prototypeRequest("/api/state");
  assert.equal(response.status, 200);
  return response.json();
}

async function act(command: Command) {
  const before = await snapshot();
  const response = await prototypeRequest("/api/state", {
    method: "POST",
    body: JSON.stringify({
      branchId: before.branch.id,
      revision: before.revision,
      operationId: crypto.randomUUID(),
      command,
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result as Snapshot;
}

function nextDate(date: string) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

async function completeJourney(id: PrototypeJourneyId) {
  startPrototypeJourney(id);
  for (let count = 0; count < 10; count++) {
    const before = await snapshot();
    const run = getPrototypeInfo().journey!;
    const progress = journeyProgress(run, before.store, before.branch.id);
    assert.equal(progress.problem, "");
    if (progress.complete) return before;
    const step = progress.current!;
    setPrototypePersona(step.persona);
    const action = step.action;
    if (action.kind === "check-in") {
      const player = before.store.profiles.find(
        (profile) => profile.id === run.playerId,
      )!;
      await act({
        kind: "CHECK_IN",
        playerId: player.id,
        name: player.name,
        phone: player.phone,
        type: player.type,
        creditLimit: player.creditLimit,
        tags: player.tags,
        tableId: run.tableId,
        seat: 1,
      });
    } else if (action.kind === "request") {
      await act({
        kind: "REQUEST",
        type: action.type,
        amount: action.amount,
        ...(run.playerId
          ? { playerId: run.playerId }
          : { tableId: run.tableId }),
        note: "Fictional guided workflow regression",
      });
    } else if (action.kind === "review") {
      await act({
        kind: "DECIDE",
        approvalId: action.requestId,
        decision: action.reject ? "REJECTED" : "APPROVED",
        ...(action.reject ? { reason: "Duplicate rake entry" } : {}),
      });
    } else if (action.kind === "reversal") {
      await act({
        kind: "CORRECT",
        transactionId: action.transactionId,
        reason: "Correct the fictional original amount",
      });
    } else {
      await act({
        kind: "CLOSE_DAY",
        dayId: run.dayId,
        countedCash: action.countedCash,
        reason: id === "exceptions" ? "Fictional RM10 shortage" : "",
      });
    }
  }
  assert.fail("The guided workflow did not reach its completed closing step.");
}

for (const id of ["cash", "credit", "exceptions"] as const) {
  test(`the completed ${id} guide stays complete after opening the next business day`, async () => {
    try {
      const closed = await completeJourney(id);
      const run = getPrototypeInfo().journey!;
      const originalDay = closed.store.days.find(
        (day) => day.id === run.dayId,
      )!;
      const before = journeyProgress(run, closed.store, closed.branch.id);
      assert.equal(before.complete, true);
      assert.equal(
        before.expectedCash,
        id === "exceptions" ? 2003000 : 1980000,
      );

      setPrototypePersona("admin");
      const opened = await act({
        kind: "OPEN_DAY",
        date: nextDate(originalDay.date),
        openingCash: 1234500,
      });
      assert.notEqual(opened.store.currentDayId, run.dayId);
      assert.equal(getPrototypeInfo().journey!.dayId, originalDay.id);
      const after = journeyProgress(
        getPrototypeInfo().journey!,
        opened.store,
        opened.branch.id,
      );
      assert.equal(after.complete, true);
      assert.equal(after.problem, "");
      assert.equal(after.current, null);
      assert.equal(after.expectedCash, before.expectedCash);
      assert.equal(
        after.steps.length,
        id === "cash" ? 6 : id === "credit" ? 8 : 9,
      );
      assert.ok(after.steps.every((step) => step.complete));
    } finally {
      resetPrototype("busy");
    }
  });
}

test("an unfinished guide still requires a restart if a different business day opens", async () => {
  try {
    startPrototypeJourney("cash");
    const run = getPrototypeInfo().journey!;
    const initial = await snapshot();
    const originalDay = initial.store.days.find((day) => day.id === run.dayId)!;
    setPrototypePersona("admin");
    await act({
      kind: "CLOSE_DAY",
      dayId: run.dayId,
      countedCash: originalDay.openingCash,
      reason: "Close without completing the fictional guide",
    });
    const opened = await act({
      kind: "OPEN_DAY",
      date: nextDate(originalDay.date),
      openingCash: 1234500,
    });
    const progress = journeyProgress(run, opened.store, opened.branch.id);
    assert.equal(progress.complete, false);
    assert.match(progress.problem, /business day changed/i);
  } finally {
    resetPrototype("busy");
  }
});

test("a completed guide rejects missing bound-day records", async () => {
  try {
    const closed = await completeJourney("cash");
    const run = getPrototypeInfo().journey!;
    const missing = structuredClone(closed.store);
    missing.days = missing.days.filter((day) => day.id !== run.dayId);
    const progress = journeyProgress(run, missing, closed.branch.id);
    assert.equal(progress.complete, false);
    assert.match(progress.problem, /business day changed/i);
  } finally {
    resetPrototype("busy");
  }
});
