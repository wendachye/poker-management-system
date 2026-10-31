# Capacity plan for venue operations

The [local mixed financial concurrency checks](local-concurrency.md) add a later PostgreSQL 18.6 sample run with cash/credit journeys, explicit race controls and deeper pages at 1,000/10,000 retained entries per venue. They complement the original nonfinancial baseline below. The workload and evidence boundaries differ; these timings are not a matched performance-improvement claim.

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

## Three-minute local mixed rehearsal on 29 October 2026

Candidate `5979b91` completed a deliberately paced local rehearsal against PostgreSQL 18.6, limited to two database CPUs and 1 GiB of database memory, with a five-connection ordinary worker pool. Five venues had ten staff identities and 20,000 retained entries each. Ten cash/credit lanes ran one hundred journeys across ten cycles per venue, while twenty-five reader loops stayed active throughout the 181.420-second financial phase. Readers paused 300 ms between bounded rounds; none reached its 600-round cap. Setup, retained-history seeding, deliberate pacing and controlled race barriers are outside the ordinary action latency measurements.

The run completed 12,991 ordinary reads with no unexpected errors, idle pool errors or blind retries. All five venues closed at RM6,030 with zero variance, debt, pending approvals or active visits. Fifteen deliberately conflicting actions were rejected, and five cross-venue reads were denied. Independent integrity checks covered 100,275 ledger entries, 100,280 requests, 200,780 audit records and 780 committed operation identifiers, including financial-summary parity.

| Ordinary action                   | Samples | p50 ms | p95 ms | p99 ms |
| --------------------------------- | ------: | -----: | -----: | -----: |
| Compact state                     |   2,595 |     17 |     83 |    206 |
| Deep transaction history page     |   2,071 |     55 |    225 |    446 |
| Buy-in, including reviewed read   |     100 |    203 |    524 |    566 |
| Approval, including reviewed read |     265 |    169 |    513 |    563 |
| Cash-out, including reviewed read |     110 |    143 |    465 |    598 |

The largest measured ordinary p95 was 707 ms for credit check-in including its reviewed read; all ordinary action p95 values met the descriptive one-second target for this profile. These are native repository/command measurements with serialized compact receipts, not HTTP or browser throughput. Fifty identities do not imply fifty simultaneous database connections. The test is a bounded three-minute paced rehearsal, not an overnight soak or evidence of cloud capacity. RM100,000 turnover does not determine an entry rate; daily volume and retention targets still need operating evidence.

The same disposable PostgreSQL service separately passed 34 native integration checks, 22 complete HTTP workflow checks and fourteen recovery-drill phases. The recovery drill restored its own smaller fixture; it did not restore the 100,000-entry benchmark. Browser desktop/mobile results belong to the candidate's separately frozen CSV-release evidence. Raw measurements, source hashes, harness and reports remain under ignored `.local/local-release-rehearsal-2026-10-29`; the added duration pacing is a local harness, not a change to the shipped workload script's hard limits. Only owned test schemas, roles and disposable service resources were removed.

## Implemented data and interface changes

1. **Bounded routine reads.** The authenticated read module supplies server search, filters, deterministic page ordering and totals for players, requests, transactions, audit records, visits, receipts and reports. Pages default to twenty records and accept at most fifty. Compact operational state includes the records and exact server summaries needed for current work; history arrives through explicit pages instead of every background refresh. Report exports are separate, complete within their explicit size limits and independent of visible list filters.
2. **Indexed authoritative records.** Migration v2 imports profiles, table rules, visits, days/closings, approvals, ledger entries and audit records into venue-scoped tables. Generated query columns, indexes, composite references and uniqueness checks support those reads. The old branch blob becomes small metadata; normal writes persist changed records rather than serializing lifetime history. Migration/import tests preserve record order and reject broken references without deleting the source.
3. **Transactional financial summaries.** Migration v3 builds exact venue, player, day, player/day and table/day totals from the authoritative ledger. New postings and reversals update those summaries in the same transaction. Polling reads indexed summary keys instead of summing lifetime history. Restore and explicit imports rebuild derived totals; exported backups continue to contain authoritative records. Integer-sen values and aggregate conversions retain safe-number checks.
4. **Specific conflict checks.** A venue coordination lock still allocates revisions and commits each command atomically. Dependency versions now compare the records, seats, player balances, requests and rules reviewed by the form. Unrelated edits can save from the same reviewed revision; conflicting seat, player, financial or table changes still require review. Closing and venue-wide changes keep broader checks. This improves staff recovery without claiming that all same-venue writes run without coordination.
5. **Preserved financial safeguards.** Durable operation IDs, bounded retry contexts, independent reviewers, server authorization rechecks and compensating reversals remain in effect. Database constraints prevent duplicate posting/reversal and invalid venue references. Deferred seat uniqueness permits one atomic occupied-seat swap. Read projections are never restored as authoritative ledger data.

## Acceptance gates to agree and verify

Proposed engineering targets are p95 routine reads and saves within one second, no unexpected server errors or timeouts, and fewer than five percent of ordinary mixed-workload actions requiring manual conflict review. The independent-table burst and the bounded three-minute local mixed rehearsal met those descriptive targets for their measured profiles. Longer soaks and hosted acceptance remain unverified. Deliberately competing financial actions must still reject unsafe or duplicate outcomes. Every conflict must preserve entered data and offer a clear recovery path.

Acceptance must also prove no duplicate posting, incorrect balances, lost closing history or cross-venue disclosure. A same-venue burst of independent edits must complete without repeated manual re-entry. The actual daily transaction estimate, retained-history policy, maximum financial amounts, recovery targets and any cross-venue player-credit rules must be settled before final production sizing.

Remaining capacity work includes an extended soak beyond the three-minute local mixed rehearsal, deep-page and search performance at agreed real retention volumes, physical mobile-device rendering and gestures, the intended hosted PostgreSQL version and pooler, connection budgets across replicas, actual cloud-region latency, interrupted-request recovery in that environment and a hosted restore drill. The local correctness, browser and bounded workload checks are prerequisites for those checks.

## Reproduce safely

Set `POSTGRES_TEST_DATABASE_URL` to an explicitly disposable loopback database named `poker_test` or `poker_test_*`, then run:

```sh
yarn capacity:baseline
```

The command does not load `.env`, use `DATABASE_URL` or connect remotely. It creates and removes only its randomly generated test schemas. Defaults reproduce the five-venue/fifty-worker scenarios; `CAPACITY_*` settings allow smaller scenarios within hard resource caps. It is separate from the routine unit suite and must never target venue records.

A zero exit status means the harness completed and its structural checks held. It does not mean the measured latency, conflict recovery or production capacity met acceptance targets.
