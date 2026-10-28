# Backend and frontend integration

The operations app uses the same UI and domain rules as the stakeholder prototype, with cookie-authenticated HTTP requests and PostgreSQL persistence. The public prototype deliberately keeps its own disposable browser data. It is not a connected operations environment.

## Connected modules

| Module                           | Reads                                                                                   | Writes and persistence                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff access and venue switching | `/api/auth`                                                                             | Sign-in/sign-out at `/api/auth`, venue switching at `/api/branch`; hashed credentials/tokens, expiry and membership checks                              |
| Players and tables               | Compact `/api/state`; player pages/search/detail and session history at `/api/read`     | Check-in, profile edits, moves, swaps and table rules at `/api/state`; indexed records and durable operation IDs                                        |
| Transactions and approval queue  | Filtered request/transaction pages and focused receipts at `/api/read`                  | Requests, independent decisions and compensating reversals at `/api/state`; request history, ledger, financial totals and audit records commit together |
| Dashboard and reports            | Exact summaries at `/api/state`; scoped daily/range rows, totals and CSV at `/api/read` | Opening, closing and reopening at `/api/state` preserve closing history                                                                                 |
| Venue rules                      | `/api/state`                                                                            | Rules and setup completion at `/api/state`; venue metadata and settings update together                                                                 |
| Staff accounts                   | `/api/staff`                                                                            | Staff commands at `/api/staff`; account, membership, session-revocation, audit and retry records                                                        |
| Locations                        | `/api/locations` and `/api/auth`                                                        | Creation at `/api/locations`; an empty venue and the creating admin's membership                                                                        |
| Readiness                        | `/api/health`                                                                           | Read-only database connectivity, migration metadata and required column checks                                                                          |

Authentication and authorization are resolved on the server. A supplied `actorId` is only an expected-identity precondition; it never grants access. Updated frontend writes include the identity whose screen was reviewed so a different login in another tab cannot silently submit that draft under the new staff member. Older internal callers can omit this transitional precondition; their commands still require normal session/role authorization.

## Indexed storage and summary projections

The original full-history branch JSONB aggregate has been replaced by separate venue-scoped tables for profiles, physical tables, visits, business days, approvals, posted ledger entries and audit records. Individual records keep their domain JSON, with generated typed columns and indexes for references, venue/day/player/status filters and ordered reads. Database constraints enforce venue-scoped references, unique player phones, one active visit/seat, one ledger posting per approval and one reversal per original. This design retains the existing domain model without treating a venue's complete history as one database value.

The migration history is numbered, checksummed and serialized:

- **v1, `initial_schema`:** preserves the legacy schema fingerprint and adopts a valid existing database without resetting its records.
- **v2, `indexed_operational_records`:** imports legacy collections into indexed tables, then replaces the branch aggregate with settings, current-day metadata and a concurrency floor. Existing identities, revisions, references and operation IDs are preserved. Constraint or migration failures roll back the transaction.
- **v3, `transactional_financial_totals`:** backfills derived venue, player, day, player/day and table/day totals from the authoritative ledger. Every new ledger entry updates these summaries in the same transaction. Full imports/restores rebuild them explicitly.
- **v4, `bounded_authentication_admission`:** adds shared login admission storage and expiry/account lookup indexes, bounds counters and reserves anonymous throttle keys. Published v1-v3 checksums remain unchanged. See [staff access safeguards](staff-access-security.md).

Summary values are stored as exact integer-sen numeric totals and checked before conversion to JavaScript numbers. Routine reads do not sum a sliced ledger or transfer all historical transactions to reconstruct a balance. `Store.readModel` is an ephemeral response projection carrying the exact balances and summaries needed by that context. It is not persisted as an operational record and cannot substitute for a complete logical backup or import.

Run `yarn db:migrate` through the controlled local/release process before starting the operations app. Request handlers never apply schema changes. Health checks reject missing or incompatible migration history; hosted upgrade/restore acceptance remains a separate release requirement.

## Bounded read interface

`GET /api/state` provides current operational context: settings, physical table configuration, active seating, limited recent/reference records and exact summaries. It also accepts focused `playerId`, `approvalId` or `receiptId` references for an open dialog. It does not return the venue's lifetime history.

`GET /api/read` authenticates the session, resolves its venue, validates filters and returns a numbered page with `items`, `total`, `page`, `pageSize`, matching counts and a fresh compact `context`. Default page size is 20; the maximum is 50. Resources cover players, requests, transactions, audit history, sessions, a selected player/receipt, a daily report and a range comparison. Search, status/type/date filters and page counts are computed on the server. Each read is snapshot-consistent; pages are ordered deterministically but do not hold a long-lived database snapshot across later staff edits.

The frontend replaces scoped contexts rather than accumulating historical pages. A visible list registers its current query so timer/focus refreshes retain that bounded page's related names and status. Opening a player, approval or receipt fetches the required context first; subsequent refreshes keep that focus. Returning-player, outstanding-credit and duplicate-phone lookups query the server, so records outside the initial context remain discoverable.

Daily reports can be selected by calendar date, including dates outside the recent-day selector. Daily and range summaries cover the complete selected scope. Visible player/day rows are paginated independently. The `report` and `range` resources support `format=csv` to export the full selected report, ignoring visible-row filters and page position. Ranges remain limited to 366 days, and oversized CSV exports fail explicitly rather than silently returning partial data.

Small physical configuration/reference lists and a single day's closing snapshots retain local presentation over their loaded scope. The stakeholder prototype keeps its full browser-memory selectors and existing local list filtering; its staff endpoints remain disabled. It never falls back to an operations database.

## Simultaneous staff edits

Operational forms retain the revision whose values staff reviewed. The server compares only the command's relevant player, balance, session, seat, table, approval, rules and day dependencies with changes recorded after that revision. Editing different tables or unrelated players can therefore succeed without requiring both staff to reopen their forms. An affected balance, occupied seat, changed approval or day closure still requires revalidation and, where necessary, a fresh review.

A venue row lock still serializes commits so financial postings, approvals, seats, audit records and summaries change atomically. Day closing and venue-wide changes coordinate more broadly. Staff/account and location administration retain their stricter locks and venue-revision checks. Durable operation IDs and independent reviewers continue to apply. This improves conflict recovery; it does not remove serialization or permit unsafe concurrent financial writes.

## Recovery behavior

- A temporary staff-access failure shows a retry action and retains a previously verified identity. A confirmed expired session navigates to sign-in and discards protected in-memory records.
- Proxy error pages and broken JSON produce clear messages instead of parser errors. The request deadline includes reading the response body.
- Snapshot and account receipt envelopes are checked before replacing frontend state. An invalid or missing save receipt retains the operation ID for safe retry.
- A save with an unconfirmed result blocks venue switching and sign-out. Retrying sends the original payload and operation ID, so an already committed operation is not posted twice.
- Background read failures are separate from save errors; a successful refresh removes its connection warning. Production identity/role/venue changes reload the protected workspace.
- Staff and location changes recheck identity and access after acquiring a venue lock, matching the operational writer's behavior.
- Superseded page queries are aborted. Focused context loads belong to the dialog intent that requested them; navigation or unmounting cannot publish an abandoned result or clear a newer dialog's focus.

These safeguards do not persist an unfinished browser request across a closed tab, browser crash or forced reload. Staff must resolve an unconfirmed request before deliberately leaving. A durable, privacy-preserving recovery design remains part of production hardening.

## Verify the connection

Run the isolated unit/domain suite, typecheck, lint and both operations/prototype builds. For independent PostgreSQL checks and full HTTP workflows:

```sh
yarn test:postgres
yarn test:operations-http
```

Both commands require `POSTGRES_TEST_DATABASE_URL` explicitly pointing to a disposable loopback database named `poker_test` or `poker_test_*`, without query overrides. Neither falls back to `DATABASE_URL` or `.env`.

The HTTP suite launches its own Next development server and creates a random owned schema and login role with a private search path. Its disposable database identity needs permission to create roles and schemas. It removes those resources and stops its server afterward. The application itself never receives the fixture administrator's credentials. Do not point this harness at venue records.

The suite exercises actual cookie-backed requests for staff/location setup, flexible stakes, check-in/identity/seat checks, moves/swaps, cash and credit buy-ins, independent approvals, repayment, cash-outs, rejection, correction/reversal, income entries, closing variance/reopening, cross-session persistence, venue isolation and logout. It verifies stored PostgreSQL records rather than trusting only the HTTP response. Indexed-storage, paginated-read and concurrency regressions also verify migration/import parity, bounded records, exact aggregate/report values, page filters and protected competing edits.

For desktop/mobile UI checks, `tests/ui-server.ts` starts a separate database-backed app with fictional staff and an embedded, temporary PostgreSQL-compatible database. It applies the same migrations and explicitly disables both prototype flags. The local operations launcher also disables those flags, so inherited demo settings cannot silently disconnect the frontend from the backend. See the README for test ports and credentials.

## Remaining production work

Connection correctness is distinct from scale and deployment readiness. Indexed storage, bounded history reads, transactional financial summaries and record-specific operational conflicts are implemented. The remaining gates include a representative mixed-workload/soak on the intended hosted database, connection and replica budgets, staging acceptance, monitoring, recovery and staff sign-off. Per-venue commit serialization and the performance of complex searches/deep numbered pages still require capacity evidence. These gates are tracked in [production readiness](production-readiness.md) and the [capacity plan](capacity-plan.md).

## Earlier integration baseline on 28 October 2026

The results below describe the integration pass before the indexed-storage and pagination refactor. They remain historical evidence; the current implementation's verification is recorded in the indexed follow-up below.

- 318 isolated automated checks passed, covering the existing workflows plus response deadlines, receipt contracts, local operations mode and expected-actor safeguards.
- Fourteen independent-connection checks passed on disposable PostgreSQL 16.15, including logout and venue-switch races for queued staff/location writes.
- The HTTP suite passed all nine workflow subtests and its parent check through actual Next development routes and PostgreSQL. No browser-memory transport was used in that suite.
- TypeScript, ESLint, both production builds and built HTTP smoke checks passed. Operations failed closed without credentials; prototype staff APIs stayed disabled. The added PostgreSQL 17/HTTP CI checks have not run remotely yet.
- The connected UI was checked across all main modules at a desktop width of approximately 1280 pixels and at a 390-pixel mobile viewport, with no horizontal overflow. Browser actions saved a sample check-in and RM500 request, independently approved it, switched venues and signed out. Mobile navigation and saved records remained consistent.
- A loopback-only test proxy simulated a temporary auth-check outage and a lost response after a successful opening-day save. Retry recovered access and the saved operation. Database counts stayed at one day, revision five and five total operation records before and after retry; the save was not duplicated.
- The built stakeholder prototype loaded its sample records and player search with no browser warnings/errors. The operations UI had no unexpected runtime errors; a development Fast Refresh warning was recorded during source edits.
- Only fictional fixtures were used. Generated test schemas/roles and the task-owned PostgreSQL container were removed, test servers were stopped and temporary tabs were closed. Persistent Local Operations/practice data and the live deployment were unchanged. Evidence is retained locally under `.local/backend-integration-2026-10-28`.

## Indexed follow-up on 28 October 2026

- Final source passed **358 isolated tests, 17 native PostgreSQL 16.15 checks and 11 HTTP checks** (ten subtests and their parent), with zero failures, skips or cancellations. The HTTP suite verifies the complete cash, credit, rejection, correction/reversal and closing/reopening journeys, plus actual paginated reads, complete exports and access isolation.
- Both operations and prototype production builds, TypeScript, ESLint and built HTTP/security-header smoke checks passed. The new read handler is explicitly included in the prototype API isolation matrix. These checks were local; the new hosted CI jobs have not run remotely.
- Desktop browser checks used a 1280-pixel viewport and mobile checks used 390 by 844 pixels. A player on the fourth directory page was opened, checked in to a specific seat and given a fictional RM500 cash buy-in. A different fictional reviewer found and approved the request through server search. Its posted receipt, player totals and pending counts agreed. Two forms opened before either save successfully edited different tables.
- Mobile checks verified the second pending-request page, audit last-page/search reset, focused player/session detail, RM700 cash-out preview and remote lookup of a checked-out credit player with RM300 debt. Desktop and mobile repayment previews both calculated RM100 received and RM200 remaining. Preview-only actions were cancelled.
- Historical-date selection persisted through filtering and timer refreshes on desktop and mobile. A downloaded 20 October report still contained all ten participants and RM19,995 expected cash with a no-match visible player filter. CUA's date `fill` changed the DOM value without committing a native change event; keyboard date selection was used to verify the actual flow. Independent hardening separates report selection from the opening-day draft and preserves intentionally cleared date input.
- Browser QA found and fixed a repayment picker crash caused by two children in a single-control Field, and suppressed the false empty-credit message during loading. Independent review found and fixed numeric reference searches incorrectly taking only the phone-search path. Regression coverage includes numeric house/request references and normalized phone search. Final fresh operations/prototype tabs had no console warnings/errors; earlier development logs retain the repaired crash and expected Fast Refresh reloads.
- The local five-venue/fifty-staff comparison reduced the 10,000-entry response from 15.25 MB to approximately 23.7 kB and read p95 from 5.16 seconds to 221 ms. All fifty independent edits saved without conflicts or retries. This was a short nonfinancial local burst; see the [capacity plan](capacity-plan.md) for resources and limits.
- Evidence, logs, screenshots, CSV and raw measurements are retained under `.local/indexed-operations-2026-10-28`. Tests used only disposable fictional records; generated schemas/roles were removed, the owned database container and temporary servers stopped, and QA tabs/viewport overrides cleared. Persistent Local Operations/practice records, Git remotes and cloud deployments were not changed. The [indexed operations guide](indexed-operations.md) covers migration and export boundaries; hosted release gates remain open.

## Staff access follow-up on 29 October 2026

The tested indexed baseline was published as `905dc4b` on main. GitHub Verify #17 passed both jobs, including PostgreSQL 17 and both build modes; Vercel reported a successful deployment. These statuses do not substitute for live workflow acceptance. [GitHub verification run](https://github.com/wendachye/poker-management-system/actions/runs/40725980122).

The subsequent staff-access batch passed 374 isolated tests, 22 PostgreSQL 17.11 checks and 12 HTTP checks, with zero failures or skips. Native tests cover global/account quota races, an earlier success preserving a newer failure, competing UI/CLI admin changes, cross-venue protection and session revocation, and retry preservation after restoration. Actual HTTP requests verify matching known/unknown throttle guidance, bounded Retry-After, no session creation on rejection, and forged forwarding headers failing to create a fresh global budget.

Desktop sign-in/sign-out and mobile invalid-login, throttle and recovery checks passed at 1280 and 390 pixels. English and Chinese messages displayed correctly, protected operations loaded after recovery, and no JavaScript warnings/errors or horizontal page overflow were observed. Only fictional accounts in a disposable database-backed UI app were used. The [staff access guide](staff-access-security.md) specifies policy limits, migration requirements and remaining ingress/operator deployment gates. Local evidence is retained in `.local/security-hardening-2026-10-29`.
