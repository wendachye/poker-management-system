# Data integrity and recovery

The application validates complete financial history before accepting a logical backup and checks stored financial summaries against independently calculated ledger totals. The local tools and disposable PostgreSQL drill below provide recovery evidence. They do not establish a hosted backup policy or production recovery guarantee.

## What a backup must contain

The version 1 logical backup contains all venues, shared accounts and password hashes, venue memberships, complete ordered venue records, revisions, audit history and saved operation IDs. Authentication sessions and login throttle state are excluded. Restoring replaces all venues and accounts in the target, rebuilds financial summaries and requires every staff member to sign in again.

[Backup validation](../src/server/backup.ts) checks the envelope, SHA-256 checksum, supported format, unique identities, references, roles, venue rules and operation context. [Financial validation](../src/domain/store-integrity.ts) additionally checks:

- Safe integer monetary values, valid cash/credit profiles and complete authoritative history.
- Approval votes, independent reviewers, decision details and exactly one matching ledger posting for each approved request; pending or rejected requests must have no posting.
- Exact posting impacts, linked reversals, reversal order and prevention of duplicate reversals.
- Nonnegative reconstructed credit debt and pending credit reservations within the player's limit.
- Active seats, player visits, settlement and business-day lifecycle consistency; closing arithmetic, variance reasons and the final expected balance of a closed day.

Debt is replayed in retained ledger order, using integer arithmetic. Wall-clock timestamps are not a substitute for that order. A paginated or scoped UI response is not a complete backup and is rejected.

The logical format remains version 1. Older version 1 operation records without `result_context` remain compatible and restore with an empty context. This is not permission to accept inconsistent old history: a correctly checksummed file that violates current financial rules fails validation. Unsupported formats, edited histories and partial exports need an explicit recovery decision; the tools do not silently repair them or invent missing approvals. The supported indexed schema must be readable to capture or restore data.

The checksum detects accidental changes. It is neither a signature proving who produced the file nor encryption. Keep backups private, restrict access and arrange encrypted storage and transfer separately. Never attach full backups to issues or CI artifacts.

## Local backup, offline verification and restore

Create and verify a backup of the persistent local development database:

```powershell
npm run local:backup
npm run local:verify-backup -- ".local/backups/full-<timestamp>-<id>.json"
```

`local:backup` and `local:restore` load local environment configuration but accept only the exact development URL `postgresql://postgres:postgres@127.0.0.1:55432/postgres`, outside production mode. They are not cloud backup or restore commands. Files are created under `.local/backups/`.

`local:verify-backup` takes exactly one filename. It does not load `.env` or open the configured database. It reads and validates the file, restores it into an isolated in-memory PGlite database and compares every backed-up record after recapture. A failure exits nonzero. This checks logical restore compatibility, separately from the native PostgreSQL drill.

Preview a proposed local restore first:

```powershell
npm run local:restore -- ".local/backups/full-<timestamp>-<id>.json"
```

The preview validates and prints a summary without changing records. In a controlled maintenance window, the explicit replacement command is:

```powershell
npm run local:restore -- ".local/backups/full-<timestamp>-<id>.json" --confirm
```

Restore validates the incoming backup before mutation, takes exclusive locks and replaces the target in one database transaction. Arrange staff downtime before a real restore. Success signs everyone out; staff must use the restored credentials. A local `credentials.txt` file is not updated.

Before replacement, the local command writes a **UNVERIFIED pre-restore safety snapshot**, with a `before-restore-unverified-` filename. This is a raw, checksummed forensic copy of the current readable records. It deliberately bypasses financial acceptance so corrupt current history does not prevent replacement by a known-good backup. It uses the same private file publication and size limits as ordinary backups. If capture or saving fails, replacement does not proceed. A SQL failure during replacement rolls back the database transaction.

An unverified snapshot is not certified restorable data. The normal reader and verifier still enforce financial validation and may reject it. Preserve it for controlled investigation; do not treat it as a ready recovery source or bypass validation. Structural database damage that prevents reading the supported schema still requires another recovery path.

## File limits and durability

[The shared file module](../scripts/backup-files.ts) limits both ordinary and safety files to **100 MiB of encoded UTF-8**, including JSON formatting. The reader rejects nonregular files, invalid UTF-8, incomplete JSON, invalid backup contents and files that grow beyond the limit while being read. The writer validates ordinary backups and checks encoded size before publication. Backup capture and serialization still require memory; this is not a streaming database export.

Writes use an exclusively created sibling `.partial` file, request file mode `0600`, flush the file with `fsync`, then publish the complete file through an exclusive hard link. Existing targets are never overwritten, including competing writers. The staging file is removed after publication. The local commands request directory mode `0700`; apply and verify appropriate Windows ACLs or platform permissions as well.

On non-Windows systems the containing directory is also synced. Windows directory syncing is skipped: file flushing and exclusive publication do not guarantee that a new directory entry survives every power-loss scenario. Hard-link support and appropriate filesystem permissions are required. There is no weaker publication fallback. If the tool reports that publication succeeded but cleanup or directory sync failed, inspect and verify the saved file before retrying. Do not assume the reported error means no file exists.

## Verify the configured database

Run this from a controlled terminal with the intended environment and database access:

```powershell
npm run db:verify
```

Unlike offline verification, this command loads environment configuration and uses the configured `DATABASE_URL`. It accepts no arguments and does not migrate or repair records. Prototype mode forbids database access. Confirm the intended target before running any configured database command.

[The integrity check](../src/server/integrity.ts) requires current migration history and takes a repeatable-read, read-only snapshot. It validates the complete authoritative backup and compares every saved venue, day, player, player/day and table/day financial summary with independent `BigInt` calculations. Missing, extra or incorrect summary rows fail the check. The JSON result contains counts, check names and elapsed time; failure returns a diagnostic code and nonzero exit status without dumping credentials or record contents.

This is a full-history maintenance check, not a dashboard poll or lightweight health probe. Budget database work and application memory for retained history. A consistent snapshot does not verify external payment records, detect malicious edits by an unrestricted database administrator or provide offsite audit retention.

## Disposable PostgreSQL 17 recovery drill

Provision a separate disposable PostgreSQL 17 database and explicitly supply its URL in the current process. For example, after creating a suitable local test database and securely setting the test credential:

```powershell
$env:POSTGRES_TEST_DATABASE_URL = "postgresql://<test-owner>:<test-password>@127.0.0.1:55438/poker_test"
npm run recovery:drill
Remove-Item Env:POSTGRES_TEST_DATABASE_URL
```

The supplied test principal needs permission to create and drop the drill's generated roles and schemas. Use credentials dedicated to the disposable test instance; do not use production credentials. The drill neither provisions nor stops the PostgreSQL instance.

[Target guards](../scripts/recovery-contract.ts) require an explicit `POSTGRES_TEST_DATABASE_URL`; there is no `.env` loading or `DATABASE_URL` fallback. Only `localhost`, `127.0.0.1` or `::1`, a valid port and a database named `poker_test` or `poker_test_*` are accepted. Connection query overrides, fragments and nonempty `PGOPTIONS` are rejected. The connected server must actually be PostgreSQL 17.

Each run creates two fresh owned schemas and separate owner/application SQL roles for each. The application roles can insert immutable ledger, audit and operation records but cannot update or delete them, change schema or write migration history. Mutable operational records receive the DML needed by application flows; transient session/throttle cleanup has separate deletion privileges. The drill exercises both allowed behavior and denied privileges using actual role connections. These fixture grants are evidence for this application path, not automatic provisioning of production identities.

The [native drill](../scripts/recovery-drill.ts) records 14 measured phases:

| Phase | Verification                                                                                                                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Verify the guarded server target and create only fresh generated resources.                                                                                                       |
| 2     | Populate two fictional venues with complete sample histories in the legacy v1 schema.                                                                                             |
| 3     | Force a v1-to-v5 migration failure and verify rollback of data, migration history, counters and intermediate DDL.                                                                 |
| 4     | Remove the deliberately incompatible fixture and upgrade successfully, preserving record order, prior migration metadata and saved operation IDs.                                 |
| 5     | Provision and verify restricted application roles.                                                                                                                                |
| 6     | Sign in staff through those application roles.                                                                                                                                    |
| 7     | Submit and independently approve a fictional RM50 rake request; retry the saved operation without posting twice.                                                                  |
| 8     | Capture and validate the complete source backup.                                                                                                                                  |
| 9     | Write and reread a private backup file with matching contents.                                                                                                                    |
| 10    | Fail the pre-restore safety callback and verify that destination records and its existing session survive.                                                                        |
| 11    | Inject an SQL failure during replacement and verify complete rollback and session preservation.                                                                                   |
| 12    | Restore successfully with a saved pre-restore safety backup.                                                                                                                      |
| 13    | Compare ordered records, audit and operation history, independently calculated balances and summaries; reject old sessions and verify safe retry of legacy and new operation IDs. |
| 14    | Sign in again using restored accounts, measured within restored-state verification.                                                                                               |

Source and restored databases also run the read-only integrity check through the restricted application role. Restore and migration use the owner role. The run checks that restored operations do not change the source.

An ignored `.local/recovery-drill-<id>/` directory retains fictional full backup files and a `report.json` with phase outcomes, timings, counts, parity evidence and cleanup status. The report excludes passwords, password hashes, tokens and full records; the backup files are still private. Inspect `status` **and** verified cleanup fields. The drill closes pools, checks ownership before dropping its generated schemas, drops its generated roles and queries for leftovers, including failure paths. Unverified cleanup is not reported as zero remaining resources. A failed run exits nonzero; inspect reported owned resource names before any manual cleanup. Do not delete or drop unrelated resources.

## Remaining production release checks

The disposable drill measures a small local fixture. It does not establish production recovery-point or recovery-time objectives. Before taking real venue data:

- Assign a recovery owner and agree acceptable data loss (**RPO**) and downtime (**RTO**).
- Configure the hosted provider's automated backups, retention, encrypted access and point-in-time recovery (**PITR**); rehearse recovery into a separate hosted target with representative retained history.
- Verify restore permissions, storage durability, backup availability during an outage, monitoring and alerts. Retain recovery evidence outside the database failure domain.
- Rehearse the release upgrade, staff downtime, fresh sign-in, application reconnection and controlled recovery procedure on the actual hosting platform.
- Complete sustained mixed read/write and simultaneous-staff testing at expected venue concurrency, including conflicts, retries and failures. Turnover value alone does not determine transaction volume or database capacity.

Preserve the stakeholder sample prototype separately from production records. Passing these local checks is one release gate, not permission to treat the demo as a live financial system.
