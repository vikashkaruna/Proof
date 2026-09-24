# Review 14 — W2 connector foundation

Continued in runbook dependency order after both MFA milestones. Reviewed staging `6271699`; CI [35618777188](https://github.com/vikashkaruna/Proof/actions/runs/35618777188) is green, including the corrected database race harness. No intervening upstream work was found at the start of this batch.

Migration 0033 delivers the seven connector tables named by W2. Tenant-owned tables use membership-bound reads and tenant-consistent FKs, including workload/agent consistency on grants. `connector_credentials` has no authenticated SELECT grant or policy; envelopes are BFF/broker-private. It stores envelope fields only, not runtime tokens. The encryption/decryption implementation is W4 work, so a table holding correctly shaped bytes is not a claim that a credential was safely encrypted or used.

Descriptors are global **non-secret** catalogue metadata; they require explicit transport, target provenance, version and JSON manifest. The database computes the content hash; a connector's descriptor/provenance pair is an FK. Service-role UPDATE/DELETE are denied for published descriptors, tool registrations and health observations. Tool classification is mandatory, descriptions are hash-pinned, and no inbound MCP server was added. Workload registrations default disabled, connectors default draft. Grants can represent only Drishti reads or Karya writes and require an expiry. These are model constraints, not a substitute for W4 workload authentication and approval-bound credential issuance.

Validation:

- 34 migrations, direct SQL positive/negative security tests under service_role without BYPASSRLS, five concurrency suites, three populated upgrade paths and DSN/deployment failure checks.
- Real GoTrue/PostgREST reads for all five tenant-visible connector tables, browser credential denial, browser mutation denial, privileged cross-tenant link refusal and Drishti write refusal, repeated under four local topology labels.
- Shared types: 42 tests, including required provenance, bounded grant lifetime, allowed agent split and mandatory tool classification; workspace typecheck/lint green.
- SQL fault mutation: granting browser SELECT on credentials makes the new regression fail. Restore was byte-for-byte; final tests run on restored source.
- A populated 0032→0033 database preserves its existing system digest and creates no connector/credential/grant rows. Seven new tables start empty.

The first disposable migration attempt exposed PostgreSQL's generated-expression immutability check on `convert_to`; before any persistent application, the migration was corrected to use a pure fixed-UTF8 digest helper, consistent with existing snapshot hashing. Applied history was not edited.

Current status: 19 of 40 named W2 targets delivered, 21 absent. Direct inspection of the migrated local stack finds 49 public tables overall. W4 runtime remains pending: registry workflow, broker, SVID validation, per-invocation expiry/revocation/approval enforcement, health probes and transports are not built. No scan or client-system mutation ran. Next independent chunk is W3 estate management API/UI, preserving capability checks, audit/idempotency and explicit human scope assignment.
