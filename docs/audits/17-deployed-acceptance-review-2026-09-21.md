# Deployed acceptance review — 21 September 2026

Reviewed staging `d386fad`; no newer other-model changes appeared on fetch. Existing W3 inventory/proposal work is retained, including the accepted owner/**tenant admin** review policy. The unfinished W0 deployed harness remained engineering work and was completed before moving to the next runtime dependency.

## Findings and fixes

- A base URL alone left browser seeding, marketing requests and cookies pointed at local fixtures. Explicit private target configuration now binds every surface, identity, key and source revision. Local and deployed state use separate directories. Unsafe/ambiguous origins and broadly readable credential files are refused.
- Strict parity used an embedded BFF and local labels. The same suite now runs over HTTP against actual BFF services. BFF and SSR health endpoints identify environment, strict auth and source revision; comparison requires distinct endpoints/environments, matching revisions/suites and successful results. Matching browser failures cannot count as parity.
- Fixture MFA assumed knowledge of a fixed encryption key. Deployed fixtures enrol through real MFA APIs; the runner never needs backend signing/encryption keys.
- SSR configuration required a service-role key it did not use, while ambient Next/package hints could weaken backend validation. A dedicated public-field loader now supplies SSR; both loaders share auth/public-connection rules, and backend credentials remain mandatory independent of ambient hints. Tests cover each hardened environment, credential stripping, caches and bypass refusals.
- Container builds omitted workspace manifests. Dockerfiles now include MFA/eslint dependencies and exclude private environment/runtime state from build context. Release metadata covers BFF, web and marketing; the local acceptance script refuses uncommitted sources.
- CI now includes actual production-container API/browser parity. A separate manual workflow supports two isolated remote deployments and compares both suites. Only sanitized result artifacts are uploaded. External contact-form email, raw traces and credential-bearing reports are excluded from deployed runs.

## Validation and limits

Local production-container rehearsal: **59/59 browser journeys for each of preprod and production configuration**, plus identical API outcomes, with real Docker Auth/Postgres through 0035. Web/marketing ran without database service-role, approval-signing or MFA encryption keys. The ordinary dev-server browser suite also passed 59/59. Workspace tests (14 packages), including 309 BFF and 54 configuration tests, passed; 24 harness checks, harness/workspace typecheck, lint and W0 security gate passed. Container registry downloads required a retry; application builds then succeeded.

The pre-commit local rehearsal validates the implementation, not release provenance. The committed staging CI gate rebuilds and exercises the named source revision. Exact final merge and CI URL belong in the ignored session checkpoint; do not infer remote acceptance from either local lane.

No migration added (36 files, tip 0035). No cloud provisioning, external execution, COMPLIANCE lock or third-party mail. Remote W0 closure still needs provisioned isolated targets and a green manual comparison run; manual dispatch requires default-branch workflow availability. W1 invitations/E.2.3, W2 missing named targets, W3 full wizard/graph and W4 runtime remain open. See Docs 11, 15–17 for the continuation path.
