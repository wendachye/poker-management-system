# Production readiness for multiple locations

The target is one shared managed PostgreSQL database, with server-enforced access for each venue and a separate deployment for real staff. The public stakeholder prototype remains disposable and separate. This document tracks the work required before using real records; it is not a production certification.

The confirmed launch size is 2–5 venues, roughly 20–50 routine staff and up to ten concurrent staff per venue. Daily turnover is approximately RM100,000+ per venue; daily entry count is unknown. The [capacity plan](capacity-plan.md) preserves the original full-history/conflict baseline and the indexed-storage follow-up. The latter returned approximately 23.7 kB snapshots and saved all fifty independent edits in both retained-history scenarios; hosted and sustained financial-workload acceptance remains separate.

## Current foundation

- PostgreSQL-backed staff authentication, strict password-hash parsing, bounded password work, shared login budgets, session expiry and revocation. See [staff access safeguards](staff-access-security.md) for exact limits and deployment boundaries.
- Venue membership and role checks on server requests, including authorization rechecks after waiting for a venue lock.
- Atomic scoped record updates, dependency-specific revision checks and durable operation IDs with bounded retry contexts. A venue coordination lock remains for atomic commits and revision allocation.
- Independent approval, compensating ledger reversals and preserved closing history.
- Authoritative venue-scoped profiles, tables, visits, days, approvals, ledger and audit records with generated query columns, indexes and database constraints. The old full-history branch blob is replaced by small metadata.
- Authenticated server search/filter/pagination, compact operational reads and separately bounded report exports. Routine reads do not transfer retained history.
- Transactional financial summaries for venue, player, day, player/day and table/day scopes. The ledger remains authoritative; migrations/imports/restores rebuild derived totals.
- Full-history financial backup validation, an independent read-only database audit and a guarded native PostgreSQL upgrade/recovery rehearsal with separate owner/application roles. See [data integrity and recovery](data-integrity-and-recovery.md).
- Persistent local development and isolated sample prototype modes.
- Verified frontend/HTTP/database workflows, bounded client waiting, receipt validation and explicit connection recovery; see the [integration guide](backend-frontend-integration.md).
- Bounded streaming JSON requests; API response request IDs and redacted unexpected-error events.
- Bounded PostgreSQL statement, lock, connection and idle-transaction timeouts; safe idle-pool error handling and rollback cleanup.
- Hosted configuration preflight and runtime validation; generic database/schema readiness at `/api/health`.
- Page and API anti-framing, content-type, referrer and unused browser-feature policies. These are a baseline, not a complete script CSP.
- Patched Next.js 16.4.3, next-intl 4.14.9 and Zod 4.6.7, a refreshed canonical Yarn lockfile and a runtime dependency audit gate in CI. Yarn 1.22.22 is pinned and verified before CI installation.

## First release gates

| Gate                             | Evidence required before real use                                                                                                                                      | Current boundary                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate operations environment  | Dedicated staging and operations projects, domains, secrets and database accounts; both prototype flags disabled                                                       | Separate Neon staging database provisioned with isolated owner/app roles; authenticated staging app deployment and production resources remain                                           |
| Production database recovery     | Agreed recovery point and recovery time targets; encrypted automated backups/PITR; retention and access policy; timed restore into an isolated database                | Local durable-file and native isolated recovery rehearsal implemented; hosted recovery policy, agreed targets and timed hosted restore remain                                            |
| Real PostgreSQL correctness      | Independent-connection tests for retries, concurrent approval, stale writes, access revocation while locked, timeouts, rollback and restore                            | PostgreSQL 17 CI passed; PostgreSQL 18.6 passed 22 native and 12 HTTP checks locally; staging TLS, roles, staff login and integrity verified                                             |
| Login abuse protection           | Verified host/WAF throttling and shared source limits before password hashing, bounded hashing work, throttle-row retention; do not trust arbitrary forwarding headers | Shared global/account quotas, bounded anonymous buckets, process/KDF gates and indexed cleanup are implemented; verified per-source ingress/WAF controls remain                          |
| Operator account safety          | Audited shared-account changes, session revocation and concurrent last-admin protection, with an explicit recovery process                                             | UI and CLI share tested locks/admin coverage; CLI changes audit affected venues, revoke sessions and support exact retries and explicit re-enable; operator deployment ownership remains |
| Schema upgrades                  | Numbered, checksummed migrations, serialized application, upgrade tests and a recovery plan for failed releases                                                        | v1-v4 checksums preserved; native legacy upgrade/rollback rehearsed; fresh staging migrations applied on PostgreSQL 18.6; hosted historical upgrade rehearsal remains                    |
| Restore integrity                | Validate ledger/approval/session consistency and reversal amounts before restoration                                                                                   | Strict financial validation and independent summary parity implemented; native failed/successful restore, fresh login and retry preservation rehearsed; hosted acceptance remains        |
| Monitoring and ownership         | External error collection and alerts for health failures, auth abuse, pool exhaustion and failed backups; named operator and incident runbook                          | Safe logs/readiness exist; external monitoring and alert delivery are not configured                                                                                                     |
| Multi-location access acceptance | Staging role matrix, venue switching, revoked access, shared staff changes and cross-venue data-denial tests                                                           | Existing isolated tests are useful; hosted acceptance still required                                                                                                                     |
| Capacity and long-running data   | Agreed concurrency/history targets, measured latency/error budget and connection budget across replicas                                                                | Indexed local burst returned roughly 23.7 kB, with all 50 independent edits saved and no conflicts/errors; longer mixed financial, deep-page and hosted tests remain                     |
| Staff acceptance                 | Cash, credit, correction, reversal and closing journeys on desktop/mobile with staff sign-off                                                                          | Fictional live prototype has been tested; real operational acceptance is separate                                                                                                        |

## Configure and check hosted operations

Use a dedicated PostgreSQL login and secrets manager. Do not paste credentials into issues, logs, screenshots or this repository. Choose a database account with the least privileges needed; run schema changes through a separately controlled release identity where possible.

Set these values on the selected operations environment:

```text
NEXT_PUBLIC_POKER_PROTOTYPE=0
POKER_PROTOTYPE_MODE=0
APP_ORIGIN=https://your-exact-operations-host
DATABASE_URL=postgresql://APP_USER:APP_PASSWORD@DATABASE_HOST/poker?sslmode=verify-full
```

The origin must have no trailing slash, path, query, fragment or credentials. The first hosted profile supports `sslmode=verify-full` and optional `application_name` in the database URL, using system-trusted certificates. Custom CA and other provider-specific connection options must be deliberately implemented and tested rather than bypassing certificate validation. See the [node-postgres TLS guidance](https://node-postgres.com/features/ssl).

Run `npm run production:check` in the target environment before release. A passing result proves configuration syntax and policy only; it does not open a connection or validate credentials, schema, backups or load capacity. Normal production database access also validates this contract, so omitting the CLI check does not permit unsafe runtime settings. Development and test modes continue to support loopback databases.

`vercel.json` remains the demo profile. The separate `vercel.operations.json` profile is selected with the documented [Vercel CLI local configuration option](https://vercel.com/docs/cli/global-options#local-config) and an explicitly selected operations project. Do not reuse the current demo project or implicitly deploy to the project linked in `.vercel`. Git-based deployment needs its own reviewed pipeline that selects the operations profile; a repository push alone still selects the default demo configuration.

Apply the versioned migrations explicitly before starting an operations release. Migration v2 validates and imports the existing Store records before replacing the blob with metadata; v3 rebuilds financial summaries from that ledger; v4 adds bounded authentication admission and expiry indexes. Take a verified backup before any real upgrade and rehearse the complete release/restore procedure in staging. The local tests did not migrate real venues.

After applying migrations, `/api/health` must report `{"status":"ok","mode":"operations"}`. Missing schema, missing migration history or incompatible migration checksums/versions return 503. The check covers connectivity, all four known migration versions and required indexed-record/summary column presence; it does not prove write privileges, primary status, column types, constraints, staff provisioning or venue setup. Hosted acceptance must perform actual isolated writes and verify the intended primary and application privileges. The runtime database account needs read access to the migration ledger.

## Foundation verification on 28 October 2026

- 269 isolated tests passed, plus nine independent-connection integration checks on disposable PostgreSQL 16.15.
- Typecheck and ESLint passed. Operations and paired-prototype production builds both passed on Next.js 16.4.3. A frozen offline Yarn installation check also passed.
- HTTP smoke tests of the built apps verified security headers on login, players, health and auth; demo health/API isolation; and operations failing closed when credentials and origin were absent.
- Desktop and mobile client smoke checks passed at 1366, 390 and 320 pixels, including sidebar navigation, search, repayment preview, English/Chinese rendering, no horizontal overflow and no browser console warnings or errors. No financial request was submitted in these UI checks.
- A PostgreSQL 17 CI job and both build modes are configured. These new CI jobs have not been executed remotely yet.
- Test schemas, the task-owned database container and temporary HTTP servers were stopped or removed after verification. No venue records or cloud deployment were changed by these tests.

## Capacity and migration follow-up on 28 October 2026

- 290 isolated tests and ten independent-connection PostgreSQL 16.15 integration checks passed, including concurrent first migration, migration metadata validation and legacy baseline adoption.
- Typecheck, ESLint, operations and paired-prototype production builds passed. Built HTTP smoke checks confirmed the security headers and demo/operations isolation.
- Desktop and mobile read/search/navigation smoke checks passed at 1366 and 390 pixels, with no horizontal overflow or browser console warnings/errors. These checks submitted no financial requests.
- The local five-venue/fifty-worker capacity baseline exposed full-history response growth, repeated revision conflicts and a pool acquisition timeout. It is a diagnostic result, not a production capacity pass. See the [capacity plan](capacity-plan.md) for measurements and limitations.
- Initial, timer and focus refreshes now share an outstanding background request. Manual/conflict refreshes remain independent. Versioned migrations serialize application and readiness checks reject missing or incompatible migration history.
- The isolated capacity database and its generated schemas were removed after testing. Only fictional fixtures were used; no venue records, Git remote or cloud deployment were changed. The local sample preview remains available separately.

## Indexed operations follow-up on 28 October 2026

- The frozen-source verification passed 358 isolated automated checks, seventeen independent-connection checks on PostgreSQL 16.15, and eleven HTTP suite checks (ten workflow subtests plus their parent). The HTTP suite uses real Next handlers and PostgreSQL rather than browser-memory prototype transport.
- Migrations preserve populated legacy records and their ordering, reject invalid references/current-day pointers atomically, and retain the source after a failed upgrade. Database checks reject missing/null metadata markers and null/mismatched record identities instead of accepting SQL unknown values.
- Indexed reads preserve exact cash, credit, reversal and report totals while using compact contexts and bounded pages. Actual HTTP checks cover forty-five records across multiple pages, server search/filtering, oversized-page rejection, role/venue isolation and a complete CSV despite a one-row visible page and a no-match list filter.
- Concurrent tests preserve independent review and one posting/reversal, permit unrelated edits from one reviewed revision, reject conflicting edits, and recheck revoked access after lock waits. Form-open revisions remain attached to the records reviewed instead of being replaced by later polling revisions.
- Transactional financial-summary backfill, incremental posting/reversal, rollback and restore parity checks passed. Backups preserve bounded retry context, accept older files without it, and rebuild derived totals from saved ledger records.
- Operations and prototype builds, TypeScript, ESLint and built HTTP smoke checks passed. The unconfigured operations build failed closed; the stakeholder prototype kept staff APIs disabled. PostgreSQL 17 and hosted CI execution remain separate checks.
- The five-venue/fifty-worker local benchmark returned 23,661/23,663-byte compact snapshots at 1,000/10,000 retained entries per venue. Read p95 was 159/221 ms and successful save p95 was 439/769 ms. All fifty independent edits saved in each scenario, with zero conflicts, retries, failures or pool errors. Full record and financial-summary parity checks passed. These are short local nonfinancial edit bursts, not cloud or sustained financial capacity certification; see the [capacity plan](capacity-plan.md).
- Desktop/mobile sample checks passed at 1280 and 390 pixels, including last-page player check-in, independent approval, simultaneous unrelated table edits, repayment/cash-out previews, audit pagination and historical report export. A repayment dialog crash and numeric reference search regression found during review were fixed and retested. Report selection was also hardened against opening-day draft reuse and cleared-input fallback. Fresh operations/prototype tabs had no console warnings or errors; these are engineering checks, not staff acceptance for real operations.
- Verification used fictional fixtures. Generated schemas/roles were removed, the task-owned PostgreSQL container and temporary servers were stopped, and QA tabs/viewport overrides were cleared. Raw reports and screenshots remain in `.local/indexed-operations-2026-10-28`. Persistent Local Operations/practice records, Git remotes and cloud deployments were not changed.

## Staff access follow-up on 29 October 2026

- Published baseline `905dc4b` passed GitHub Verify #17, including the PostgreSQL 17 job and paired operations/prototype builds. Vercel reported a successful deployment. These are CI/deployment statuses rather than live operational acceptance.
- The security batch passed 374 isolated tests, twenty-two native PostgreSQL 17.11 checks and twelve real HTTP checks, with zero failures or skips. Both production builds, TypeScript, ESLint and built HTTP smoke checks passed.
- New checks cover atomic global/account quotas, bounded anonymous storage and cleanup, expired queue admission, strict password formats, matching known/unknown throttle messages, forged forwarding headers and no session creation on rejected login.
- Native connections verified competing UI/CLI account changes, cross-venue last-admin protection, shared credential revocation, and exact operator replay after restore. The technical audit actor remains disabled and membership-free; audit records do not copy password/hash/token fields.
- Desktop sign-in/sign-out and mobile invalid-login/throttle/recovery worked at 1280 and 390 pixels, including English and Chinese feedback. Tests used disposable fictional accounts; persistent venue records and real staff credentials were not changed. Local evidence is in `.local/security-hardening-2026-10-29`.
- Migration v4 and operator command usage are documented in [staff access safeguards](staff-access-security.md). Verified ingress/WAF source protection, controlled operator access, external monitoring and the hosted recovery/load gates remain required.

## Dependency security review

The updated production dependency audit reports zero known advisories as of this verification. `shadcn` remains installed for its build-time CSS import, under development dependencies rather than the deployed runtime tree. Builds must install development dependencies before compiling; runtime-only pruning happens after the build.

The full audit has no high, critical or moderate findings. One unpatched low-severity advisory remains on `deepmerge` through two shadcn development-tool paths ([upstream issue](https://github.com/TehShrike/deepmerge/issues/273)). This is recorded as unresolved, not fixed by changing dependency classification. Do not run the CLI against untrusted registry definitions. Recheck the full audit before each release and update the toolchain when a patch is available.

The framework update covers published upstream security fixes, including [SVG image processing](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw) and [typed-array cache functions](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr). An advisory match alone does not establish exploitability of the currently deployed demo; the patches are required for the production baseline.

## Database budgets

All budgets are per application process. Multiply `DATABASE_POOL_MAX` by the maximum replica/serverless concurrency and leave headroom for migrations, monitoring and recovery.

| Variable                               | Default | Allowed values                                  |
| -------------------------------------- | ------: | ----------------------------------------------- |
| `DATABASE_POOL_MAX`                    |       5 | 1 to 50                                         |
| `DATABASE_CONNECTION_TIMEOUT_MS`       |    5000 | 100 to 60000                                    |
| `DATABASE_IDLE_TIMEOUT_MS`             |   10000 | 1000 to 300000                                  |
| `DATABASE_STATEMENT_TIMEOUT_MS`        |   15000 | 100 to 300000                                   |
| `DATABASE_LOCK_TIMEOUT_MS`             |    5000 | 100 to 60000, no greater than statement timeout |
| `DATABASE_IDLE_TRANSACTION_TIMEOUT_MS` |   15000 | 1000 to 300000                                  |

Client query timeout is statement timeout plus five seconds. Zero cannot disable these limits. URL startup/timeout overrides and `PGOPTIONS` are rejected. Test any transaction/session pooler with these settings before choosing it. Statement or lock failures before commit trigger rollback. A lost connection or timeout during commit has an uncertain outcome; staff must refresh and retry with the existing operation ID instead of creating another transaction.

## Verify changes

Run the existing suite, typecheck, lint and both operations/demo builds. The real PostgreSQL and full HTTP workflow suites are intentionally separate:

```sh
npm run test:postgres
npm run test:operations-http
npm run recovery:drill
```

All three require `POSTGRES_TEST_DATABASE_URL` pointing to an explicitly disposable loopback database named `poker_test` or beginning `poker_test_`. They use generated test schemas and fictional staff and records, and refuse missing or unsafe targets; never set these to a venue database. The HTTP suite creates its own temporary login role and Next server. The recovery drill creates separate source/destination owner and restricted application roles. Both clean up their owned resources. CI supplies a disposable PostgreSQL service. Embedded PGlite tests do not substitute for independent PostgreSQL checks.

Before a hosted pilot, run the integration suite against the intended PostgreSQL major version and repeat the staff journeys in staging. Do a separate restore drill, record elapsed recovery time and verify balances, approvals, audit history, operation IDs and fresh login after recovery.

## Next implementation work

1. Configure verified host/WAF source protection, auth monitoring and controlled operator access; application login limits and operator safeguards are implemented.
2. Repeat the implemented v1–v4 upgrade and financial recovery rehearsal against the selected hosted PostgreSQL release, actual application privileges and provider connection path.
3. Deploy a separate authenticated staging application against the provisioned database, agree recovery targets, configure backup/PITR and monitoring, then demonstrate a timed hosted restore.
4. Verify agreed retention and workload targets with longer mixed cash/credit/approval/closing tests, deep-page/search checks, replica connection budgets, the intended pooler and actual cloud-region latency. The current short independent-edit burst does not cover these gates.
5. Complete hosted staff acceptance and approve a controlled venue rollout with a recovery owner.
