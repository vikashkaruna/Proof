# Review 12 — W1 revocation and login quarantine

Reviewed staging `1990304` and its green CI [35608576106](https://github.com/vikashkaruna/Proof/actions/runs/35608576106). Kept the other model's replacement transaction, browser journeys and decision register. This checkpoint completes operator-runbook C-W1-1 and C-W1-2 locally; it does not close W1 deployment acceptance.

## Findings and implementation

1. **Revocation was two independent writes.** The factor was retired first; a failed session-attestation update was logged and success still returned. Migration 0031 now revokes the active factor, pending replacement, recovery credentials and the user's MFA attestations in one transaction. SQL fault injection on the attestation update proves the factor change rolls back too. An absent/foreign/inactive factor cannot change anything.
2. **Login could race removal.** A database insert guard locks the same active TOTP factor before issuing new session assurance. Two real PostgreSQL connections prove both orderings: a login that wins is subsequently revoked; a revocation that wins refuses the late attestation. The guard checks ownership, not just the supplied factor ID.
3. **Unused was not the same as active.** Recovery-code verification checked `consumed_at` but ignored revoked status. Both the read and conditional claim now require active status, as does the TOTP counter claim. A challenge opened before revocation cannot consume an unused revoked recovery code. Counts shown to users include only active unused codes.
4. **UI paths were absent.** Revocation now opens a purpose-bound step-up, collects a current code/recovery code and explains the consequences before confirmation. The quarantined enrollment page offers explicit continuation only after recovery codes are saved. Enrollment does not attest the session: the browser proves 403 before enrollment, 401 after activation, and 200 only after login verification; a fresh password-only session is quarantined again.
5. **Handoff accuracy.** W2's literal target list has 40 names: 12 delivered and 28 absent. Doc 16 now distinguishes pending engineering from operator deployment, preserves the accepted self-hosted Supabase direction, scopes identity seeding to the migration phase, and warns that the deployment script's default `--dry-run` is not a guarantee of zero setup side effects.

## Validation

- BFF: 284 tests; existing replacement route coverage retained and new revoke proof/binding/replay assertions added.
- Database: 32 migrations, SQL assertions under service_role without BYPASSRLS, five two-session concurrency suites, populated estate upgrade and DSN/deploy failure checks.
- Real GoTrue/PostgREST parity across four local topology labels: green. These are configurations of one local stack, not four deployed environments.
- Browser: 55 passed, including eight enrollment/replacement/revocation/quarantine journeys; credential-mutating journeys ran again without reseeding.
- Mutation checks: the prior UI fails the quarantine-continuation journey; removing recovery active-status checks fails the stale-challenge test. Mutations are temporary and restored byte-for-byte.
- Workspace typecheck, lint and formatting are checked before commit; final staging CI is checked after push.

## Remaining

Replacement session policy E.2.3 is still awaiting the user's answer. Revocation is unambiguously distinct: it ends all MFA assurance. Existing replacement attestations remain unchanged.

The review found another activation boundary to close next: migration 0030 swaps TOTP factors atomically, but the BFF deletes and regenerates recovery codes in separate writes after the swap. A persistence failure can leave the new factor active with an incomplete recovery set. Fixing this is the next W1 security chunk before the W2 connector schema batch. Invitation workflow/delivery and deployed MFA/key-ring acceptance remain outstanding. No billable deployment, immutable bucket lock or client-system execution occurred.
