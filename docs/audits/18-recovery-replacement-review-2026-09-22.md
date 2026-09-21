# Recovery replacement review — 22 September 2026

The user accepted re-verification after recovery-code replacement. Reviewed staging 8bb25b0, preserving all earlier W0/W3 work. No other-model changes appeared on fetch.

## Implementation and review

The previous service returned `satisfiedWith` but did not persist it. Activation had no way to distinguish recovery proof from TOTP proof, or to ensure that a pending enrollment was authorized for the factor it would retire. Migration 0036 adds challenge method and replacement provenance; BFF supplies the consumed challenge, never a caller-controlled policy flag. SQL checks user, purpose, factor, resource, satisfaction/consumption timestamps and known method under the factor locks. Unknown, legacy or stale provenance fails closed and the UI offers a restart.

Recovery activation revokes all existing user attestations in the transaction that swaps factors and recovery hashes. This includes assurance retained from a previous TOTP-authorized swap; otherwise a session from an older device could survive recovery. Current-factor replacement preserves assurance and unrelated users are untouched. Login passwords/sessions remain valid, but MFA gates require fresh assurance.

Account activation uses `FOR NO KEY UPDATE` before ordered TOTP row locks. This serializes account activations without conflicting with the user foreign-key key-share check in a concurrent attestation insert. The existing attestation trigger shares the factor lock; an insert either commits first and is revoked, or observes the retired factor and fails.

## Regression evidence

- 312 BFF tests and complete workspace tests/lint/typecheck passed.
- Real database suites cover both methods, missing/unknown/foreign/stale proof, recovery-write and final-attestation-write rollback, unaffected unrelated users, and both orderings of login racing replacement.
- Populated upgrade preserves existing credential rows and refuses legacy pending replacement until restarted.
- Four real Auth/PostgREST API configurations produce matching security outcomes.
- All 60 dev-server browser journeys pass, including two sessions denied after recovery activation and regaining access only through separate MFA verification. Final container and exact-merge CI results are saved in the private session checkpoint.
- Three SQL mutations are detected: removing session revocation, revoking current-factor sessions, and removing provenance refusal. Restoring the implementation passes.

The preceding acceptance run revealed shared analyst TOTP counters; isolating accounts then exposed a missing internal-staff fixture flag. Both fixture issues are corrected without weakening replay protection or Workbench authorization. Earlier failed/superseded runs do not count as closure evidence.

## Limits and handoff

Tip 0036: 37 migration files, unchanged 51 public tables and W2 named target count 19/40. Deploy migration and BFF/web together. Never infer historic verification methods when upgrading. W1 invitations and remote acceptance remain open. W0 durable marketing/IAM findings, W3 full wizard/graph and W4 connector runtime remain pending. No cloud provisioning, mail, client execution or retention changes.
