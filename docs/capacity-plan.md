# Capacity plan for venue operations

The launch target is 2–5 venues, roughly 20–50 staff accounts and up to ten staff using each venue at the same time. Daily turnover is approximately RM100,000 or more **per venue**. Transaction count is unknown; monetary turnover is not used to infer record count, request rate or storage requirements.

## Confirmed targets and assumptions

| Item                       | Confirmed target or current assumption                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| Venues                     | 2–5                                                                                        |
| Routine staff              | Approximately 20–50 reported; concurrency is sized independently                           |
| Concurrent staff           | Up to 10 per venue, up to 50 across five venues                                            |
| Daily monetary turnover    | Approximately RM100,000+ per venue; exact definition and upper ceiling remain to be agreed |
| Daily entries              | Unknown                                                                                    |
| Retained history scenarios | 1,000 and 10,000 posted entries per venue, selected only as synthetic sensitivity tests    |

With one visible app tab per staff member, the current fifteen-second timer produces about 200 state requests per minute across fifty sessions, before focus events, initial loads and writes. Multiple tabs add further requests. Initial, timer and focus reads now share an outstanding background request instead of overlapping; explicit refreshes stay independent so a post-conflict refresh can obtain new records.

## Original aggregate-storage baseline on 28 October 2026

The guarded `capacity:baseline` command used five fictional venues with ten authenticated workers each, one synchronized read round and one synchronized nonfinancial table edit per worker. Edits retried revision conflicts up to three times with the same operation ID. Each venue had 100 player profiles, ten tables, a closed historical day, an empty current day, a matching approved request per retained transaction and two audit rows per retained transaction. The historical entries were synthetic house rake, not a forecast of venue turnover or a complete financial-workflow test.

Before the indexed-storage changes, the diagnostic run measured:

| Retained posted entries per venue | Raw snapshot size | Read p95 for 50 workers | Edit successes after up to 3 attempts | Final unresolved edits                               | Successful edit p95 including retries |
| --------------------------------- | ----------------: | ----------------------: | ------------------------------------: | ---------------------------------------------------- | ------------------------------------: |
| 1,000                             |           1.53 MB |                  399 ms |                               15 / 50 | 35 revision conflicts                                |                                2.29 s |
| 10,000                            |          15.25 MB |                5,156 ms |                               22 / 50 | 27 revision conflicts and 1 pool acquisition timeout |                               26.81 s |

MB means 1,000,000 bytes. Exact snapshot sizes were 1,531,388 and 15,247,388 bytes. The two runs observed read p95 ranges of roughly 399–426 ms and 4,695–5,156 ms respectively. The first run retained an uncategorized failure; the diagnostic rerun used explicit native-client timeout categories and identified a pool acquisition timeout. Both raw reports are retained locally.

No read errors or idle-pool errors occurred in the diagnostic run. The fixture ledger/approval/audit references and successful-edit, revision and operation-ID counts remained consistent. Those integrity checks are separate from capacity acceptance: unresolved operations and timeouts mean this test **does not establish readiness**. A synchronized burst is a deliberate stress scenario; these conflict percentages are not a measured daily staff error rate.

The application ran on Windows with Node 24.18.0 on a 24-logical-CPU, approximately 66 GB host. PostgreSQL 16.15 ran locally in a Docker container limited to two CPUs and 1 GiB RAM. The application pool remained at its default five connections. Timings include authentication reads, database work and UTF-8 snapshot serialization, but exclude login/setup, HTTP/TLS transfer, browser calculations, rendering and cloud infrastructure. Fifty samples per profile and two short runs are descriptive evidence, not a sustained-load result or a cloud SLA.

All workers used Manager roles and edited separate tables. The fixture does not include active visits, credit settlement or reversals, and historical operation-ID rows were not seeded; only the new successful edits created operation records. It measures aggregate-history sensitivity and a synchronized burst, not fifteen-second steady polling, a soak or the complete mix of financial operations.

The old 15.25 MB raw snapshot also exceeded the [4.5 MB function response-body limit documented by Vercel](https://vercel.com/docs/errors/function_response_payload_too_large). The new compact response is measured below. Neither workload is hosted acceptance evidence; response bounds and exports must still be tested under the chosen operations runtime.

## Indexed-storage follow-up on 28 October 2026

The follow-up used the same five-venue/fifty-worker fixture sizes and one synchronized read/edit round, after migrations v2 and v3. PostgreSQL 16.15 again had two CPUs and 1 GiB RAM, and the application pool remained at five connections. The Windows host, Node 24.18.0, player/table counts and retained-entry scenarios matched the original baseline.

| Retained posted entries per venue | Compact snapshot size | Read p95 for 50 workers | Independent edits saved | Conflicts / retries / failures | Successful edit p95 |
| --------------------------------- | --------------------: | ----------------------: | ----------------------: | ------------------------------ | ------------------: |
| 1,000                             |          23,661 bytes |                  159 ms |                 50 / 50 | 0 / 0 / 0                      |              439 ms |
| 10,000                            |          23,663 bytes |                  221 ms |                 50 / 50 | 0 / 0 / 0                      |              769 ms |

Exact read p95 values were 158.908 and 221.235 ms; successful edit p95 values were 438.900 and 769.073 ms. Serialized mutation receipts averaged 23,700 and 23,702 bytes. Both scenarios had zero read errors, mutation errors, connection-pool errors and idle-pool errors.

The full retained ledger, approved requests, audit records, successful edits, revisions and operation-ID counts passed independent, untimed checks. Every venue's financial-summary rows also matched its full ledger. The harness removed its generated schemas after each scenario.

The read measurement now uses the compact operations contract inside the same repeatable-read, read-only transaction pattern as the HTTP handler. Saves use scoped commands and compact receipts, including UTF-8 receipt serialization. Full Store reconstruction is reserved for the untimed integrity checks. This is the intended interface change; it is not a comparison of two identical full-history response contracts.

The response remained approximately 23.7 kB while retained entries increased tenfold. In this fixture, the original read p95 grew from 399 to 5,156 ms, while the indexed read p95 was 159 and 221 ms. The previous run completed 15/50 and 22/50 independent edits; this run completed all fifty in both scenarios. The old successful-save latency described only successful requests among many failures, so those conditional percentiles should not be treated as a complete before/after service-level comparison.

This remains one short local run with fifty samples per scenario. It excludes login/setup, HTTP/TLS transfer, browser rendering, cloud infrastructure and a longer soak. All workers edited distinct tables as Managers; the retained financial entries were house rake, without active visits, credit settlement, reversals or historical operation-ID rows. The financial-summary check proves fixture parity, not high-volume mixed financial throughput. These measurements do not establish cloud capacity or overall production readiness.

Raw reports are retained locally in `.local/indexed-operations-2026-10-28/capacity-indexed.json` and `capacity-comparison.json`; the accompanying error log is empty. The original reports remain in `.local/production-sizing-2026-10-28` rather than being overwritten.

## Implemented data and interface changes

1. **Bounded routine reads.** The authenticated read module supplies server search, filters, deterministic page ordering and totals for players, requests, transactions, audit records, visits, receipts and reports. Pages default to twenty records and accept at most fifty. Compact operational state includes the records and exact server summaries needed for current work; history arrives through explicit pages instead of every background refresh. Report exports are separate, complete within their explicit size limits and independent of visible list filters.
2. **Indexed authoritative records.** Migration v2 imports profiles, table rules, visits, days/closings, approvals, ledger entries and audit records into venue-scoped tables. Generated query columns, indexes, composite references and uniqueness checks support those reads. The old branch blob becomes small metadata; normal writes persist changed records rather than serializing lifetime history. Migration/import tests preserve record order and reject broken references without deleting the source.
3. **Transactional financial summaries.** Migration v3 builds exact venue, player, day, player/day and table/day totals from the authoritative ledger. New postings and reversals update those summaries in the same transaction. Polling reads indexed summary keys instead of summing lifetime history. Restore and explicit imports rebuild derived totals; exported backups continue to contain authoritative records. Integer-sen values and aggregate conversions retain safe-number checks.
4. **Specific conflict checks.** A venue coordination lock still allocates revisions and commits each command atomically. Dependency versions now compare the records, seats, player balances, requests and rules reviewed by the form. Unrelated edits can save from the same reviewed revision; conflicting seat, player, financial or table changes still require review. Closing and venue-wide changes keep broader checks. This improves staff recovery without claiming that all same-venue writes run without coordination.
5. **Preserved financial safeguards.** Durable operation IDs, bounded retry contexts, independent reviewers, server authorization rechecks and compensating reversals remain in effect. Database constraints prevent duplicate posting/reversal and invalid venue references. Deferred seat uniqueness permits one atomic occupied-seat swap. Read projections are never restored as authoritative ledger data.

## Acceptance gates to agree and verify

Proposed engineering targets are p95 routine reads and saves within one second, no unexpected server errors or timeouts, and fewer than five percent of ordinary mixed-workload actions requiring manual conflict review. The independent-table local burst met those latency/error targets, but ordinary mixed-workload, sustained and hosted acceptance remain unverified. Deliberately competing financial actions must still reject unsafe or duplicate outcomes. Every conflict must preserve entered data and offer a clear recovery path.

Acceptance must also prove no duplicate posting, incorrect balances, lost closing history or cross-venue disclosure. A same-venue burst of independent edits must complete without repeated manual re-entry. The actual daily transaction estimate, retained-history policy, maximum financial amounts, recovery targets and any cross-venue player-credit rules must be settled before final production sizing.

Remaining capacity work includes a longer mixed cash/credit/approval/closing workload, deep-page and search performance at agreed retention volumes, desktop/mobile rendering, the intended PostgreSQL version and pooler, connection budgets across replicas, actual cloud-region latency, interrupted-request recovery and a hosted restore drill. Local correctness tests and the short benchmark are prerequisites for those checks.

## Reproduce safely

Set `POSTGRES_TEST_DATABASE_URL` to an explicitly disposable loopback database named `poker_test` or `poker_test_*`, then run:

```sh
yarn capacity:baseline
```

The command does not load `.env`, use `DATABASE_URL` or connect remotely. It creates and removes only its randomly generated test schemas. Defaults reproduce the five-venue/fifty-worker scenarios; `CAPACITY_*` settings allow smaller scenarios within hard resource caps. It is separate from the routine unit suite and must never target venue records.

A zero exit status means the harness completed and its structural checks held. It does not mean the measured latency, conflict recovery or production capacity met acceptance targets.
