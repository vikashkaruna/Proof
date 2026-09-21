# Estate management review — 21 September 2026

Reviewed staging `b380578` before implementing this chunk; fetch showed no newer upstream work. Its connector foundation is metadata, not executable connectivity. Original roadmap scope and accepted additions remain intact.

## Delivered

- Central `estate.manage` capability for founder, tenant owner and admin; analysts/viewers retain read access only. BFF writes pass the existing session/MFA/idempotency middleware; SQL repeats live membership authority under a lock.
- Migration 0034: atomic inventory mutation plus `append_ledger`, optimistic versions, archive guards, and explicit assignment of unassigned, unstarted intake assessments. Refused mutations do not append success events; audit failure rolls back the mutation.
- `/estate` renders tenant-scoped RLS data, handles empty/error states, and manages estates/systems without inventing connectivity. The browser retains the same intent/key after a lost response; no automatic retry under a fresh key.
- Category provenance correction: the original key could not represent both declared and observed copies of a category. The new key includes source, and declaration edits preserve observations. Before/after ledger snapshots include declared categories.
- Existing engagement creation now refuses archived estate bindings at the database boundary, including concurrent archival. Existing assigned history is retained.

## Review findings addressed during verification

The first archive test exposed a PL/pgSQL variable/alias collision; fixed before publishing 0034. The browser journey exposed a missing `/v1` prefix on the new bridge call; corrected. The pre-existing populated connector-upgrade assertion hashed every field, so adding `version` falsely appeared to mutate old content; it now compares the historical fields and separately asserts the new default. No published migration was rewritten. The isolated, synthetic Auth test stack was rebuilt while iterating the unpublished migration.

## Verification

298 BFF tests pass. PostgreSQL applies all 35 migrations, runs the authority suites, six concurrency suites and three populated upgrades, and verifies the DSN/deploy fail-closed lane. Real Auth parity passes under all four local topology labels, including exact replay with one audit event, cross-tenant denial, stale edits, explicit assignment and archived-scope refusal. Inventory browser coverage exercises create/edit/archive, read-only personas, a lost committed response with exact-key retry, and legacy-scope confirmation. Workspace lint/typecheck and formatting are part of the checkpoint gates. Exact final browser count and staging CI are recorded in the session checkpoint after completion.

## Pending, not silently promoted to complete

W3 remains partial. Next: normalized onboarding proposals and owner/admin review, then the resumable wizard, W3.5 graph and W4 runtime. The user explicitly approved **both owners and tenant admins** as proposal approvers; staff analysts prepare only. No additional policy question blocks that work.

W4 activation must serialize with estate/system lifecycle checks and enforce live grants per invocation. Active-connector archive refusal is not a replacement for broker/SVID authentication or execution approval. Connector rows do not confer authority. No external scan, client-system mutation, cloud deployment or retention lock occurred.

The E.2.3 question about MFA sessions after recovery-based replacement remains independent and unanswered. W0 deployed acceptance and W1 invitations remain open. No overall roadmap closure is claimed.
