# Separate cloud staging database

Staging is a database-backed operations environment for fictional records. It is separate from the public browser-memory prototype, persistent local venues and future production records. Do not attach the staging database to the existing stakeholder Vercel project.

## Initialize a fresh managed database

Use a dedicated empty managed PostgreSQL 17 or 18 database and a direct TLS connection. The bootstrap identity needs database ownership and `CREATEROLE`; it need not be a superuser. Choose a region near the staging application and verify provider backup, retention, access and cost settings separately.

The initializer reads **only `STAGING_DATABASE_URL`** from the current process. It never loads `.env` and never falls back to `DATABASE_URL`. Supply its bootstrap connection securely with `sslmode=verify-full`. Both prototype flags must be disabled; `PGOPTIONS` and unsafe TLS overrides are rejected. Current connection support accepts only the unique `sslmode` and optional `application_name` URL parameters. Do not weaken TLS to accommodate a provider's default connection snippet.

Run from this repository after checking the provider project and the exact host/database independently:

```powershell
$env:NEXT_PUBLIC_POKER_PROTOTYPE = "0"
$env:POKER_PROTOTYPE_MODE = "0"
# Set STAGING_DATABASE_URL securely in this process, without echoing it.
node --conditions=react-server --import tsx scripts/staging-init.ts `
  --expected-host YOUR-DIRECT-DATABASE-HOST `
  --expected-database neondb `
  --schema poker_staging `
  --confirm YOUR-DIRECT-DATABASE-HOST/neondb/poker_staging
Remove-Item Env:STAGING_DATABASE_URL
```

The separately supplied expected host, database and confirmation must match exactly. The initializer checks the connected database and PostgreSQL major version, then refuses existing user tables/views/sequences, the requested schema or either requested role. Provider extension-owned objects are excluded from the empty-database check. This is a first-time initializer, not an upgrade or reset command.

Before connecting it creates an exclusive private credential file under the ignored `.local/staging/poker_staging-<uuid>/credentials.json`. It requests mode `0600`, flushes it and prints its path before database changes; verify Windows ACLs as appropriate. The file contains newly generated owner/app URLs and fictional staff passwords, never the bootstrap credential. It is not encrypted. Protect it and transfer required values through the hosting secret manager, without putting secrets into logs, Git or screenshots. A failed setup can leave an unused private credential file; do not assume such a file proves initialization succeeded.

Schema/role creation, all four unchanged migrations, sample provisioning and grants commit in one transaction or roll back. The command does not overwrite an existing setup. Its JSON success report contains technical target identity, counts and the credential-file path, never passwords or hashes. Failures print a controlled diagnostic rather than raw SQL. If the outcome is interrupted or uncertain, inspect the target before retrying; an existing schema/role prevents blind recreation.

## Identities and sample records

The initializer creates:

- `poker_staging_owner`: owns the application schema and performs controlled migrations/recovery. Keep its credential out of the application deployment.
- `poker_staging_app`: reads migration readiness, reads/updates mutable operational records, inserts ledger/audit/retry history and manages transient authentication state. It cannot create schema objects, write migration history or update/delete immutable financial/audit/retry records.
- Two fictional locations, **Staging · Main venue** and **Staging · Second venue**, each with 5/10 and 10/25 tables and sample buy-in guidance.
- Three independently usable staff sign-ins: `staging.admin`, `staging.manager` and `staging.cashier`, with separate generated passwords and appropriate membership in both locations. A disabled technical audit identity records provisioning.

There are no imported real accounts, player profiles, business days or financial entries. Venue setup remains incomplete for review. Sign in as the staging admin, review rules and staff access, complete setup and open a fictional business day before testing check-in.

PostgreSQL [role creation](https://www.postgresql.org/docs/18/role-attributes.html) grants a non-superuser creator administrative rights without automatically granting `SET ROLE`. Initialization adds an explicit temporary owner-role `SET` grant with inheritance disabled, then removes only that grant after setup. Provider administrative grants are preserved. Neither application nor owner receives database/role creation, superuser, replication or RLS-bypass privileges.

The dedicated fresh database's public schema/database `CREATE` privileges are revoked from `PUBLIC`. Per-database role settings select the staging schema through `search_path`; application URLs do not carry startup overrides. Subsequent migration changes need reviewed application grants, not blanket future privileges on every new table.

## Connect the staging application

Create a separate operations hosting project and use `vercel.operations.json` explicitly. The repository's default `vercel.json` enables the stakeholder prototype and remains unsuitable for database-backed staging.

Configure these values only in the staging environment:

```text
NEXT_PUBLIC_POKER_PROTOTYPE=0
POKER_PROTOTYPE_MODE=0
APP_ORIGIN=https://YOUR-EXACT-STAGING-APP-HOST
DATABASE_URL=<private poker_staging_app URL with sslmode=verify-full>
```

Run `production:check` against that environment, then build/deploy with both prototype flags disabled. A direct/session-preserving connection is the initial supported path. The app sets server timeout budgets when connecting; a provider pooler must be tested before adoption. Budget the default five pool connections across deployment instances, with room for maintenance.

Verify `/api/health` reports operations readiness, log in through the restricted application role and run the configured `db:verify` maintenance audit. Test independent requests/approvals, credit, cash-out, corrections, closing and venue isolation using only staging records. The existing `test:postgres`, `test:operations-http` and `recovery:drill` harnesses intentionally refuse remote targets; do not point their destructive fixture identities at staging or weaken those guards.

Passing initial connection and workflow checks does not establish production readiness. Hosted restore/PITR, monitoring and alert delivery, ingress throttling, connection/pooler behavior, sustained mixed workload and staff acceptance still require evidence. Free-tier retention or availability is not a production recovery policy. See [production readiness](production-readiness.md) and [data integrity and recovery](data-integrity-and-recovery.md).

## First staging setup verified on 29 October 2026

The separate **poker-management-staging** Neon project was provisioned through the signed-in Vercel team on its Free plan in Singapore, without connecting an application project. Its direct endpoint reported PostgreSQL **18.6**. Owner and application connections both passed `verify-full` certificate checks and selected the dedicated `poker_staging` schema. All four unchanged migrations were applied; the owner role owns all 18 application tables.

The restricted application connection passed the full read-only integrity audit and actual denial checks for schema creation, migration writes, immutable-history changes and owner-role escalation. Each fictional admin, manager and cashier signed in, switched between both venues and signed out. No sessions remained afterward. The database contains two venues, four tables and three active sign-ins plus a disabled provisioning audit actor. No player profiles, business days or financial entries were created; venue setup remains incomplete for review.

Local verification passed **410 isolated tests**, TypeScript, scoped lint/formatting, **22 native PostgreSQL 18.6 checks** and **12 HTTP workflow checks**. A separate native initializer probe used a non-superuser bootstrap and verified forced rollback, successful setup, temporary membership removal, an actual restricted app login, permission denials and refusal to overwrite. Its generated databases/roles were removed. The task-owned local PostgreSQL container and HTTP server were stopped.

Private credentials remain in ignored local files; reports and screenshots without secrets are in `.local/cloud-staging-2026-10-29`. The hosted report is `hosted-verification.json`. These checks exercised the actual cloud database and authentication repository, not a deployed staging web application. The separate authenticated hosting project, hosted workflow acceptance, recovery policy and monitoring still need setup.
