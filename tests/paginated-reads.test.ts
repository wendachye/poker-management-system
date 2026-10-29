import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { buildSampleStore } from "../scripts/sample-data";
import { changeBranch, hashPassword, login } from "../src/server/auth";
import { importStore } from "../src/server/storage";
import {
  readCsv,
  readOperationalSnapshot,
  readPage,
  parseReadQuery,
} from "../src/server/queries";
import { checkedTotal, dayTotals } from "../src/server/aggregates";
import type {
  Player,
  Role,
  Staff,
  Store,
  Transaction,
} from "../src/domain/model";
import { debt, playersForDay, totalsForDay } from "../src/domain/selectors";
import { compareReports } from "../src/domain/reporting";
import { dashboardSummary } from "../src/domain/dashboard-summary";
import { approvalNotifications } from "../src/domain/approval-notifications";
import { DomainError } from "../src/domain/operations";
import { ledgerImpact } from "../src/domain/ledger-impact";
import type { ExportAccess } from "../src/lib/export-access";
import type { Database } from "../src/server/database";
import { applyCommand } from "../src/domain/operations";
import type { Command } from "../src/domain/commands";
import { displayName } from "../src/lib/display-name";
import { csv as moneyCsv } from "../src/domain/money";

test("read inputs and aggregate conversions reject invalid or unbounded requests", () => {
  for (const input of [
    { resource: "all" },
    { resource: "players", pageSize: 51 },
    { resource: "players", page: -1 },
    { resource: "audit", from: "2026-02-30" },
    { resource: "report", date: "0000-01-01" },
    { resource: "players", query: "x".repeat(201) },
    { resource: "players", branchId: "other" },
  ])
    assert.throws(() => parseReadQuery(input), DomainError);
  assert.deepEqual(parseReadQuery({ resource: "players" }), {
    resource: "players",
    page: 0,
    pageSize: 20,
  });
  for (const value of ["9007199254740992", Infinity, null, "not-an-amount"])
    assert.throws(() => checkedTotal(value), DomainError);
  assert.equal(
    dayTotals(
      {
        id: "test",
        date: "2026-10-28",
        openedAt: "2026-10-28T00:00:00Z",
        status: "OPEN",
        closes: [],
        openingCash: Number.MAX_SAFE_INTEGER,
      },
      { cashReceived: "2", cashPayout: "2" },
    ).expectedCash,
    Number.MAX_SAFE_INTEGER,
  );
});

async function fixture() {
  const { db, engine } = await testDatabase();
  const actors = Object.fromEntries(
    ["admin", "manager", "cashier", "dealer"].map((name) => [
      name,
      {
        id: name,
        username: name,
        role: name.toUpperCase() as Role,
        branchId: "local",
      },
    ]),
  ) as Record<"admin" | "manager" | "cashier" | "dealer", Staff>;
  const password = "paginated-read-sample-password",
    hash = await hashPassword(password);
  for (const actor of Object.values(actors)) {
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
      [actor.id, actor.username, hash],
    );
    for (const branch of ["local", "other"])
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [actor.id, branch, actor.role],
      );
  }
  const store = buildSampleStore(actors, new Date("2026-10-28T05:00:00Z"));
  for (let i = 0; i < 45; i++)
    store.profiles.push({
      id: `extra-${i}`,
      name: i === 44 ? "José Pagination Final" : "Directory person " + i,
      phone: "+1202556" + String(i).padStart(4, "0"),
      type: "CREDIT",
      creditLimit: 100000,
      tags: i === 44 ? ["VIP"] : [],
    });
  const original = store.transactions.find((tx) => tx.type === "Rake")!;
  const approved = store.approvals.find(
    (request) => request.id === original.approvalId,
  )!;
  for (let i = 0; i < 1200; i++) {
    const approvalId =
        i === 777 ? "history-approval-8765432109" : "history-approval-" + i,
      txId = i === 777 ? "history-tx-9876543210" : "history-tx-" + i;
    store.approvals.push({
      ...structuredClone(approved),
      id: approvalId,
      ...(i === 777 ? { note: "Café résumé control" } : {}),
    });
    store.transactions.push({
      ...structuredClone(original),
      id: txId,
      approvalId,
      ...(i === 777 ? { note: "Café résumé control" } : {}),
    });
    store.auditLogs.push({
      ...structuredClone(store.auditLogs[0]),
      id: "history-log-" + i,
      entity: txId,
      ...(i === 777 ? { reason: "Café résumé audit" } : {}),
    });
  }
  await importStore(db, "local", store, 70);
  return {
    db,
    engine,
    store,
    actors,
    token: await login(db, "admin", password),
    dealer: await login(db, "dealer", password),
  };
}
function sameMoney(actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected);
}

const projectionMarker = "daily_csv_participant_projection";

async function denseCsvFixture() {
  const base = await fixture();
  let store = base.store;
  for (let index = store.profiles.length; index < 401; index++)
    store.profiles.push({
      id: "dense-profile-" + String(index).padStart(4, "0"),
      name: "Dense export player " + index,
      phone: "+1202557" + String(index).padStart(4, "0"),
      type: index % 2 ? "CREDIT" : "CASH",
      creditLimit: 100000,
      tags: [],
    });
  for (const day of store.days)
    for (const [index, profile] of store.profiles.entries())
      if (
        !store.sessions.some(
          (visit) => visit.playerId === profile.id && visit.dayId === day.id,
        )
      )
        store.sessions.push({
          id: "dense-visit-" + day.id + "-" + profile.id,
          playerId: profile.id,
          dayId: day.id,
          tableId: store.tables[2].id,
          seat: (index % 9) + 1,
          status: "OUT",
          sessionStart: day.date + "T01:00:00Z",
          sessionEnd: day.date + "T01:30:00Z",
        });
  store.settings = { ...store.settings!, minBuyIn: 1, buyInStep: 0 };
  let timestamp = Date.parse("2026-10-28T06:00:00Z");
  const run = (command: Command, actor = base.actors.admin) => {
    store = applyCommand(
      store,
      command,
      actor,
      new Date((timestamp += 1000)).toISOString(),
    );
  };
  const post = (command: Command) => {
    run(command, base.actors.cashier);
    const approvalId = store.approvals[0].id;
    run({ kind: "DECIDE", approvalId, decision: "APPROVED" });
    if (
      store.approvals.find((request) => request.id === approvalId)?.status ===
      "PENDING"
    )
      run(
        { kind: "DECIDE", approvalId, decision: "APPROVED" },
        base.actors.manager,
      );
  };
  for (const [seat, index] of [200, 201, 202].entries()) {
    const profile = store.profiles[index];
    run(
      {
        kind: "CHECK_IN",
        playerId: profile.id,
        name: profile.name,
        phone: profile.phone,
        type: profile.type,
        creditLimit: profile.creditLimit,
        tags: [],
        tableId: store.tables[2].id,
        seat: seat + 1,
      },
      base.actors.manager,
    );
    post({
      kind: "REQUEST",
      type: "Buy-in",
      playerId: profile.id,
      amount: index === 200 ? 20001 : index === 201 ? 23457 : 34567,
      note: "Exact-sen export fixture",
    });
    if (index === 202) continue;
    post({
      kind: "REQUEST",
      type: "Cash-out",
      playerId: profile.id,
      amount: index === 200 ? 31003 : 34569,
      note: "Export settlement",
    });
    if (index === 200) {
      post({
        kind: "CORRECT",
        transactionId: store.transactions[0].id,
        reason: "Reverse the incorrect export fixture payout",
      });
      post({
        kind: "REQUEST",
        type: "Cash-out",
        playerId: profile.id,
        amount: 21003,
        note: "Corrected exact-sen payout",
      });
    }
  }
  store.profiles.at(-1)!.name = "=2+3";
  await importStore(base.db, "local", store);
  return { ...base, store };
}

async function completeJsonReport(db: Database, token: string, date: string) {
  const first = await readPage(db, token, {
    resource: "report",
    date,
    pageSize: 50,
  });
  const players = first.items as Player[];
  for (let page = 1; page < Math.ceil(first.total / 50); page++)
    players.push(
      ...((
        await readPage(db, token, {
          resource: "report",
          date,
          pageSize: 50,
          page,
        })
      ).items as Player[]),
    );
  return players;
}

function playerCsv(players: Player[]) {
  return moneyCsv(
    players.map((player) => [
      displayName(player.name),
      player.buyIn / 100,
      player.cashOut / 100,
      player.status === "ACTIVE"
        ? "Unsettled"
        : (player.cashOut - player.buyIn) / 100,
      player.status,
    ]),
  );
}

function csvPlayerSection(value: string) {
  const header = '"Player","Buy-in","Cash-out","Settled P/L","Status"\r\n';
  const position = value.indexOf(header);
  assert.ok(position >= 0);
  return value.slice(position + header.length);
}
test("indexed paginated reads preserve complete money, search, context and export semantics", async (t) => {
  const { db, engine, store, actors, token, dealer } = await fixture();
  const exportAccess: ExportAccess = {
    actorId: actors.admin.id,
    branchId: actors.admin.branchId,
    role: actors.admin.role,
  };
  try {
    await t.test(
      "bootstrap omits lifetime history but retains exact totals, balances and notification counts",
      async () => {
        const snapshot = await readOperationalSnapshot(db, token);
        assert.ok(
          snapshot.store.transactions.length < store.transactions.length / 10,
        );
        assert.equal(snapshot.store.auditLogs.length, 0);
        assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 200000);
        sameMoney(totalsForDay(snapshot.store), totalsForDay(store));
        sameMoney(dashboardSummary(snapshot.store), dashboardSummary(store));
        assert.equal(
          approvalNotifications(snapshot.store, actors.admin).total,
          approvalNotifications(store, actors.admin).total,
        );
        assert.equal(
          approvalNotifications(snapshot.store, actors.admin).reviewable,
          approvalNotifications(store, actors.admin).reviewable,
        );
        for (const profile of snapshot.store.profiles)
          assert.equal(
            debt(snapshot.store, profile.id),
            debt(store, profile.id),
          );
        const metadata = (
          await db.query<{ data: Record<string, unknown> }>(
            "SELECT data FROM poker_branch_state WHERE branch_id='local'",
          )
        ).rows[0].data;
        assert.equal(metadata.storageVersion, 2);
        assert.equal("transactions" in metadata, false);
        assert.equal("profiles" in metadata, false);
      },
    );
    await t.test(
      "player pages are exhaustive, non-overlapping, clamped and filtered on the server",
      async () => {
        const ids: string[] = [];
        for (
          let page = 0;
          page < Math.ceil(store.profiles.length / 20);
          page++
        ) {
          const result = await readPage(db, token, {
            resource: "players",
            page,
          });
          assert.equal(result.total, store.profiles.length);
          assert.ok(result.items.length <= 20);
          assert.equal("rows" in result, false);
          ids.push(...result.items.map((item) => item.id));
        }
        assert.equal(new Set(ids).size, store.profiles.length);
        const last = await readPage(db, token, {
          resource: "players",
          page: 999,
        });
        assert.equal(last.page, Math.ceil(store.profiles.length / 20) - 1);
        const search = await readPage(db, token, {
          resource: "players",
          query: "jose final",
          tag: "VIP",
          type: "CREDIT",
        });
        assert.equal(search.total, 1);
        assert.equal(search.items[0].id, "extra-44");
        assert.equal(search.counts.ALL, 1);
        const phone = await readPage(db, token, {
          resource: "players",
          query: "+1 (202) 556-0044",
        });
        assert.equal(phone.total, 1);
        assert.equal(phone.items[0].id, "extra-44");
        for (const query of [
          "  PÁGINATION\t JOSE   FINAL  ",
          "José 0044",
          "202 556 0044",
        ]) {
          const normalized = await readPage(db, token, {
            resource: "players",
            query,
          });
          assert.equal(normalized.total, 1);
          assert.equal(normalized.items[0].id, "extra-44");
        }
        for (const query of ["%", "_", "(12)"])
          assert.equal(
            (await readPage(db, token, { resource: "players", query })).total,
            0,
            "Search punctuation stays literal: " + query,
          );
        assert.equal(
          (
            await readPage(db, token, {
              resource: "players",
              query: "%_'; DROP TABLE poker_profiles;--",
            })
          ).total,
          0,
        );
      },
    );
    await t.test(
      "numeric references find house receipts and requests while formatted phone search still works",
      async () => {
        const receipt = store.transactions.find(
          (row) => row.id === "history-tx-9876543210",
        )!;
        assert.equal(receipt.playerId, undefined);
        const byReceipt = await readPage(db, token, {
          resource: "transactions",
          query: "9876543210",
        });
        assert.equal(byReceipt.total, 1);
        assert.equal(byReceipt.items[0].id, receipt.id);
        const byRequest = await readPage(db, token, {
          resource: "requests",
          query: "8765432109",
        });
        assert.equal(byRequest.total, 1);
        assert.equal(byRequest.items[0].id, receipt.approvalId);

        const player = store.profiles.find((profile) =>
          store.transactions.some((row) => row.playerId === profile.id),
        )!;
        const byPhone = await readPage(db, token, {
          resource: "transactions",
          query: player.phone.replace(/(\d{3})(?=\d)/g, "$1 "),
        });
        assert.equal(
          byPhone.total,
          store.transactions.filter((row) => row.playerId === player.id).length,
        );
        assert.ok(byPhone.total > 0);
        assert.ok(
          byPhone.items.every(
            (row) => "playerId" in row && row.playerId === player.id,
          ),
        );
      },
    );
    await t.test(
      "joined history search preserves accents, receipt references and literal numeric punctuation",
      async () => {
        for (const resource of ["requests", "transactions", "audit"] as const) {
          const found = await readPage(db, token, {
            resource,
            query: "  CAFE\t RÉSUMÉ  ",
            page: 1_000_000,
          });
          assert.equal(found.total, 1);
          assert.equal(found.page, 0);
          assert.equal(
            found.items[0].id,
            resource === "requests"
              ? "history-approval-8765432109"
              : resource === "transactions"
                ? "history-tx-9876543210"
                : "history-log-777",
          );
        }
        for (const resource of ["requests", "transactions"] as const) {
          const acrossFields = await readPage(db, token, {
            resource,
            query: "cafe 9876543210",
          });
          assert.equal(acrossFields.total, 1);
          assert.equal(acrossFields.counts.APPROVED, 1);
          assert.equal(acrossFields.counts.PENDING, 0);
          assert.equal(
            (
              await readPage(db, token, {
                resource,
                query: "987-654-3210",
              })
            ).total,
            0,
            "A formatted number must not rewrite a house receipt reference",
          );
        }
        assert.equal(
          (
            await readPage(db, token, {
              resource: "requests",
              query: "cafe missing-term",
            })
          ).total,
          0,
          "All search tokens must match, even when they span joined fields",
        );
        const approval = store.approvals.find(
          (row) => row.id === "history-approval-8765432109",
        )!;
        const expectedCounts = {
          APPROVED: 1,
          PENDING: 0,
          REJECTED: 0,
          MINE: Number(approval.requestedById === actors.admin.id),
        };
        for (const status of ["APPROVED", "PENDING", "MINE"] as const) {
          const found = await readPage(db, token, {
            resource: "requests",
            query: "cafe",
            status,
            page: 1_000_000,
          });
          assert.deepEqual(found.counts, expectedCounts);
          assert.equal(found.total, expectedCounts[status]);
          assert.equal(found.page, 0);
          assert.deepEqual(
            found.items.map((row) => row.id),
            expectedCounts[status] ? [approval.id] : [],
          );
        }
        const selected = await readPage(db, token, {
          resource: "requests",
          query: "cafe",
          id: approval.id,
          status: "PENDING",
          page: 1_000_000,
        });
        assert.deepEqual(selected.counts, expectedCounts);
        assert.equal(selected.total, 1);
        assert.equal(selected.page, 0);
        assert.equal(selected.items[0].id, approval.id);
        const receipt = await readPage(db, token, {
          resource: "receipt",
          query: "cafe",
          id: "history-tx-9876543210",
          page: 1_000_000,
        });
        assert.deepEqual(receipt.counts, expectedCounts);
        assert.equal(receipt.total, 1);
        assert.equal(receipt.page, 0);
        assert.equal(receipt.items[0].id, "history-tx-9876543210");
        assert.ok(
          receipt.context.store.approvals.some((row) => row.id === approval.id),
        );
        for (const resource of ["requests", "receipt"] as const)
          await assert.rejects(
            readPage(db, token, {
              resource,
              query: "cafe",
              id: "missing-reference",
            }),
            (error: unknown) =>
              error instanceof DomainError && error.status === 404,
          );
      },
    );
    await t.test(
      "request tab counts stay exact before status and detail filters",
      async () => {
        const expectedCounts = {
          PENDING: store.approvals.filter((row) => row.status === "PENDING")
            .length,
          APPROVED: store.approvals.filter((row) => row.status === "APPROVED")
            .length,
          REJECTED: store.approvals.filter((row) => row.status === "REJECTED")
            .length,
          MINE: store.approvals.filter(
            (row) => row.requestedById === actors.admin.id,
          ).length,
        };
        assert.ok(expectedCounts.PENDING > 0);
        assert.ok(expectedCounts.REJECTED > 0);
        for (const status of [
          "PENDING",
          "APPROVED",
          "REJECTED",
          "MINE",
        ] as const) {
          const expected = store.approvals.filter((row) =>
            status === "MINE"
              ? row.requestedById === actors.admin.id
              : row.status === status,
          );
          const found = await readPage(db, token, {
            resource: "requests",
            status,
          });
          assert.deepEqual(found.counts, expectedCounts);
          assert.equal(found.total, expectedCounts[status]);
          assert.deepEqual(
            found.items.map((row) => row.id),
            expected.slice(0, 20).map((row) => row.id),
          );
        }
        const selected = await readPage(db, token, {
          resource: "requests",
          id: store.approvals.at(-1)!.id,
        });
        assert.equal(selected.total, 1);
        assert.deepEqual(selected.counts, expectedCounts);
        const filteredRows = store.approvals.filter(
          (row) => row.dayId === store.currentDayId && row.type === "Rake",
        );
        const filtered = await readPage(db, token, {
          resource: "requests",
          dayId: store.currentDayId!,
          type: "Rake",
          status: "PENDING",
        });
        for (const status of ["PENDING", "APPROVED", "REJECTED"] as const)
          assert.equal(
            filtered.counts[status],
            filteredRows.filter((row) => row.status === status).length,
          );
      },
    );
    await t.test(
      "repayment and player detail lookup use complete carried debt rather than a ledger page",
      async () => {
        const owing = await readPage(db, token, {
          resource: "players",
          type: "CREDIT",
          status: "OWING",
        });
        const expected = store.profiles.filter(
          (profile) => profile.type === "CREDIT" && debt(store, profile.id) > 0,
        );
        assert.equal(owing.total, expected.length);
        for (const item of owing.items) {
          assert.ok("creditUsed" in item);
          assert.equal(item.creditUsed, debt(store, item.id));
        }
        const profile = expected[0];
        const result = await readPage(db, token, {
          resource: "player",
          playerId: profile.id,
        });
        assert.deepEqual(
          result.items[0],
          playersForDay(store).find((player) => player.id === profile.id),
        );
        sameMoney(
          ledgerImpact(result.context.store, {
            type: "Cash-out",
            amount: 90000,
            playerId: profile.id,
          }),
          ledgerImpact(store, {
            type: "Cash-out",
            amount: 90000,
            playerId: profile.id,
          }),
        );
      },
    );
    await t.test(
      "request and receipt pages include their originals, identities and exact tab counts",
      async () => {
        const approved = store.approvals.filter(
          (request) => request.status === "APPROVED",
        );
        const result = await readPage(db, token, {
          resource: "transactions",
          status: "APPROVED",
          page: 2,
        });
        assert.equal(result.total, store.transactions.length);
        assert.equal(result.counts.APPROVED, approved.length);
        assert.equal(result.items.length, 20);
        const receipt = await readPage(db, token, {
          resource: "receipt",
          id: store.transactions.at(-1)!.id,
        });
        assert.equal(receipt.items.length, 1);
        const pending = await readPage(db, token, {
          resource: "requests",
          status: "PENDING",
        });
        assert.equal(
          pending.total,
          store.approvals.filter((request) => request.status === "PENDING")
            .length,
        );
        const rejected = store.approvals.find(
          (request) => request.status === "REJECTED",
        );
        if (rejected) {
          const request = await readPage(db, token, {
            resource: "requests",
            id: rejected.id,
          });
          assert.equal(request.items[0].id, rejected.id);
        }
        const original = result.items[0] as Transaction;
        const search = await readPage(db, token, {
          resource: "transactions",
          query: original.id,
        });
        assert.equal(search.total, 1);
      },
    );
    await t.test(
      "CSV access is required and bound before any operational report reads",
      async () => {
        const statements: string[] = [];
        const observedDb: Database = {
          ...db,
          transaction: (work) =>
            db.transaction((connection) =>
              work({
                query<T>(sql: string, values?: unknown[]) {
                  statements.push(sql);
                  return connection.query<T>(sql, values);
                },
              }),
            ),
        };
        const report = { resource: "report", date: store.days[0].date };
        async function denied(
          expected: unknown,
          status: number,
          message: string,
          authenticatedToken = token,
        ) {
          statements.length = 0;
          await assert.rejects(
            readCsv(
              observedDb,
              authenticatedToken,
              report,
              expected as ExportAccess,
            ),
            (error: unknown) => {
              assert.ok(error instanceof DomainError);
              assert.equal(error.status, status);
              assert.equal(error.message, message);
              return true;
            },
          );
          assert.match(statements[0], /REPEATABLE READ READ ONLY/);
          if (authenticatedToken === token)
            assert.ok(statements.some((sql) => sql.includes("poker_sessions")));
          assert.equal(
            statements.some((sql) =>
              /\b(?:poker_branch_state|poker_profiles|poker_visits|poker_days|poker_ledger|poker_approvals|poker_audit)\b/.test(
                sql,
              ),
            ),
            false,
            "identity must be bound before accessing operational records",
          );
        }
        for (const malformed of [
          undefined,
          null,
          {},
          { ...exportAccess, actorId: "" },
          { ...exportAccess, branchId: " " },
          { ...exportAccess, role: "OWNER" },
          { ...exportAccess, extra: "not-allowed" },
        ])
          await denied(malformed, 400, "Reload the report before exporting.");
        for (const mismatch of [
          { ...exportAccess, actorId: actors.manager.id },
          { ...exportAccess, branchId: "other" },
          { ...exportAccess, role: "MANAGER" },
          { ...exportAccess, actorId: exportAccess.actorId + " " },
        ])
          await denied(
            mismatch,
            409,
            "Staff access or venue changed. Refresh the report before exporting.",
          );
        await denied(
          undefined,
          401,
          "Your session has expired. Sign in again.",
          "forged",
        );
      },
    );
    await t.test(
      "historical daily reports and complete CSV remain independent of visible page filters",
      async () => {
        const day = store.days[0];
        const result = await readPage(db, token, {
          resource: "report",
          date: day.date,
          pageSize: 1,
        });
        sameMoney(result.totals, totalsForDay(store, day.id));
        assert.equal(result.day?.id, day.id);
        const expected = playersForDay(store, day.id).filter((player) =>
          store.sessions.some(
            (session) =>
              session.dayId === day.id && session.playerId === player.id,
          ),
        );
        assert.equal(result.total, expected.length);
        const exported = await readCsv(
          db,
          token,
          {
            resource: "report",
            date: day.date,
            pageSize: 1,
            page: 999999,
            query: "no rows should match",
            status: "OUT",
            type: "CASH",
            tag: "VIP",
            staff: "nobody",
            action: "nothing",
          },
          exportAccess,
        );
        assert.deepEqual(exported.access, exportAccess);
        assert.ok(exported.value.includes('"Player","Buy-in","Cash-out"'));
        for (const player of expected)
          assert.ok(
            exported.value.includes(player.name.replace(/^Sample\s*·\s*/, "")),
          );
        const from = store.days[0].date,
          to = store.days.at(-1)!.date;
        const range = await readPage(db, token, {
          resource: "range",
          from,
          to,
          pageSize: 1,
          status: "CLOSED",
        });
        sameMoney(range.report, compareReports(store, from, to));
        assert.equal(range.items.length, 1);
        const csv = await readCsv(
          db,
          token,
          {
            resource: "range",
            from,
            to,
            query: "nothing",
            pageSize: 1,
            status: "CLOSED",
          },
          exportAccess,
        );
        assert.deepEqual(csv.access, exportAccess);
        for (const day of store.days) assert.ok(csv.value.includes(day.date));
      },
    );
    await t.test(
      "CSV venue switching rejects stale access and cannot select another venue's day",
      async () => {
        const switched = await login(
          db,
          "admin",
          "paginated-read-sample-password",
        );
        await changeBranch(db, switched, "other");
        const day = store.days[0];
        await assert.rejects(
          readCsv(
            db,
            switched,
            { resource: "report", dayId: day.id },
            exportAccess,
          ),
          (error: unknown) => {
            assert.ok(error instanceof DomainError);
            assert.equal(error.status, 409);
            assert.equal(
              error.message,
              "Staff access or venue changed. Refresh the report before exporting.",
            );
            return true;
          },
        );
        const otherAccess = { ...exportAccess, branchId: "other" };
        await assert.rejects(
          readCsv(
            db,
            switched,
            { resource: "report", dayId: day.id },
            otherAccess,
          ),
          (error: unknown) =>
            error instanceof DomainError && error.status === 404,
        );
        const empty = await readCsv(
          db,
          switched,
          {
            resource: "range",
            from: day.date,
            to: store.days.at(-1)!.date,
          },
          otherAccess,
        );
        assert.deepEqual(empty.access, otherAccess);
        assert.ok(empty.value.includes('"Branch","other"'));
        assert.ok(
          empty.value.includes(
            '"Recorded days","0","Comparison recorded days","0"',
          ),
        );
      },
    );
    await t.test(
      "session and audit lists are bounded, venue-local and permission checked",
      async () => {
        const profile = store.profiles[0];
        const sessions = await readPage(db, token, {
          resource: "sessions",
          playerId: profile.id,
          pageSize: 1,
        });
        assert.ok(sessions.items.length <= 1);
        assert.equal(
          sessions.total,
          store.sessions.filter((session) => session.playerId === profile.id)
            .length,
        );
        const audit = await readPage(db, token, {
          resource: "audit",
          pageSize: 10,
          staff: "admin",
        });
        assert.ok(audit.items.length <= 10);
        assert.ok(audit.options?.staff?.includes("admin"));
        assert.ok(
          audit.items.every(
            (item) => "actor" in item && item.actor === "admin",
          ),
        );
        await assert.rejects(
          readPage(db, dealer, { resource: "audit" }),
          (error: unknown) =>
            error instanceof DomainError && error.status === 403,
        );
        await assert.rejects(
          readPage(db, "forged", { resource: "players" }),
          (error: unknown) =>
            error instanceof DomainError && error.status === 401,
        );
        const otherToken = await login(
          db,
          "manager",
          "paginated-read-sample-password",
        );
        const { changeBranch } = await import("../src/server/auth");
        await changeBranch(db, otherToken, "other");
        assert.equal(
          (await readPage(db, otherToken, { resource: "players" })).total,
          0,
        );
        await assert.rejects(
          readPage(db, otherToken, {
            resource: "receipt",
            id: store.transactions[0].id,
          }),
          (error: unknown) =>
            error instanceof DomainError && error.status === 404,
        );
      },
    );
    await t.test(
      "history pages preserve exact ordering, tied keys and high or empty page clamping",
      async () => {
        for (const { resource, table, ids } of [
          {
            resource: "requests",
            table: "poker_approvals",
            ids: store.approvals.map((row) => row.id),
          },
          {
            resource: "transactions",
            table: "poker_ledger",
            ids: store.transactions.map((row) => row.id),
          },
          {
            resource: "audit",
            table: "poker_audit",
            ids: store.auditLogs.map((row) => row.id),
          },
        ] as const) {
          const lastPage = Math.ceil(ids.length / 20) - 1;
          for (const requested of [0, 1, 1_000_000]) {
            const page = await readPage(db, token, {
              resource,
              page: requested,
            });
            const expectedPage = Math.min(requested, lastPage);
            assert.equal(page.total, ids.length);
            assert.equal(page.page, expectedPage);
            assert.deepEqual(
              page.items.map((row) => row.id),
              ids.slice(expectedPage * 20, expectedPage * 20 + 20),
              resource + " preserves authoritative list order",
            );
          }

          // These columns are intentionally not unique. A second key must keep
          // adjacent pages deterministic even if imported records share one.
          const tiedIds = ids.slice(-3);
          await db.query(
            `UPDATE ${table} SET order_no=-1 WHERE branch_id=$1 AND id=ANY($2::text[])`,
            ["local", tiedIds],
          );
          const ordered = [
            ...[...tiedIds].sort(),
            ...ids.filter((id) => !tiedIds.includes(id)),
          ];
          const shown: string[] = [];
          for (const requested of [0, 1]) {
            const page = await readPage(db, token, {
              resource,
              page: requested,
            });
            const actual = page.items.map((row) => row.id);
            assert.equal(page.total, ids.length);
            assert.deepEqual(
              actual,
              ordered.slice(requested * 20, requested * 20 + 20),
            );
            shown.push(...actual);
          }
          assert.equal(new Set(shown).size, shown.length);

          const empty = await readPage(db, token, {
            resource,
            page: 1_000_000,
            query: "zzzz-unmatched-pagination-sentinel-20261029",
          });
          assert.equal(empty.total, 0);
          assert.equal(empty.page, 0);
          assert.deepEqual(empty.items, []);
          assert.equal(empty.pageSize, 20);
        }
      },
    );
  } finally {
    await engine.close();
  }
});

test("complete daily CSV uses one bounded participant projection without repeating operational context", async (t) => {
  const { db, engine, store, token, actors } = await denseCsvFixture();
  const expectedAccess: ExportAccess = {
    actorId: actors.admin.id,
    branchId: "local",
    role: "ADMIN",
  };
  const statements: string[] = [];
  const observed: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((connection) =>
        work({
          query<T>(sql: string, values?: unknown[]) {
            statements.push(sql);
            return connection.query<T>(sql, values);
          },
        }),
      ),
  };
  try {
    await t.test(
      "50, 51, 101 and 401 historical participants preserve every row in order",
      async () => {
        const historical = store.days[0];
        for (const count of [50, 51, 101, 401]) {
          const subset: Store = structuredClone(store);
          const allowed = new Set(
            subset.profiles.slice(0, count).map((profile) => profile.id),
          );
          subset.sessions = subset.sessions.filter(
            (visit) =>
              visit.dayId !== historical.id || allowed.has(visit.playerId),
          );
          await importStore(db, "local", subset);
          statements.length = 0;
          const result = await readCsv(
            observed,
            token,
            {
              resource: "report",
              date: historical.date,
              query: "matches-no-visible-rows",
              page: 999999,
              pageSize: 1,
            },
            expectedAccess,
          );
          const queryCount = statements.length;
          assert.ok(
            queryCount <= 22,
            `${count} participants used ${queryCount} statements`,
          );
          assert.equal(
            statements.filter((sql) =>
              sql.includes("SELECT s.revision,s.data,b.name,b.timezone"),
            ).length,
            1,
          );
          assert.equal(
            statements.filter((sql) => sql.includes(projectionMarker)).length,
            count > 50 ? 1 : 0,
          );
          const reference = await completeJsonReport(
            db,
            token,
            historical.date,
          );
          assert.equal(reference.length, count);
          assert.equal(csvPlayerSection(result.value), playerCsv(reference));
          assert.deepEqual(result.access, expectedAccess);
        }
      },
    );
    await t.test(
      "current cash, credit, reversals, repeated visits and active results match JSON reads",
      async () => {
        await importStore(db, "local", store);
        await db.query(
          "UPDATE poker_profiles SET order_no=0 WHERE branch_id='local' AND id=ANY($1::text[])",
          [store.profiles.slice(-2).map((profile) => profile.id)],
        );
        const day = store.days.find((day) => day.id === store.currentDayId)!;
        const result = await readCsv(
          db,
          token,
          { resource: "report", dayId: day.id },
          expectedAccess,
        );
        const reference = await completeJsonReport(db, token, day.date);
        assert.equal(reference.length, 401);
        assert.equal(csvPlayerSection(result.value), playerCsv(reference));
        for (const [index, buyIn, cashOut, status] of [
          [200, 20001, 21003, "OUT"],
          [201, 23457, 34569, "OUT"],
          [202, 34567, 0, "ACTIVE"],
        ] as const) {
          const player = reference.find(
            (player) => player.id === store.profiles[index].id,
          )!;
          assert.equal(player.buyIn, buyIn);
          assert.equal(player.cashOut, cashOut);
          assert.equal(player.status, status);
          assert.ok(
            store.sessions.filter(
              (visit) => visit.playerId === player.id && visit.dayId === day.id,
            ).length >= 2,
          );
        }
        assert.ok(
          result.value.includes(
            '"Dense export player 202","345.67","0","Unsettled","ACTIVE"',
          ),
        );
        assert.ok(result.value.includes('"\t=2+3"'));
        const orderedTies = store.profiles
          .slice(-2)
          .map((profile) => profile.id)
          .sort();
        assert.deepEqual(
          reference.slice(0, 2).map((player) => player.id),
          orderedTies,
        );
        assert.equal(
          result.value.includes(
            '"Cash received","' +
              totalsForDay(store, day.id).cashReceived / 100 +
              '"',
          ),
          true,
        );
      },
    );
    await t.test(
      "inconsistent participant projection fails closed instead of returning a partial file",
      async () => {
        const inconsistent: Database = {
          ...db,
          transaction: (work) =>
            db.transaction((connection) =>
              work({
                async query<T>(sql: string, values?: unknown[]) {
                  const result = await connection.query<T>(sql, values);
                  return sql.includes(projectionMarker)
                    ? { rows: result.rows.slice(1) }
                    : result;
                },
              }),
            ),
        };
        await assert.rejects(
          readCsv(
            inconsistent,
            token,
            { resource: "report", dayId: store.currentDayId },
            expectedAccess,
          ),
          (error: unknown) =>
            error instanceof DomainError &&
            error.status === 503 &&
            error.message === "Cannot download report. Please try again.",
        );
      },
    );
    await t.test(
      "unsafe or nonfinite totals outside the first page cannot be silently exported",
      async () => {
        const playerId = store.profiles[398].id;
        for (const amount of ["9007199254740992", "NaN"]) {
          await db.query(
            "INSERT INTO poker_financial_totals(branch_id,scope,entity_id,day_id,buy_in) VALUES('local','PLAYER_DAY',$1,$2,$3::numeric) ON CONFLICT(branch_id,scope,entity_id,day_id) DO UPDATE SET buy_in=EXCLUDED.buy_in",
            [playerId, store.currentDayId, amount],
          );
          await assert.rejects(
            readCsv(
              db,
              token,
              { resource: "report", dayId: store.currentDayId },
              expectedAccess,
            ),
            (error: unknown) =>
              error instanceof DomainError && error.status === 503,
          );
        }
        await db.query(
          "DELETE FROM poker_financial_totals WHERE branch_id='local' AND scope='PLAYER_DAY' AND entity_id=$1 AND day_id=$2",
          [playerId, store.currentDayId],
        );
      },
    );
    await t.test(
      "an over-limit participant count is rejected before loading the full projection",
      async () => {
        let projections = 0;
        const overLimit: Database = {
          ...db,
          transaction: (work) =>
            db.transaction((connection) =>
              work({
                async query<T>(sql: string, values?: unknown[]) {
                  if (sql.includes(projectionMarker)) projections++;
                  if (
                    sql.startsWith(
                      "SELECT count(*)::text AS total FROM poker_profiles p",
                    )
                  )
                    return { rows: [{ total: "50001" }] as unknown as T[] };
                  return connection.query<T>(sql, values);
                },
              }),
            ),
        };
        await assert.rejects(
          readCsv(
            overLimit,
            token,
            { resource: "report", dayId: store.currentDayId },
            expectedAccess,
          ),
          (error: unknown) =>
            error instanceof DomainError &&
            /export is too large/.test(error.message),
        );
        assert.equal(projections, 0);
      },
    );
    await t.test(
      "the complete CSV byte cap still rejects oversized data instead of truncating",
      async () => {
        // A fault-injected projection tests the final output guard without a
        // huge fixture or weakening PostgreSQL's indexed-name size limit.
        const oversized: Database = {
          ...db,
          transaction: (work) =>
            db.transaction((connection) =>
              work({
                async query<T>(sql: string, values?: unknown[]) {
                  const result = await connection.query<T>(sql, values);
                  if (!sql.includes(projectionMarker)) return result;
                  return {
                    rows: result.rows.map((row, index) =>
                      index === 0
                        ? ({
                            ...(row as Record<string, unknown>),
                            name: "Q".repeat(4_000_001),
                          } as T)
                        : row,
                    ),
                  };
                },
              }),
            ),
        };
        await assert.rejects(
          readCsv(
            oversized,
            token,
            { resource: "report", dayId: store.currentDayId },
            expectedAccess,
          ),
          (error: unknown) =>
            error instanceof DomainError &&
            /export is too large/.test(error.message),
        );
      },
    );
  } finally {
    await engine.close();
  }
});
