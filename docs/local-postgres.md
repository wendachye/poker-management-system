# Native PostgreSQL sample system on localhost

This mode runs the complete authenticated application against native PostgreSQL 18 in Docker. It uses separate persistent sample storage and preserves the existing embedded database and cloud configuration. The launcher does not rewrite `.env.local`; it explicitly overrides the database connection, app origin and both prototype flags for its child app. Next.js may still load other values from its normal environment files. Only fictional data belongs in this mode.

Start Docker Desktop, install the locked dependencies, then run from the repository:

```powershell
npm run local:postgres
```

Open [the local sample system](http://localhost:3001/en/login). The package command selects app port 3001. Calling the underlying script directly defaults to port 3000 when `--port` is omitted; an occupied port causes an explicit error and existing services remain running. `--database-port` changes the default database port 55440 only before first container creation. Existing container bindings are never silently changed.

The initial local-only sample sign-ins use **`local-test-password`**:

| Username        | Role                             |
| --------------- | -------------------------------- |
| `local.admin`   | Administrator                    |
| `local.manager` | Manager and independent reviewer |
| `local.cashier` | Cashier and requester            |
| `local.dealer`  | Dealer                           |

Later password changes are preserved. The launcher prints the initial sample password only when creating the fixture; subsequent runs report `passwordPreserved: true` rather than claiming every account still has its original password. Its `database-ready` message describes database readiness; Next.js separately reports when the website is listening.

**Local Sample Venue** starts with 16 fictional profiles, current seating, two completed business days, an open day, 86 ledger entries, pending approvals, rejected requests and correction examples. It uses the same domain rules and financial validation as the application. **Second Sample Venue** starts with an empty ledger for venue-isolation and clean-day exercises. Both venues are available to all four local sign-ins.

Newly created venues use 5/10 stakes, RM200–RM5,000 buy-ins and RM50 increments. Their Reserve table overrides this with 10/25 stakes, RM500–RM10,000 buy-ins and RM50 increments. Rules are editable in the normal Settings/Table forms. These defaults are applied only during first seeding; restarting does not replace settings saved by staff or change historical amounts and approval policies.

The app uses a restricted SQL runtime role. A different schema owner performs migrations. Runtime connections cannot create schema objects, change migration history or update/delete ledger, audit and operation history. Both prototype flags are disabled so actions go through real HTTP routes and the PostgreSQL database.

## Persistence and restart

The Docker container and named volume include a hash of the workspace path and carry explicit ownership labels. The launcher verifies those labels, the PostgreSQL image, loopback binding and exact volume before reusing a container. It refuses unrelated resources or a missing private configuration rather than replacing existing data.

Generated database passwords are saved privately under `.local/native-postgres/credentials.json`; never commit or share that file. The schema includes a workspace marker. Samples are created once; restarting preserves later staff edits, passwords, days, approvals and ledger history. Current migrations run on restart without reseeding. Next.js output is isolated in `.local/native-local-next`.

Ctrl+C stops only this launcher's web process tree. The sample PostgreSQL container and its data remain available. Start the same command again to resume. `--database-only` starts/verifies the owned database and exits without starting the web app. No cloud services are contacted. The first Docker image download needs internet access if `postgres:18-alpine` is not cached.

### Bounded startup and verification

The bootstrap and verification connections use one connection per pool, a five-second connection/acquisition limit, five-second lock waits, sixty-second statements, a sixty-five-second client query limit and a fifteen-second idle-transaction limit. These are maintenance budgets for migrations and full-history checks; they are per query or transaction-idle interval, not a total launcher deadline. Routine application and backup connection budgets retain their existing configuration.

The maintenance limits are fixed and ignore routine `DATABASE_*` overrides. Nonempty `PGOPTIONS` and URL timeout/startup overrides are refused before maintenance SQL. Normal startup may already have created or started its owned Docker resources and saved private configuration before this check. The explicit PostgreSQL options preserve each role's configured search path.

If another startup or maintenance operation holds a lock, the launcher stops with retry guidance. Failed initialization rolls back before its connection is released. Verification failures close their pool, and an idle connection failure prevents the launcher from announcing database readiness or starting Next.js. Let the other operation finish or review database activity, then retry the same command. Preserve the existing Docker volume and private configuration; a timeout does not request a reset. Backup mode retains its existing error handling and does not initialize samples.

## Save and verify a native local backup

While the owned sample PostgreSQL container is already running:

```powershell
npm run local:postgres -- --backup
```

This maintenance mode does not check or occupy the app port, start an app/container, initialize samples, apply migrations or grant permissions. It requires the existing workspace-owned volume, running container, private configuration and initialized schema. It reads through the restricted application database role in one repeatable-read, read-only snapshot.

The complete logical archive is saved privately under `.local/native-postgres/backups/` using the shared 100 MiB file budget, flushed private staging file and exclusive publication rules. The actual saved file is reread, then restored and compared in a disposable in-memory database. The running PostgreSQL database is never restored or reset. A successful report includes `readOnlyCapture: true` and `isolatedRestoreVerified: true`.

These files contain password hashes and venue records. Keep them private and outside Git. If saving succeeds but verification fails, the complete file is preserved and explicitly reported as unverified. This command does not relax the separate embedded-local backup/restore guard on port 55432, and it introduces no native reset/restore command.

Do not remove the Docker volume or the private credential file to restart. This launcher has no automatic reset or deletion command. Copying the volume while PostgreSQL writes is not a verified backup; use the logical backup/recovery procedure from a controlled maintenance connection when needed.

## Local verification on 29 October 2026

The authenticated application was reviewed on the native PostgreSQL 18.6 sample database at `http://localhost:3001`, using a desktop browser and a 390×844 mobile viewport. Browser actions covered cash/credit check-in and RM500 buy-ins, independent approval and self-review restrictions, RM200 credit repayment, seat moves and confirmed swaps, cash-outs, correction/reversal, rejection, closing variance, reopening and closing again. A mobile credit cash-out returned RM700 in chips, settled RM300 debt and paid RM400 cash; a zero cash-out also completed. Keyboard drag and dialog interaction were checked; the mobile viewport review does not establish actual touch-device gesture behavior.

In Second Sample Venue, the final close counted RM9,730 with zero variance. The earlier RM9,720 close with a RM10 shortage remained in the closing history after reopening and recounting. A read-only fault proxy separately verified desktop phone-lookup loading, failure and retry behavior; ordinary mobile forms were also exercised. Screenshots 01–13 and detailed evidence are retained in the ignored `.local/local-full-workflows-2026-10-29` directory.

The frozen local source passed **417 isolated checks**, **22 native PostgreSQL checks**, **12 HTTP workflow checks**, TypeScript, lint and both production build modes. Built HTTP smoke checks verified prototype API isolation and operations failure behavior without database credentials. The seven focused native-local setup/backup tests cover ownership guards, financial samples and permissions, persistence, refused targets, rollback and backup read-only behavior.

The actual native `--backup` command saved a 365,119-byte archive containing two venues, four accounts, 18 profiles, 97 ledger entries and 103 requests. It verified the actual saved file by restoring and comparing it in a disposable database; the running database was only read. That count is a verification snapshot and will change as staff continue practicing. `native-backup.log` contains the private archive path and verification report. Backups themselves remain under the ignored `.local/native-postgres/backups/` directory and must stay private.

The app and the owned PostgreSQL container were each restarted. Complete backup records, including accounts and retry identifiers, matched before and after both restarts; samples were not recreated. The new native credential and backup directory was restricted to the Windows owner, SYSTEM and administrators on this computer. Normal owner-terminal or elevated execution can access it.

All records used in this pass were fictional. Native database/API and embedded fixture checks complement the browser review; they do not establish production recovery targets, sustained workload capacity, physical mobile-device behavior or hosted deployment readiness. Cloud staging was not used for this local pass.
