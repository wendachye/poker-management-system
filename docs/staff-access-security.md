# Staff access safeguards

Implemented and checked locally on 29 October 2026. The staff UI and privileged operator CLI share account serialization, admin-coverage checks and session revocation. The public prototype still disables staff APIs before database access.

## Login resource limits

| Control                        | Scope                                                   | Current limit                                      |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------- |
| Login attempts                 | Shared PostgreSQL database                              | 120 per 60-second fixed window                     |
| Account attempts               | Known active username                                   | 10 per 15-minute fixed window                      |
| Anonymous attempts             | 1,024 deterministic buckets for unknown/disabled names  | Same 10 per 15 minutes                             |
| In-flight login work           | Each Node process                                       | 8 active, 64 queued, 5-second maximum queue wait   |
| Password derivation            | Each Node process, shared by login and password changes | 4 active, 64 queued, 5-second maximum queue wait   |
| Expired authentication records | Each accepted admission maintenance pass                | At most 100 throttle rows and 100 expired sessions |

These are application policy choices, not a hosted capacity guarantee. Successful sign-ins consume the global budget. Counters saturate rather than growing indefinitely. Each global/account claim commits before password verification, so an invalid password cannot roll it back. Window timing comes from PostgreSQL.

Unknown submitted usernames are not stored in throttle rows. Their normalized hashes select one of the reserved `!unknown:<bucket>` keys. Repeating an unknown name gets the same response policy as a known account; collisions can share anonymous capacity without consuming a real account's quota. Existing legacy throttle rows are retained until expiry and bounded cleanup; the bound concerns newly introduced anonymous keys, not a promise to instantly shrink old history.

A successful sign-in only clears its unchanged known-account claim. It cannot erase a newer concurrent failure or clear the global/anonymous budget. Expired queued work is discarded even when timer delivery is delayed, and active password work keeps its permit until the native callback completes.

Quota failures return 429; a full/expired work queue returns 503. The login handler attaches a bounded `Retry-After` only to authentication admission errors. It issues no new session cookie on rejection. Existing authenticated staff can continue using their sessions during login pressure. Both languages have retry/busy guidance.

Only the exact existing `scrypt:<32 hex salt>:<128 hex digest>` format can authenticate. Missing, malformed and unsupported hashes use fixed dummy derivation and fail. New passwords require 12–128 characters; existing short local passwords remain compatible. This change does not introduce a new work factor, automatic password rehashing or MFA.

The standard Next route request has no verified socket peer in this deployment. `Forwarded`, `X-Forwarded-For` and `X-Real-IP` never create a fresh quota. Verified per-source host/WAF protection, alerting and a tested ingress identity contract remain production gates. An attacker can consume a shared limit and temporarily prevent legitimate sign-ins; resource limits do not replace edge protection.

The design follows the tradeoffs described in the [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), including generic errors and lockout availability risks. Native derivation behavior is described in [Node's crypto documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback). The numerical limits above are this application's choices.

## Operator account commands

Use the documented [operator CLI commands](../README.md) from a controlled terminal with the intended database credentials. Account changes require an explicit human `--operator` label and `--reason`. Use the hidden password prompt or securely supply the existing process environment mechanism; never put a password in a command-line argument, ticket or audit reason.

- Creating an account explicitly selects its initial venue and role. Existing accounts require the explicit grant-existing command.
- Disabling a shared account checks every venue where it is an active admin. A role demotion checks the affected venue. The last active admin cannot be removed by either UI or CLI commands.
- Password, enable, disable and access changes revoke the target's sessions across all venues and clear its known-account lockout. They do not clear the shared global login budget.
- Re-enabling an account requires the password command with `--enable` and a new valid password. A password reset without that flag does not reactivate a disabled account.
- A missing target fails explicitly. A failure anywhere rolls back the account, sessions, all affected venue audits/revisions and retry records.

The commands take the same global account-table lock used by the staff UI, then lock affected venues in sorted order. The database principal (`session_user`) is recorded alongside the supplied human label. A reserved, disabled, membership-free technical identity owns those audit events; it cannot be enabled, granted access or modified through normal staff/operator commands. Passwords, password hashes and session tokens are not copied into audit before/after records. Each venue's audit contains only its own role for that shared account.

The CLI prints an operation UUID before prompting or changing data. If the outcome is uncertain, retry the exact command, human label, reason, password and `--operation-id`. HMAC fingerprints protect the saved retry record from exposing a plain password digest. An exact replay does not revoke a subsequently created session or reset a later password. Operation IDs retain the existing venue-scoped semantics; they are not a new globally unique command registry. The retry scope assumes memberships are not removed by a later command, which matches the current command set.

The CLI is a privileged database-operator tool, not an HTTP capability. Someone with unrestricted database credentials can still bypass application checks using SQL. External audit retention, operator access controls and a named recovery owner remain necessary deployment work.

## Migration and recovery

Migration v4, `bounded_authentication_admission`, adds the singleton global budget, expiry/user indexes and bounded-counter/reserved-name constraints. Published v1–v3 checksums remain unchanged. An incompatible legacy real username in the reserved anonymous namespace makes the upgrade fail atomically; counters and migration history stay unchanged until the data is resolved through a controlled recovery process.

Take and verify a complete backup before a real upgrade and run migrations with the release database identity. Health checks require the new table and migration history. Restore keeps the version 1 logical backup format, preserves operator audit/retry identities, revokes sessions and clears transient authentication counters, including the global budget. A restored environment must use fresh sign-in.

Local tests cover native PostgreSQL 17.11 races, UI/CLI competing admin changes, shared-account resets and revocation, safe replay after restoration, bounded cleanup, malformed hashes, delayed queues, uniform throttle responses and forged source headers. Hosted upgrade/restore rehearsal, sustained mixed traffic, ingress protection and staff acceptance remain separate release checks.
