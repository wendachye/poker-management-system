# Local practice pilot

This pilot uses the full application and local PostgreSQL with fictional records, existing local accounts and the current practice rules. Cloud staging and real operating rules remain deferred.

## Open the system

Start Docker Desktop and run `npm run local:postgres` from this repository if the app is stopped. Open [the local sign-in page](http://localhost:3001/en/login), sign in with an existing local account, then choose **Local Operations** in the venue selector. Refresh once if the newly assigned venue is missing from an already open page.

Existing passwords remain unchanged. The initial practice sign-ins and restart instructions are documented in [Local PostgreSQL](local-postgres.md); that page also explains that later password changes are preserved.

| Account         | Assigned role | Practice responsibility                                    |
| --------------- | ------------- | ---------------------------------------------------------- |
| `local.admin`   | Admin         | Review setup, staff access and administrative approvals    |
| `local.manager` | Manager       | Review requests independently and supervise reconciliation |
| `local.cashier` | Cashier       | Check in players and submit financial requests             |
| `local.dealer`  | Dealer        | Exercise the table functions available to this role        |

Use separate browser profiles or private windows for different accounts. Signing into another account in the same cookie session changes that shared session and can trigger the access-recovery safeguards.

## Venues and rules

**Local Operations** is the separate clean practice venue. Preparation creates tables, rules and access records only: no players, visits, business days, buy-ins, cash-outs or approval requests. The first practice day is opened manually by staff.

**Local Sample Venue** and **Second Sample Venue** retain their previous fictional histories. Second Sample Venue already contains past practice records; it is not an empty replacement for Local Operations. Do not reset or rename either venue to imply it is clean.

| Table      | Stakes      | Buy-in range   | Increment |
| ---------- | ----------- | -------------- | --------- |
| Main floor | RM5 / RM10  | RM200–RM5,000  | RM50      |
| Reserve    | RM10 / RM25 | RM500–RM10,000 | RM50      |

The copied practice settings use MYR, Texas Hold'em, Asia/Kuala_Lumpur time, 5% rake with an RM50 cap, and enabled credit, tips, insurance and jackpot functions. These are practice values, not confirmed real operating policy. Existing approval rules remain in force; the requester cannot approve their own request.

## Rehearse one day

1. As admin or manager, review the selected venue and rules, then open a practice business day with an agreed fictional opening balance.
2. As cashier, check in a fictional cash player and choose a table/seat. Submit an RM500 cash buy-in. In the manager's separate browser session, review and approve it. Confirm the receipt and balances before continuing.
3. Submit the cash player's cash-out, review it independently and confirm that the player leaves the active seating list only after the approved settlement.
4. Check in a fictional credit player with an agreed practice credit limit. Rehearse an RM500 credit buy-in, an RM200 repayment and a cash-out. Review the debt offset and actual cash payout shown by the preview before submitting or approving it.
5. Rehearse the exception paths: reject a deliberately duplicated request; correct an approved fictional transaction through the reversal workflow; approve the reversal independently; then submit the intended replacement.
6. Search and filter players, requests, transactions and audit history. Try another venue in a separate session and confirm the records stay separate. Export a report and confirm it includes the complete selected report, independent of the visible player-list filter. Navigating away from Reports cancels pending live exports; returning from Date range to Daily also cancels an in-flight range export.
7. Before closing, resolve pending requests, settle active visits and compare the expected cash with the fictional count. For a deliberate practice difference, enter the actual differing count and a clear explanation. Review closing history after any reopening and recount.

Do not assume another person's click succeeded. Review the request status or use the displayed recovery action after an uncertain response; preserve the original operation rather than entering a duplicate request.

## Backup routine and recovery

Before the first pilot session and after each completed practice day, run:

```powershell
npm run local:postgres -- --backup
```

The command reads one consistent snapshot through the restricted runtime role, saves a private archive, rereads the actual file and restores it into a disposable database for verification. It does not restore or reset the running database. Keep the verified report and archive together under the existing private backup directory; archives contain account hashes and venue history and must remain outside Git.

A local archive on this computer is not protection against losing the computer. Choose a separate secure offline copy location before using real records. Retain the original volume and credential file during restart or troubleshooting. Restore into an isolated target and compare balances, approvals, audit history and retry identifiers before considering any replacement of the source database.

## Acceptance record

Record the candidate commit, test date, accounts/roles used, venue/rules reviewed, completed cash/credit/exception cases, opening/closing balances, differences, report checks and verified backup reference. Capture any problem with the screen, action, expected result and actual result; omit passwords, tokens and private archives.

The local release rehearsal uses disposable venues and a separate database. Its performance and correctness results are recorded in [Capacity plan](capacity-plan.md). Passing that bounded rehearsal supports a supervised practice pilot; hosted security, recovery targets, retention sizing, physical-device checks and real staff acceptance remain separate rollout work.
