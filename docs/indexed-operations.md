# Indexed operations and bounded reads

This implementation is prepared and verified locally on 28 October 2026. It connects the operations frontend to PostgreSQL without sending the venue's complete history on each refresh. The stakeholder prototype continues to use disposable browser data.

## Storage and migration

The indexed-storage release introduced the first three checksum-verified migrations in order:

1. `initial_schema` retains the original migration fingerprint.
2. `indexed_operational_records` moves profiles, tables, visits, days, approval requests, ledger entries and audit events into venue-scoped record tables. Generated query columns and indexes support venue, day, player, active seat, status, actor and chronological lookups. Venue state holds settings, the current day, revision and import floor rather than a duplicate history blob.
3. `transactional_financial_totals` backfills financial summaries for the venue, player, day, player/day and table/day scopes. New ledger postings and their summaries commit in the same transaction. Summaries can be rebuilt from the immutable ledger during a complete import or restore.

The later [authentication migration v4](staff-access-security.md) follows these storage migrations and leaves their published checksums unchanged.

Legacy migration checks record counts and venue-scoped relationships before removing the original arrays. The migration and its backfill roll back together on failure. Deferred constraints permit a confirmed occupied-seat swap while preventing two active visits from ending in the same seat or belonging to the same player. Posting a request or reversing an original entry twice is also blocked by database uniqueness constraints.

Backups still use the version 1 complete-store export format. Backup creation reconstructs all records explicitly; routine screens do not. Restore replaces the complete venue contents transactionally and rebuilds financial summaries. Do not copy a compact UI response into a backup or write a legacy history blob directly into `poker_branch_state`.

Before applying these migrations to an existing deployment, take and verify a complete backup, rehearse the migration and restore against a staging copy, and measure the migration window with representative history. No hosted database or existing local venue was migrated as part of this implementation's tests.

## Read contract

`GET /api/state` supplies the current operational floor, settings, exact balances/totals, recent history and a bounded pending preview. Selected player, request or receipt context can be requested explicitly. Low-cardinality catalogs such as tables, staff and accessible venues remain catalog reads.

`GET /api/read` supplies server-filtered pages for players, requests, transactions, audit, session history, daily report participants and report days. It also supplies focused player/receipt records and date-range comparisons. Pages default to 20 rows and accept 1–50 rows. Search text is limited to 200 characters; identifiers and calendar dates are validated. Venue identity comes from the authenticated session, not a query parameter. Audit reads require supervisory access.

Each page's count, rows and related context are read in one repeatable-read transaction. Ordering includes a stable tie-breaker, and out-of-range page numbers clamp to the last page. Different page requests intentionally see fresh committed data: inserts or deletions between requests can move rows across offset boundaries. This is a live operational list, not a frozen export cursor. The UI rejects stale responses and replaces page context instead of accumulating every page in memory.

Financial cards, debt limits, approval counts, cash-out previews and reports use exact server summaries rather than adding up the visible page. Search is literal, case/accent insensitive for supported text normalization, and phone search also normalizes digits. Text substring searches can still scan matching venue records; the current indexes are not a dedicated full-text or trigram search service.

CSV export is a separate authenticated read. It covers the selected complete report regardless of the visible list filter or page. Date ranges are limited to 366 days, and daily exports fail clearly above 50,000 participant rows or 4,000,000 UTF-8 bytes instead of producing a partial file. CSV cells retain spreadsheet-formula escaping.

## Simultaneous staff edits

Every mutation retains a short venue coordination lock for atomic revision assignment, day controls and durable operation IDs. This is not a lock-free writer. The server loads only the records and blockers needed by the command, rechecks identity/access after acquiring the lock, and commits changed rows, financial projections, audit records, dependency versions and the operation receipt together.

Forms submit the revision whose data the staff member reviewed. The server compares relevant dependency versions with that revision. Two staff can edit different tables or seat different players in different available seats without a false whole-venue conflict. Changes to the same table, target seat, player's debt, request or applicable rules still require a fresh review. Closing a day conflicts with financial activity that invalidates the cash count. Retrying an unconfirmed operation uses the same operation ID and returns the original result without reposting.

After a complete import, forms from before the import floor must reload. The frontend also guards actor/role/venue changes, focused records and late query responses. Background polling does not silently advance a form's reviewed revision.

## Verification and limits

The local evidence, test counts and before/after performance results are recorded in [backend/frontend integration](backend-frontend-integration.md) and the [capacity plan](capacity-plan.md). Tests use disposable fictional data, including native PostgreSQL connections and real HTTP routes. They cover independent edits, stale relevant edits, concurrent credit reservations, approval/posting uniqueness, reversals, migration rollback, backup restoration, pagination and exact totals.

The local capacity run is a short synchronized burst with five venues and ten staff per venue. It does not establish a hosted latency promise, sustained transaction throughput or recovery objective. Hosted staging, representative mixed financial traffic and long-running contention/soak tests remain release gates in [production readiness](production-readiness.md).
