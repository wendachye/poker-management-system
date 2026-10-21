# Poker Management System

A staff operations app for poker venues: player check-in, table seating, buy-ins, cash-outs, credit, table income, approvals, receipts, and daily cash reconciliation. This is not a poker game engine.

Built with Next.js 16, React 19, TypeScript, PostgreSQL, and English/Chinese interfaces. Each location has separate records and staff permissions. Staff with multiple memberships can switch locations.

## Stakeholder frontend prototype

To review the user interface and daily workflow with fictional data, run:

```sh
npm run prototype
```

Open [the stakeholder prototype](http://127.0.0.1:3001/en/dashboard). This preview uses the existing screens and theme with in-memory browser data. It needs no database, staff passwords or account setup. The regular local app at port 3000 can keep running independently.

Use **Demo tools** for free exploration with **Busy shift** or **Ready to close**, or start one of three guided journeys:

- **Cash player:** check in Alex Tan, request a RM500 cash buy-in, approve as a separate manager, return RM700 in chips, approve the cash-out as admin, then close with RM19,800 counted cash.
- **Credit player:** check in Sara Lee, approve a RM500 credit buy-in, approve a RM200 cash repayment, then return RM700 in chips. Cash-out settles the remaining RM300 debt and pays RM400 in cash; closing cash is RM19,800.
- **Corrections and closing:** approve RM50 rake, reject a duplicate request, reverse the original entry, then approve a replacement for RM30. Expected cash is RM20,030; count RM20,020 to demonstrate a RM10 shortage with a required explanation.

The guide shows the current step and required staff role. Continue opens the relevant screen or unsaved form; staff still review and submit every action. Switch between Cashier, Manager, Admin and Dealer to demonstrate responsibilities. A separate manager approves buy-ins and repayments; cash-outs and reversals require admin review. All amounts are fictional and follow the same workflow rules used by the app.

**Reset demo** returns to the selected sample scenario. Refreshing the browser returns to the initial busy shift. Demo changes are not saved and never reach the working local database; the prototype launcher explicitly disables live database access. This is a local presentation prototype, not a deployed operations service. Prototype work lives on `codex/stakeholder-prototype` while the tested local release remains on `main`.

## Local first (no Docker or cloud account)

Use Node.js 22.13+ and install the project dependencies once with `yarn install --frozen-lockfile`. Start both the app and persistent local database with:

```sh
npm run local
```

Open [localhost:3000](http://localhost:3000/en/login). The first run creates the Local Venue branch and three accounts: `local.admin`, `local.manager`, and `local.cashier`. Their randomly generated passwords are saved in `.local/credentials.txt`. This file, the database folder and `.env.local` are excluded from Git. Sign in as admin, complete **Settings** first, then open a business day under Reports. Use a different account to request transactions. A local administrator renamed to `admin` remains the same account on restart; the launcher does not recreate `local.admin`.

- The database is PostgreSQL-compatible PGlite stored in `.local/postgres`, not the disposable smoke-test database. Restarts preserve records and passwords. The launcher never resets an existing branch or account.
- Press Ctrl+C in the launcher terminal to stop the app and database. Run `npm run local` again to resume. No Windows startup service is installed.
- The app binds to `127.0.0.1:3000`; the database binds to `127.0.0.1:55432`. Port 55433 prevents concurrent launchers from opening the same files. Keep these ports local to this computer.
- To run only the database for CLI maintenance, use `npm run local:db`. While it runs, the existing `staff:create`, `staff:password`, and `db:branch` commands work in another terminal. Do not start a second launcher.
- With the launcher running, use `npm run local:backup` to save a consistent full backup in `.local/backups/`. See the restore workflow below. Do not delete `.local` when restarting.
- The launcher creates `.env.local` only when it does not exist and refuses mismatched database/origin settings. For this mode the URL is `postgresql://postgres:postgres@127.0.0.1:55432/postgres` and the origin is `http://localhost:3000`. The embedded database socket does not authenticate connections; application staff login still does. This mode is intended for local use and testing.
- App pages and fonts need no external services. The initial dependency installation needs internet access; the local launcher disables Next.js telemetry. The multi-location features still work locally.

PGlite serializes database work. Use regular PostgreSQL for a future shared server or multi-instance deployment. Cloud setup can wait until local workflows are tested.

### Set up a location before operating

The bottom **Administration** navigation groups focused modules: **Venue settings** (venue and rules, tables and stakes, locations, and a setup checklist), **Staff accounts**, and **Controls and audit** (audit history, approval policy, and admin-only day recovery). Each module has its own URL and breadcrumb. Managers can review audit history and approval policy; venue settings, staff accounts, and day recovery require an administrator. Legacy `/settings` and `/admin` links redirect to the setup checklist and audit history. A new location's dashboard shows a setup reminder linking to Settings while keeping its analytics visible.

1. **Venue and rules:** edit the location name, business time zone, and house rules. Select the game, default blinds, minimum/maximum buy-in, and optional buy-in increment. Stakes are flexible: the 5/10 and 10/25 presets are shortcuts, and any valid pair can be entered.
2. **Services:** enable or disable new credit accounts/buy-ins, tips, rake, insurance, and jackpot entries. Enter rake percentage/cap guidance and a tips policy for staff. Rake and tips are recorded as actual amounts through approval; percentages and caps guide staff and do not automatically deduct money. All staff can read house rules, game defaults, rake guidance, and the tips policy under **Tables → Venue rules**. Rake and Tips entry dialogs also display the relevant guidance.
3. **Staff accounts:** create active staff with appropriate roles. Readiness requires a cashier or manager and a different manager/admin who can review transactions. An admin and a separate cashier are sufficient; accounts can be added later.
4. **Tables and stakes:** create at least one open table. Each table can inherit venue defaults or override its blinds, buy-in range, and increment. One table can run 5/10 while another runs 10/25. Leave override fields blank to inherit; both blind fields must be filled or both blank. Buy-in limits apply to each new request, and increments require multiples of the configured amount. Zero means no increment restriction.
5. **Review setup:** check the saved rules, staff, and tables, then select **Complete setup**. Only then can a manager/admin open a new business day under Reports. Existing open days in an older database can finish normally; they do not become locked because setup was added.
6. **Locations:** create an additional empty location with a unique code, name, and time zone. The creating admin receives access. Switch to that location and complete its own setup; rules and records remain separate. Shared-account password/access changes continue to use the operator commands.

Changing rules preserves posted entries and existing pending approvals. Existing credit repayments and cash-outs remain available when new credit is disabled. Disabled transaction types remain visible as unavailable choices so staff can understand why an entry cannot be requested.

### Optional sample data

With `npm run local` running, use `npm run local:seed` in another terminal to populate an empty Local Venue. This adds 16 fictional players, four tables, two completed days and an open day, 86 posted transactions, five pending requests, and a rejected request. Player/table names and transaction notes identify the samples. Examples include cash and credit players, a full table, a restricted inactive player, credit settlement, a dual approval, reversals, and a closing variance.

The loader uses the application's business rules, only connects to the persistent local development database, and refuses to overwrite a populated venue. A marker prevents duplicate loading. It saves the prior branch state in `.local/backups/` and commits the dataset atomically. Dates are relative to the loading date in Asia/Kuala_Lumpur. Existing local logins remain unchanged; `sample.*` staff are disabled audit actors, not sign-in accounts. Sign in with `local.admin` to review the pending examples.

### Local backup and restore

Leave `npm run local` (or `npm run local:db`) running. In a second terminal:

```sh
npm run local:backup
npm run local:verify-backup -- ".local/backups/full-YOUR-BACKUP-FILENAME.json"
npm run local:restore -- ".local/backups/full-YOUR-BACKUP-FILENAME.json"
```

The verify command restores the file into a disposable in-memory database and compares every saved record, without changing your persistent database. The restore command validates the file and shows a **preview only**. To replace all local branches and accounts with that backup, repeat it with `--confirm`:

```sh
npm run local:restore -- ".local/backups/full-YOUR-BACKUP-FILENAME.json" --confirm
```

The full backup contains branches, password hashes, staff memberships, players, seating, business days, approvals, ledger entries, audit history, and operation identifiers used to prevent duplicate retries. It uses a versioned JSON format with a checksum and validates record shapes and references. The older `before-samples-*.json` files only contain branch state and cannot be used with this restore command.

Before a restore changes anything, it saves the current database to a separate `before-restore-*.json` file. If that file cannot be saved, the restore stops. Replacement runs in one database transaction; a failure rolls all changes back. All sessions are revoked on successful restore, so close other app tabs and sign in again using the accounts and passwords from the restored backup. `.local/credentials.txt` is not rewritten and might no longer match a restored account.

Keep these files private: they contain venue records and password hashes. Copy important backups to a separate private drive; a file on the same disk does not protect against disk failure. Sessions and temporary login-throttle counters are intentionally excluded. These commands only accept the embedded local database URL, refuse production mode, and limit restore files to 100 MB. Do not copy a live `.local/postgres` directory; stop the launcher first if taking a separate filesystem copy.

Automated restore tests use isolated databases, including a sample-data round trip, damaged-file rejection, a failed safety backup, and rollback after a write failure. They do not overwrite your running venue to test recovery.

## Optional local PostgreSQL with Docker

Use Node.js 22.13+ and Yarn Classic. The committed lockfile is `yarn.lock`.

```sh
yarn install --frozen-lockfile
docker compose up -d
```

For this alternative, stop the embedded launcher and use the PostgreSQL connection string from `.env.example` in `.env.local`. The supplied connection string matches the Docker database. Keep the embedded `.local/postgres` directory; changing the connection does not migrate its records. Then:

```sh
yarn db:migrate
yarn db:branch --id kl --name "Kuala Lumpur" --timezone Asia/Kuala_Lumpur
yarn staff:create --username cashier --branch kl --role CASHIER
yarn staff:create --username manager --branch kl --role MANAGER
yarn staff:create --username admin --branch kl --role ADMIN
yarn dev
```

Staff commands prompt for a hidden password (12–128 characters). Provision distinct people for requester and reviewer roles. There are no default production accounts or seeded business records. Visit [localhost:3000](http://localhost:3000), sign in as a manager/admin, add tables under Tables, and open the first business day under Reports.

For noninteractive provisioning, pass `POKER_STAFF_PASSWORD` through a secret manager/environment; never commit it or put it in command arguments. Finish venue setup under Settings before opening the first business day.

### Additional locations and staff management

```sh
yarn db:branch --id penang --name "Penang"
yarn staff:create --username admin --branch penang --role ADMIN --grant-existing
yarn staff:password --username cashier
yarn staff:disable --username cashier
```

Admins can use **Administration → Staff accounts** to create staff, change their role, reset a password, disable an account, or enable a disabled account with a new password. The form explains each role, requires a reason, and records changes in the branch audit history without storing passwords there. Role changes, password resets, and disabling revoke the affected staff member's sessions. Admins cannot change their own account through this screen; another admin must do that. The active account list hides disabled sample actors by default.

The screen only shows the current branch's staff. For accounts shared by multiple locations, it allows changing the current branch role; password resets and global enable/disable require the operator CLI. An existing account requires `--grant-existing` in the CLI to add or change branch access. Role membership is checked on every API request; branch roles may differ for the same person.

### Date-range reports

Under **Reports → Date range**, choose the last seven calendar days, month to date, previous month, or a custom range up to 366 days. Presets use the location's timezone. Reports compare the selected period with the immediately preceding interval of equal length, show a daily breakdown, and export CSV. Click a business date to open its daily report and closing history.

Range totals contain posted cash flows, buy-ins/cash-outs, rake, tips, insurance movements, and jackpot movements, including compensating reversals. Pending requests are excluded and counted separately. Open days are provisional; unrecorded dates are shown as missing coverage, not verified zero activity. Comparisons with no recorded days show no change amount. Opening/expected cash balances are daily snapshots and are never summed across days. Variance includes only counted, closed days. Cash movement is not a complete profit statement.

### Dashboard and approval notifications

The dashboard focuses on analytics: active players, open-table seat utilization, expected cash for the current business day, outstanding credit across business days, posted cash receipts/payouts/net movement, and occupancy by open table. The cash trend shows the last seven recorded business days in date order, including negative movements and reversals. Open days are marked provisional; dates without a business-day record are omitted. A compact pending-request notice links to Transactions. Check-in, financial entries, detailed approvals, player profiles, rules, and audit history remain on their respective pages.

The header approval bell is available throughout the management pages. Its badge counts all pending requests for the active location; the popover previews the five newest, with business date, subject, amount, reviewer policy, and the signed-in staff member's review status. The count reflects request status rather than a separate unread flag. Requests from closed days remain visible with their closed-day status. Opening the queue takes staff to **Transactions → Pending** with old search/date/type filters cleared; authorization is enforced when reviewing a request.

## Cloud deployment for multiple locations

1. Provision managed PostgreSQL with TLS and automated backups/point-in-time recovery. Test a restore into an isolated database before launch. Use a dedicated application database account.
2. Configure `DATABASE_URL` using the provider's connection string and certificate verification settings, and `APP_ORIGIN=https://your-exact-app-host` on the Node hosting service. Do not disable certificate verification. Use the same PostgreSQL database for all app instances and locations.
3. Install dependencies, run `yarn db:migrate` as a release step, provision branches/staff through a secure operator terminal, then run `yarn build` and `yarn start`. The app requires a Node runtime; static export/edge-only hosting is unsuitable.
4. Use HTTPS and configure the reverse proxy to preserve the public origin. Production session cookies are Secure, HttpOnly, SameSite=Strict and expire after eight hours. Avoid shared caching of authenticated responses.
5. Configure host-level request throttling, logging/alerts and connection limits. The application pool allows five connections per instance; use provider-supported pooling for serverless deployment. The app uses local system fonts, so builds do not download fonts.
6. Verify a cashier request, a separate reviewer approval, branch isolation, a zero cash-out, a closing count, and logout on the hosted environment before entering real records.

Deployments are not automatic. This repository does not provision a hosting account, production database, domain, or secrets. `compose.yaml` is for local development only.

## Operating rules

- Money is stored as integer Malaysian sen. Display and CSV amounts are MYR. Inputs allow at most two decimal places.
- Returning players are identified by normalized international phone number **within a location**. Check-in preserves their profile, restrictions and debt. Cross-location player identity, bans and credit are not consolidated.
- Every transaction requires an independent manager/admin. The requester cannot approve their own request.
- Payouts, reversals and amounts of RM10,000 or more require an admin. Amounts of RM25,000 or more require at least two distinct reviewers, including an admin. These thresholds are in `src/domain/operations.ts`.
- Dealers may request table income/payout entries. Cashiers additionally manage check-in, seating and cash transactions. Managers configure tables, profiles and business days; only admins reopen a closed day.
- Cash-out settles outstanding credit first and pays only the remainder in cash. Unpaid debt carries forward; a Credit Repayment records later cash repayment. Zero cash-out closes a visit without paying cash.
- Each ledger entry records cash received, cash paid and credit change once. Expected cash equals opening cash plus receipts minus payouts. Variance equals the physical count minus expected cash. Until counted, variance is unknown.
- Corrections require approval and append a compensating entry. Original transactions remain. Reverse dependent settlements first; a cash-out reversal requires the original seat to be available and no later visit.
- Close a business day only after all players leave and all requests are resolved. Explain any cash variance. Closing snapshots survive reopening. Opening another day preserves earlier records.
- Rake, tips, insurance premiums and jackpot contributions are treated as cash received; the corresponding payouts reduce cash. Record actual till movements only. Chip-only collections, multiple tills and a separate chip inventory are not implemented.
- Player P/L is cash-out value minus buy-ins for the selected day. Active visits show Unsettled. This excludes insurance, tips and other player-attributed entries; it is not a complete player profit statement.
- Jackpot and insurance report values are **daily net movements**, not cumulative fund balances. Opening cash is explicitly entered for each day.

## Persistence and architecture

`src/domain` contains validated commands, business rules and selectors. `src/server` owns password hashing, session validation, SQL transactions and branch authorization. Route handlers authenticate every request, reject cross-origin mutations, and never trust a client-supplied role or username.

PostgreSQL stores users, hashed session tokens, memberships, request identifiers, and one JSONB business aggregate per branch. A row lock and revision check prevent lost updates; an operation identifier prevents duplicate posting when a request is retried. A successful response follows a committed transaction. Browser records refresh every 15 seconds and on focus. Conflicting edits ask the user to review fresh data before retrying.

The UI keeps unsent drafts in memory across module navigation. Reloading, signing out, changing language or switching branches clears those drafts. Business data is never stored in browser localStorage. Old prototype localStorage is neither trusted nor imported.

### Boundaries before larger rollouts

The branch aggregate deliberately keeps ledger, seats, approvals and audit updates atomic, but reads/writes the full branch history. UI pagination currently limits rendered rows, not database transfer. Before high-volume operation, split the aggregate into indexed ledger/session/approval tables, add server pagination and load-test against the intended staff concurrency. PGlite tests do not replace production PostgreSQL load/restore tests.

The application prevents editing original entries through its API, but database administrators can change stored JSONB. External immutable audit retention, MFA/SSO, granular read permissions, organization-level reporting, currency configuration and disconnected multi-device synchronization are not implemented. Local mode runs without cloud services on a single computer. Authorized branch staff currently see the branch's complete operational records. Do not treat the audit log as tamper-proof.

## Verification

The interface uses shadcn/ui across navigation, dialogs, forms, record lists, approvals, and feedback. Players and transactions use compact cards on phones and tables on wider screens. Create/edit dialogs keep validation beside the relevant field, preserve input after errors, and close after a successful save. Returning-player check-in preserves the existing profile; edit actions open the selected record directly. Daily closing shows unresolved visits and approvals before accepting a cash count.

```sh
yarn test
yarn typecheck
yarn lint
yarn build
```

Tests use isolated in-memory [PGlite](https://pglite.dev/docs/) PostgreSQL, never the configured production database. They also verify file-backed local restart persistence and idempotent account setup. They cover authentication/session expiry and revocation, persistent login throttling, branch isolation, stale/concurrent writes, retry idempotency, money precision, approvals, debt, reversals, closing, staff access controls, calendar-range comparisons, and full backup restoration/rollback. `tests/local-workflows.test.ts` completes setup and an entire business day with cash/credit players, seating/moves, every ledger type, independent/dual review, rejection/correction, closing/reopening, another day/location, and a restored backup. Settings regressions cover differing table stakes, inherited overrides, feature switches, and closing the intended business day.

For an optional disposable browser test database:

```sh
node --import tsx tests/browser-database.ts
```

It binds to `127.0.0.1:55432`, has no network authentication, and loses all data on exit. In a separate terminal set `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres`, then run the setup commands. Set `APP_ORIGIN` to the matching local web origin. Never use this helper for real records.

CI runs the checks above. Next.js-specific implementation guidance is installed in `node_modules/next/dist/docs/`; read it before changing routing or server APIs.

### Staff workflows

- Player names open a profile with current-day balances, seat, and session history. Buy-in, cash-out, repayment, profile editing, and seat moves open shared dialogs with the player preselected.
- Available seats start check-in with the table and seat selected. Occupied seats open the player profile. Tables can be filtered by available seats, full tables, or closed tables. **Venue rules** provides a read-only reference for every staff role.
- Transactions have Pending, Approved, Rejected, and My requests tabs with shared search/date/type filters. Requests retain rejection reasons, reviewer history, and links to posted receipts. Approval previews use the same money calculation as ledger posting.
- The dashboard shows key metrics, cash-flow analytics, table occupancy, and recent recorded business-day trends. Pending requests use a compact notice linking to Transactions.
- The persistent header bell previews pending approvals and links to the complete queue. It preserves independent-review restrictions and clearly identifies requests requiring admin or additional review.
- Reports explicitly separate the current business-day controls from the selected report date. Report and audit records use cards on small screens. Audit details show readable field changes and support staff/action/date filters.
- Edited dialogs confirm before discarding changes. Reopening a form starts with fresh values; Save/Cancel actions stay visible while scrolling. English/Chinese dates follow the branch timezone, and login includes a password visibility control.
- Dialogs bind to the records reviewed when opened; polling cannot silently replace the revision under an unsaved edit. Closing also identifies the intended business day. An unconfirmed request can still be retried after polling changes the form's enabled state.

`tests/ui-workflows.test.ts` covers settlement/reversal previews, request status filtering and receipt lookup, audit formatting, and localized dates. These automated checks do not verify rendered spacing, focus behavior, or mobile layout; those still require a browser pass.

### Layout reference and browser verification

The current shell takes layout guidance from [Mighty One](https://github.com/Mighty-Jaxx-International-Pte-Ltd/mighty-one), inspected at `develop@a0bd342`. The shallow reference clone is in the ignored `.local/references/mighty-one` directory. Adapted patterns include the compact sticky breadcrumb header, centered workspace, collapsible sidebar with account footer, page headings, search/filter toolbars, and bordered desktop tables. Buttons, status badges, inputs, tabs, and dialog sections use consistent shadcn presentation with responsive sizes. The existing theme colors, local authentication, and operating rules are retained. Venue settings, Staff accounts, and Controls and audit stay in the bottom Administration group, with collapsible module links.

The 2026-10-21 layout browser pass checked login and all seven management pages at 1440×1000 and 390×844, with no page-level horizontal overflow. It also checked mobile sidebar navigation, all Settings sections, transaction status tabs, search/filter and empty states, English/Chinese labels, table editing, new/returning-player forms, and unsaved-draft discard/focus return. Screenshots are in the ignored `.local/ui-review-2026-10-21` directory. This layout pass opened forms and previews without saving operational records. It fixed wrapped Settings tabs, stretched checkboxes, and Radix state/orientation selectors.

A separate workflow browser pass used disposable records with the saved sample rules: venue 5/10, buy-ins RM200–RM5,000 in RM50 increments; Reserve 10/25, RM500–RM10,000 in RM50 increments; manual rake guidance 5%, capped at RM50. Manager, cashier, and admin sign-ins completed cash/credit check-in, invalid buy-in rejection, independent buy-in/rake/tip approvals, admin-only cash-outs, repayment after checkout, returning-player check-in, and zero cash-out. Closing was blocked while players or approvals remained and when a cash variance lacked an explanation. The completed day reconciled opening RM10,000 + receipts RM1,560 − payouts RM1,200 = RM10,360, with zero variance; the CSV export matched. Desktop/mobile screenshots are in `.local/workflow-review-2026-10-21`. Next-day opening now selects a valid date after the latest recorded day rather than reusing an already closed date.

`tests/sample-rules-workflows.test.ts` and `tests/workflow-regressions.test.ts` exercise the exact sample rules through domain operations and authenticated repository transactions. They add coverage for occupied seats and moves, all ledger entry types, rejection/reversal, manager/admin/dual review, credit reservations and carryover, concurrent decisions, safe retries, stale forms, closing/reopening, branch isolation, and restoration into another isolated database. `tests/business-day-dates.test.ts` covers next-day defaults and calendar boundaries. These tests never connect to the persistent local database.

`tests/dashboard-summary.test.ts` verifies posted cash flows, compensating reversals, cross-day credit, open-table capacity, unresolved-request counts, and seven recorded dates without fabricated zero activity. `tests/approval-notifications.test.ts` verifies total counts, the five-request preview, current-user review eligibility, previous votes, and closed-day labels.

For UI testing alongside the persistent local app, run:

```sh
node --conditions=react-server --import tsx tests/ui-server.ts
```

This starts a separate app at `http://127.0.0.1:3001` with an in-memory database on port 55434 and build output in `.local/ui-next`. Test accounts are `qa.admin`, `qa.manager`, `qa.cashier`, and `qa.dealer`, all with the test-only password `ui-test-password`. Both test venues start with the sample rules and tables above and setup complete, with no business day, players, or transactions. All test records disappear when this helper stops; it does not use `.local/postgres`. Use the separate hostname as shown so test sign-ins do not replace the normal localhost session.

### Create and edit forms

Management forms share labelled sections, a single-column phone layout and paired desktop fields. Required fields have a visible marker; optional fields and inherited table defaults are explicit. Dialog headers and 44px action buttons remain outside the scrolling form body. The save button targets its form by ID, so both click and Enter preserve validation and the existing approval flow. Invalid fields receive focus, submit errors are focusable, and canceling an edited form offers continue/discard with focus returned to the opener. Staff password fields have separate accessible show/hide controls.

The local 2026-10-21 form pass reviewed all 13 management form sites, including conditional transaction, staff and day-control modes. Browser checks used 1440px desktop and 360/390px phone viewports, including required/money/phone validation, table presets/defaults, draft previews, password visibility, disabled closing controls and unsaved changes. Operational records and credentials were not saved during the review. Closed-day recovery remains protected and was reviewed in source and the existing workflow suite; it was not activated in the live practice venue. Screenshots and detailed notes are in the ignored `.local/forms-review-2026-10-21` directory.

### Tables and list views

Players, transactions, approvals, tables, locations, staff, audit history, player results, closing history, daily breakdowns and session history share named searches, live result counts and 20-row pagination. Filters apply immediately in a bounded popover, with removable criteria chips, a search-only clear button, and a Clear all action. Changing list criteria resets the page; the page also clamps when refreshed data reduces the result count. Empty records and searches with no matches use different guidance. Fixed summary comparisons and small reference lists keep their simpler presentation.

Frequent actions remain visible; secondary actions use a contextual shadcn menu. Existing role restrictions, approval requirements, disabled reasons and confirmation forms remain in effect. Tables switch to labelled cards below 1024px, with separate action areas and 44px phone controls. Report list filters only change visible rows: totals, comparisons and CSV exports use the complete selected report. Searching a read-only player history does not trigger a discard-draft warning.

The 2026-10-21 list browser pass used practice data to check combined filters, individual removal, trimmed searches, no-match recovery, page boundaries/reset, contextual actions and responsive layouts at 1440px desktop, 900px tablet and 360px phone widths. Screenshots and detailed scope are in the ignored `.local/lists-review-2026-10-21` directory. No operational records or account access were changed in this pass. Pagination remains client-side over the branch aggregate; it does not reduce database transfer.

### Final local workflow verification

The updated interface was tested through complete shifts at 1440×1000 desktop and 390×844 mobile using `tests/ui-server.ts` and an isolated in-memory database. Desktop checks covered required-field and buy-in validation, cashier/manager/admin/dealer access, new cash/credit check-in, moving between 5/10 and 10/25 tables, independent approval, every table-entry type, house cash receipt, rejection with a saved reason, cash-outs, a compensating reversal and closing. The desktop day reconciled RM10,000 opening + RM1,145 received − RM1,015 paid = RM10,130, with zero variance.

Mobile checks covered returning players, notifications leading to the queue, cash/credit buy-ins, admin-approved zero cash-outs, debt retained after checkout, independent repayment approval, variance validation, manager closing and admin reopening. Closing snapshots survived reopening and a second close. The mobile day reconciled RM0 opening + RM1,000 received − RM0 paid = RM1,000. Daily and full-period CSV files matched the reports even with a filtered daily breakdown. A second test venue remained empty; a backup comparison confirmed persistent venue records, accounts and memberships were unchanged.

This pass fixed inline date-boundary validation, misleading dual-review counts when an admin was still required, and obsolete validation errors after changing form requirements. Error resets preserve draft values, focus, revision safeguards and retry behavior. The final suite has 91 passing tests; lint, TypeScript and the production build pass. Staff account mutations, concurrency, retry/idempotency, backup restoration and remaining policy combinations are covered by the isolated automated suite; no real staff credentials were changed through the browser. Screenshots, CSVs and a detailed scope report are in the ignored `.local/final-workflows-2026-10-21` directory. Local Operations still needs its first business day and actual opening cash entered by staff before use.

### Minimal table floor layout

The table floor uses a neutral nine-seat map with readable 16px numbers and 44px targets. Occupied seats open player details; available seats preselect the table and seat in check-in. Stakes, status and occupancy appear in the header, with buy-in limits and optional Details below. Existing permissions and closed-table restrictions remain in place, and short GSAP transitions respect reduced-motion preferences.

Seat centers follow ten stations equally spaced by arc length around the actual elliptical rail. Nine stations hold player seats; the unused bottom station leaves a blank dealer position between seats 1 and 9, without an icon or label. Seat 5 stays at the top. A pure geometry helper calculates the positions, and `ResizeObserver` updates them when the rail changes size. Desktop maps are horizontal; maps below the 520px container breakpoint use a wider portrait oval.

Player names sit outside the table beside their seats, joined by short connector lines. Captions use up to two lines with an ellipsis for longer names, at 12px on mobile and 13px on desktop. Natural word wrapping is preserved where it fits; overflowing names use character wrapping for reliable truncation. Full names remain in accessible seat labels, tooltips and player details. The profile description also wraps long unbroken names within the dialog.

Five geometry tests cover equal perimeter spacing against independent reference angles, circle spacing, rail alignment, symmetry, seat order, the blank bottom station, scaling and invalid measurements. Scoped lint and a fresh production build pass. Browser checks at 320px, 360px and 414px phone widths, 1440px desktop, and the exact 519px/520px map breakpoint found no overlapping targets or captions, labels inside the oval, or horizontal page overflow. Player-profile opening and focus return remain functional.

The opt-in `tests/ui-server.ts --table-layout` fixture exercises long Latin, CJK and unbroken names using only the disposable in-memory UI Test Venue; it does not connect to or change persistent venue data. Current practice screenshots are `48-even-seats-practice-desktop.jpg` and `49-even-seats-practice-mobile.jpg`. Long-name proof is in `44-even-seats-long-names-mobile.jpg`, `47-even-seats-long-names-desktop.jpg` and `45-long-name-profile-mobile.jpg`. Screenshots and earlier design notes remain in the ignored `.local/minimal-ui-2026-10-21` directory.
