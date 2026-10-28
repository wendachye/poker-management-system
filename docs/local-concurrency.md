# Local mixed financial concurrency checks

Run this engineering check against a **disposable local PostgreSQL database** after installing the locked project dependencies. The authenticated sample system at `localhost:3001` stays separate. This command never starts, resets or connects to that sample database, and does not load `.env` files or fall back to `DATABASE_URL`.

```powershell
# Supply a private connection for your disposable test database.
# Its database name must be poker_test or poker_test_* on loopback.
$env:POSTGRES_TEST_DATABASE_URL = "postgresql://TEST_USER:TEST_PASSWORD@127.0.0.1:TEST_PORT/poker_test_mixed"
npm run capacity:mixed
```

Use an existing isolated test service and keep its connection private. Never substitute a venue database or remote host. Query-string/startup overrides and `PGOPTIONS` are rejected. The test identity needs permission to create and drop its own random schemas and observe its own PostgreSQL lock waits. It is a disposable maintenance identity; this benchmark does not replace restricted application-role acceptance tests.

## Workload and bounds

| Variable                 | Default | Accepted values    |
| ------------------------ | ------: | ------------------ |
| `MIXED_VENUES`           |       2 | 2 or 5             |
| `MIXED_CYCLES`           |       2 | 1–10               |
| `MIXED_RETAINED_ENTRIES` |   1,000 | 1–20,000 per venue |
| `MIXED_READ_ROUNDS`      |      20 | 1–100 per reader   |

Each venue has ten authenticated staff identities: one admin, three managers and six cashiers. Two cash/credit journeys run in parallel. Five other staff poll compact state and search or paginate players, historical transactions, approval requests and permitted audit history. Audit queries use a manager identity; cashier readers stay within their permissions. Each reader pauses 25 milliseconds between completed reads, so this is a bounded closed-loop workload rather than an arrival-rate simulation.

The current harness analyzes only its generated schema's tables after seeding, before measured work. This gives both sides of an optimization comparison explicit planner statistics instead of depending on when automatic analysis happens. The original results below predate that setup step; use the matched follow-up for the query-change comparison.

Each cycle checks in cash and credit players, requests and independently approves RM500 buy-ins, records a RM200 credit repayment, moves seats and approves RM700 cash-outs. The credit payout settles RM300 remaining debt and pays RM400 cash. The separate control phase corrects RM50 rake through reversal and an RM30 replacement, rejects a credit reservation and completes zero cash-outs before closing.

Five deliberate races per venue wait behind an observed native PostgreSQL row lock: identical request replay, identical approval replay, competing reviewers, competing seat assignments and stale credit reservations. Only the named expected conflicts count as expected; ordinary financial conflicts, access failures, pool errors and other unexpected errors fail the run. The harness never blindly retries a financial conflict.

## Verification and interpretation

The JSON report separates ordinary actions, deliberate races and cross-venue denial checks. It records sample counts, p50/p95/max latency, response byte ranges, errors, expected conflicts and pool budgets. Reviewed-read-plus-save timings are separate from save-only timings and must not be added together as distinct operations. Race latency includes the intentional lock barrier. The scenario wall time includes independent integrity checks; it is not a service throughput measurement.

Untimed checks verify the full retained history against financial summaries, independent gross cash/chip totals and expected closing cash, zero remaining debt, unique postings/reversals, votes, seat ownership, operation identifiers and cross-venue isolation. Closing must succeed with no active visits or pending requests; operation parity is checked again after the close. Each run drops only its generated `poker_test_mixed_*` schema and closes all its pools, including on failures. It leaves the caller's test database service running.

These native repository/read-function checks exclude HTTP/TLS, browser rendering and physical mobile devices. They do not establish sustained throughput, a service-level objective, cloud capacity or production readiness. Historical fixtures contain house entries rather than a forecast of daily transaction volume, and do not prepopulate historical retry identifiers. Agree representative retention, daily entry volume and workload/recovery targets before a longer acceptance exercise.

## Local results on 29 October 2026

The two-venue smoke run used two cycles and 20 read rounds per reader. The larger runs used five venues, 50 distinct staff identities, ten cycles and 100 read rounds per reader: 100 complete cash/credit journeys and 2,500 ordinary reads in each run. These are two parallel financial lanes per venue, not fifty simultaneous financial writers. Both larger runs passed every financial and isolation check with zero unexpected errors, zero pool errors and no financial retries. Each produced exactly 275 new ledger entries and 780 saved operation identifiers, then closed all five days with RM6,030 expected and counted cash per venue. Fifteen deliberate losing conflicts were verified separately; identical request and posting retries did not add records.

| Measurement                                        | 1,000 historical entries per venue | 10,000 historical entries per venue |
| -------------------------------------------------- | ---------------------------------: | ----------------------------------: |
| Compact state read p95                             |                             164 ms |                              504 ms |
| Deep transaction-page read p95                     |                             177 ms |                              832 ms |
| Deep approval-history read p95                     |                             165 ms |                              754 ms |
| Deep audit-page read p95                           |                             173 ms |                              655 ms |
| Buy-in reviewed-read plus save p95                 |                             336 ms |                              651 ms |
| Approval reviewed-read plus save p95               |                             321 ms |                            1,078 ms |
| Cash-out reviewed-read plus save p95               |                             299 ms |                              741 ms |
| Parallel financial-journey phase                   |                            18.28 s |                             41.24 s |
| Scenario wall time including race/integrity phases |                            24.83 s |                             60.64 s |

The 10,000-entry run independently verified 50,275 total ledger entries, 50,280 requests, 100,780 audit events and all financial-summary rows. Compact state responses remained at or below 34,971 bytes. Greater retained history increased read and approval latency under this deliberately aggressive local workload; this is a measured optimization target, not a demonstrated service-level failure or acceptance result. The runs used PostgreSQL 18.6 limited to two CPUs and 1 GiB RAM, Node 24.18.0 and the default five-connection ordinary pool. Three separate single-connection race pools and a one-connection maintenance pool are reported explicitly; setup and deliberate race work do not use only the ordinary pool budget.

The final 10,000-entry run took 81.34 seconds including fixture setup and teardown. Its source hashes and complete output are retained under the ignored `.local/mixed-workload-2026-10-29/` directory in `five-venue-deep-history-result.json` and `five-venue-deep-history.json`; the smaller profiles are `two-venue-smoke.json` and `five-venue-mixed.json`. No application query or financial behavior was changed to obtain these results. The separate sample database and its records were not used by the benchmark.

## Search, pagination and approval optimization on 29 October 2026

Native query plans exposed three costs: a compact 20-record context scanned 10,000 ledger rows and discarded 9,980; each new financial posting scanned retained history to find insertion-order bounds; and deep pages sorted full JSON records, sometimes spilling to disk. Joined historical search also evaluated the same normalized filters separately for tab counts, filtered totals and page contents.

Migration v5 adds `(branch_id, order_no, id)` indexes for ledger, approvals and audit, preserving published v1–v4 SQL and checksums. Order bounds now use two one-row index probes. Compact contexts select bounded IDs through indexes. History pages select narrow keys before loading page JSON. Historical request/transaction searches share one materialized match set for tab counts and page selection; audit search also evaluates its filter once. Unsearched approval counts avoid unnecessary joins. Existing search matching, exact totals, ascending authoritative order and ID tie-breaking, page clamping, venue isolation, authorization, financial validation, locking and retry behavior remain unchanged.

The matched comparison used the same PostgreSQL 18.6 two-CPU/1-GiB service, five-connection ordinary pool, five venues, 50 identities, ten cycles, 10,000 retained entries per venue and 100 read rounds per reader. Both baseline and optimized runs explicitly analyzed their owned tables. The two optimized repetitions retained identical integrity counts: 50,275 ledger entries, 50,280 requests, 100,780 audit events, 780 operation IDs and 250 financial-summary rows. Each completed 100 cash/credit journeys and 2,500 ordinary reads, verified the fifteen deliberate conflicts and closed every venue at RM6,030 with zero debt or pending requests. Unexpected errors, pool errors and blind financial retries were zero.

| Native action p95                | Matched baseline | Optimized repetitions |
| -------------------------------- | ---------------: | --------------------: |
| Compact state                    |           389 ms |            208–226 ms |
| Deep transaction page            |           489 ms |            242–252 ms |
| Deep approval-history page       |           516 ms |            234–247 ms |
| Deep audit page                  |           629 ms |            246–248 ms |
| Buy-in reviewed-read plus save   |           722 ms |            386–407 ms |
| Approval reviewed-read plus save |           838 ms |            404–432 ms |
| Cash-out reviewed-read plus save |           701 ms |            387–401 ms |

The parallel financial-journey phase fell from 36.92 seconds to 20.23–20.62 seconds. Whole scenario wall time, including races and integrity checks, fell from 57.19 seconds to 37.94–38.93 seconds. This remains a short bounded local workload, not HTTP/browser latency, a sustained arrival-rate test or production acceptance.

A separate two-venue query fixture compared the same records and analyzed statistics, with three sequential samples per action. Median historical transaction text search fell from 332 to 128 ms, accented request search from 333 to 126 ms, numeric receipt-reference search from 436 to 132 ms and audit text search from 215 to 185 ms. Exact result/context signatures, counts and page metadata matched in all eleven probes. Search still needs to examine all matching candidates for exact substring totals; numbered deep pages still skip narrow keys rather than using a cursor. These costs remain relevant at larger retention sizes.

The 1,000-entry two-venue smoke run also passed. Regression checks passed 425 isolated tests, 22 native PostgreSQL 18 checks and 12 real HTTP workflow checks. A separate guarded PostgreSQL 17 recovery drill passed its fourteen v1-to-v5 upgrade/restore phases; its explicit major-version guard was preserved. Both operations/prototype builds and built HTTP isolation checks passed. Desktop/mobile browser checks covered searched tab counts, last-page contents and receipt context. Closing a delayed receipt now cancels its read without displaying a misleading superseded-request alert; a GET-only delay proxy verified cancellation without posting records.

The index migration was applied to the persistent fictional sample database only after upgrade/rollback checks and a verified backup. Complete backup payloads matched before and after migration, including accounts and retry identifiers. The app remains available at `http://localhost:3001`. Cloud staging was not used. Raw plans, signatures, source hashes, benchmark outputs and validation evidence are retained in the ignored `.local/search-performance-2026-10-29` directory, notably `query-comparison-final.json`, `workload-comparison.json` and `verification.json`.
