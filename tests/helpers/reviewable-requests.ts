import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyCommand, DomainError } from "../../src/domain/operations";
import type { Command } from "../../src/domain/commands";
import type { ApprovalRequest, Role, Staff } from "../../src/domain/model";
import { filterRequests } from "../../src/domain/request-filters";
import { sortLocalRecords } from "../../src/domain/list-sort";
import { hashPassword, login } from "../../src/server/auth";
import type { Database } from "../../src/server/database";
import { importStore } from "../../src/server/storage";
import { readPage } from "../../src/server/queries";
import { configuredStore } from "./store";

/** Called only by owned in-memory or guarded disposable PostgreSQL test suites. */
export async function exerciseReviewableRequests(db: Database) {
  const branchId = "review_" + randomUUID();
  const actors = Object.fromEntries(
    (["ADMIN", "MANAGER", "CASHIER", "DEALER"] as Role[]).map((role) => [
      role,
      {
        id: `${branchId}_${role}`,
        username: `${branchId}_${role.toLowerCase()}`,
        role,
        branchId,
      },
    ]),
  ) as Record<Role, Staff>;
  const password = "Fictional-review-queue-password";
  const hash = await hashPassword(password);
  await db.query("INSERT INTO poker_branches(id,name) VALUES($1,$1)", [
    branchId,
  ]);
  for (const actor of Object.values(actors)) {
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
      [actor.id, actor.username, hash],
    );
    await db.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
      [actor.id, branchId, actor.role],
    );
  }
  let store = configuredStore();
  let tick = 0;
  const run = (command: Command, actor = actors.ADMIN) => {
    store = applyCommand(
      store,
      command,
      actor,
      new Date(Date.UTC(2026, 10, 5, 2, 0, tick++)).toISOString(),
    );
  };
  run({ kind: "OPEN_DAY", date: "2026-11-04", openingCash: 0 });
  const previousDay = store.currentDayId!;
  run({ kind: "CLOSE_DAY", countedCash: 0, reason: "Fictional earlier day" });
  run({ kind: "OPEN_DAY", date: "2026-11-05", openingCash: 1000000 });
  run({
    kind: "TABLE",
    name: "Sample · Review queue table",
    dealer: "",
    status: "OPEN",
  });
  const request = (
    amount: number,
    actor = actors.CASHIER,
    type: "Rake" | "Cash Payout" = "Rake",
  ) => {
    run(
      {
        kind: "REQUEST",
        type,
        amount,
        tableId: type === "Rake" ? store.tables[0].id : undefined,
        note: "Review queue fictional fixture",
      },
      actor,
    );
    return store.approvals[0].id;
  };
  for (let i = 0; i < 47; i++) request((i + 1) * 1000);
  const adminOwn = request(51000, actors.ADMIN);
  request(52000, actors.MANAGER);
  const adminOnly = request(53000, actors.CASHIER, "Cash Payout");
  const managerVoted = request(2500000);
  run(
    { kind: "DECIDE", approvalId: managerVoted, decision: "APPROVED" },
    actors.MANAGER,
  );
  const adminVoted = request(2600000);
  run({ kind: "DECIDE", approvalId: adminVoted, decision: "APPROVED" });
  const approved = request(54000);
  run({ kind: "DECIDE", approvalId: approved, decision: "APPROVED" });
  const rejected = request(55000);
  run({
    kind: "DECIDE",
    approvalId: rejected,
    decision: "REJECTED",
    reason: "Fictional duplicate",
  });
  await importStore(db, branchId, store, 1);
  const otherBranchId = branchId + "_other";
  await db.query("INSERT INTO poker_branches(id,name) VALUES($1,$1)", [
    otherBranchId,
  ]);
  await importStore(db, otherBranchId, store, 1);
  const tokens = Object.fromEntries(
    await Promise.all(
      Object.values(actors).map(async (actor) => [
        actor.role,
        await login(db, actor.username, password),
      ]),
    ),
  ) as Record<Role, string>;
  for (const actor of Object.values(actors)) {
    for (const query of [undefined, "review queue", "review queue table"]) {
      const filters = { user: actor, userId: actor.id, query };
      const expected = sortLocalRecords(
        "requests",
        filterRequests(store, { ...filters, view: "REVIEWABLE" }),
        "amount",
        "asc",
      );
      const counts = Object.fromEntries(
        (
          ["PENDING", "APPROVED", "REJECTED", "MINE", "REVIEWABLE"] as const
        ).map((view) => [
          view,
          filterRequests(store, { ...filters, view }).length,
        ]),
      );
      for (const requestedPage of [0, 1, 999]) {
        const page = await readPage(db, tokens[actor.role], {
          resource: "requests",
          status: "REVIEWABLE",
          query,
          sort: "amount",
          direction: "asc",
          page: requestedPage,
          pageSize: 20,
        });
        const expectedPage = Math.min(
          requestedPage,
          Math.max(0, Math.ceil(expected.length / 20) - 1),
        );
        assert.equal(page.total, expected.length);
        assert.equal(page.page, expectedPage);
        assert.deepEqual(page.counts, counts);
        assert.deepEqual(
          page.items.map((item) => item.id),
          expected
            .slice(expectedPage * 20, (expectedPage + 1) * 20)
            .map((item) => item.id),
        );
        assert.equal(page.branchId, branchId);
        assert.ok(
          (page.items as ApprovalRequest[]).every(
            (item) => item.dayId === store.currentDayId,
          ),
        );
      }
    }
    const otherDay = await readPage(db, tokens[actor.role], {
      resource: "requests",
      status: "REVIEWABLE",
      dayId: previousDay,
    });
    assert.equal(otherDay.total, 0);
    assert.equal(otherDay.counts.REVIEWABLE, 0);
  }
  const manager = await readPage(db, tokens.MANAGER, {
    resource: "requests",
    status: "REVIEWABLE",
    pageSize: 50,
  });
  assert.equal(manager.total, 49);
  assert.ok(
    !manager.items.some((item) => [managerVoted, adminOnly].includes(item.id)),
  );
  const admin = await readPage(db, tokens.ADMIN, {
    resource: "requests",
    status: "REVIEWABLE",
    pageSize: 50,
  });
  assert.equal(admin.total, 50);
  assert.ok(
    !admin.items.some((item) => [adminOwn, adminVoted].includes(item.id)),
  );
  for (const query of [undefined, "review queue"])
    await assert.rejects(
      readPage(db, tokens.ADMIN, {
        resource: "requests",
        status: "REVIEWABLE",
        id: adminOwn,
        query,
      }),
      (error: unknown) => error instanceof DomainError && error.status === 404,
    );
  // Simulate access changing in a different staff tab while keeping its token.
  await db.query(
    "UPDATE poker_memberships SET role='CASHIER' WHERE user_id=$1 AND branch_id=$2",
    [actors.ADMIN.id, branchId],
  );
  const demoted = await readPage(db, tokens.ADMIN, {
    resource: "requests",
    status: "REVIEWABLE",
    query: "review queue",
  });
  assert.equal(demoted.total, 0);
  assert.equal(demoted.counts.REVIEWABLE, 0);
  assert.equal(demoted.context.user.role, "CASHIER");
  await db.query(
    "UPDATE poker_memberships SET role='ADMIN' WHERE user_id=$1 AND branch_id=$2",
    [actors.ADMIN.id, branchId],
  );
  // The read filter must also honor a day closed by a concurrent/legacy writer.
  await db.query(
    "UPDATE poker_days SET data=jsonb_set(data,'{status}','\"CLOSED\"') WHERE branch_id=$1 AND id=$2",
    [branchId, store.currentDayId],
  );
  try {
    for (const query of [undefined, "review queue"]) {
      const closed = await readPage(db, tokens.ADMIN, {
        resource: "requests",
        status: "REVIEWABLE",
        query,
      });
      assert.equal(closed.total, 0);
      assert.equal(closed.counts.REVIEWABLE, 0);
    }
  } finally {
    await db.query(
      "UPDATE poker_days SET data=jsonb_set(data,'{status}','\"OPEN\"') WHERE branch_id=$1 AND id=$2",
      [branchId, store.currentDayId],
    );
  }
}
