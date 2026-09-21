# Axiom Proof — Phase 0–5 Gap Closure Plan

### Axiom Minds Private Limited · https://axiomminds.ai

**Document:** 11 · **Revision 25 — CONNECTOR DATA FOUNDATION** (21 Sep 2026) · **Status:** W0/W1/W2 partial; later intentional W5/W7/W8/W9 work preserved.
**Reviewed staging:** `6271699`, green CI [35618777188](https://github.com/vikashkaruna/Proof/actions/runs/35618777188); includes both MFA milestones and the CI portability fix.
**Scope:** marketing site, workbench, client portal — frontend, backend, data, infra, tests.
**Per-workstream status:** the [workstream status register](#workstream-status-register--as-at-revision-22-21-sep-2026) below carries W0–W10, re-derived from the repository rather than from the previous revision.

## Revision 25 — current implementation checkpoint

W2 connector schema batch, migration **0033**: `connector_descriptors`, `connectors`, `connector_credentials`, `connector_grants`, `connector_health_checks`, `workload_identities`, `mcp_tool_registry`. Every tenant-owned relationship uses composite foreign keys; membership RLS works without a JWT tenant claim. Browser roles cannot read credential envelopes or mutate any of these tables. Descriptors and tool registrations are append-only for the service role and carry database-computed content hashes. Target provenance is required and descriptor/instance-consistent. Only Drishti read and Karya write grants can be represented; the workload/agent binding is enforced by a composite FK.

This is **W2 data foundation**, not W4 acceptance. No registry API, broker encryption/decryption, SVID authentication, grant enforcement per invocation, connector transport, credential issuance or external mutation is implemented by these rows. Health records in tests are explicitly fixtures. A connector defaults to draft; a workload registration defaults to disabled. Descriptor manifests are non-secret catalogue metadata; credential envelopes have no browser response schema.

The populated 0032→0033 upgrade leaves the existing system unchanged and all seven new tables empty. SQL security/constraint tests, real GoTrue/PostgREST isolation across four local topology labels, and shared contract tests pass. A temporary browser SELECT grant makes the credential regression fail. Migration allocation is **0000–0033** (34 files). The named W2 set is now **19 of 40 delivered, 21 absent**; direct `pg_tables` inspection finds **49 public tables** overall, correcting the earlier 43 count at the pre-connector checkpoint.

W1 invitation/deployed acceptance and E.2.3 remain open. Next: W3 estate management API/UI using the existing model, then W4 registry/broker/grants; W5 execution details require the stable W4 grant model. See [review 14](audits/14-connector-foundation-review-2026-09-21.md), progress, handoff and Doc 16. No cloud apply, scan or connector execution.

---

## Revision 24 — prior implementation checkpoint

Migration **0032** closes the activation failure boundary found in review 12. `finalize_totp_enrolment` swaps the authenticator and replaces its recovery set in one transaction. Recovery codes cross the database boundary only as hashes; the old rows are retained but revoked. A failed recovery insert rolls back the factor swap, old-code retirement and replay counter. BFF errors distinguish storage failure (503) from a rejected code or missing pending enrollment. The old three-argument activation primitive is no longer callable by `service_role`; deploy 0032 together with the updated BFF.

SQL fault injection proves a recovery-write failure leaves old credentials usable, followed by a successful retry. The populated 0031→0032 upgrade preserves every credential row. Local real-Auth parity and enrollment/replacement browser journeys pass. The Revision 23 CI failure was the concurrency script assuming `rg` existed on the runner; it now uses portable `grep`. No security condition was relaxed.

W1 remains partial for invitations, deployed verification, and the unanswered E.2.3 replacement-session decision. Next independent implementation is W2's seven-table connector schema batch, followed by W3 estate management. See [review 13](audits/13-atomic-mfa-recovery-review-2026-09-21.md), Doc 14, Doc 15 and updated Doc 16. Migration tip **0032**.

---

## Revision 23 — prior implementation checkpoint

Completed C-W1-1 (factor revocation UI) and C-W1-2 (enrollment during login quarantine). The UI collects a purpose-bound proof before revocation and shows the effects before confirmation. A first-time quarantined user can enroll, save recovery codes and explicitly continue to login verification; activation alone grants no session assurance.

Reviewing staging exposed a failure boundary behind the existing revoke endpoint: factor removal succeeded even if ending its sessions failed. Forward migration **0031** replaces that best-effort pair with a transaction that revokes the user's active/pending credentials, recovery set and all MFA session attestations together. New attestations must hold an active factor for that user; real two-session races in both orderings prove a concurrent login cannot leave assurance behind. Recovery verification and counter claims now require active credentials as well as unused codes/counters.

**Remaining W1:** invitation delivery and deployed acceptance, plus the pending founder decision on session invalidation after recovery-based replacement (E.2.3). Explicit revocation is separate from replacement and ends assurance unconditionally. Review also found that activation swaps the TOTP rows atomically but still refreshes recovery codes in separate writes; that failure boundary is the next security chunk. W1 is not closed.

The W2 target list contains **40** names, **12 delivered and 28 absent** (including the two existing auth tables). The previous register's 34 total was inconsistent with its own named groups. W0 code delivered so far is tested, but deployed harness work remains engineering work, not solely an operator obligation.

Evidence and limitations: [review 12](audits/12-w1-revocation-quarantine-review-2026-09-21.md), [progress](14_Implementation_Progress.md), [operator runbook](16_Operator_Completion_Runbook.md). Migration tip **0031**; no cloud apply or client-system execution.

---

## Revision 22 — prior implementation checkpoint

Migration **0030**. W1's replacement path, which Revision 21 carried forward as
a UI gap and which turned out to be broken at three layers — each one hiding
the next.

**A refusal that looked like a control working.** The Replace button called
`POST /v1/mfa/enrol` with no `mfaChallengeId`, and the BFF refused it with
`mfa_challenge_required`. That refusal is correct, and it is why the defect
survived review: a gate that refuses every caller is indistinguishable from a
gate that works. Because no request had ever cleared it, nothing had ever
reached the code behind it.

**What was behind it.** `user_mfa_factors_one_active_totp` (migration 0012) is
UNIQUE on `user_id` WHERE `totp AND active`. Activation promoted the pending
factor with a bare UPDATE and never retired the one being replaced, so it
raised `23505` for any user who already held a factor — and the service
reported that unique violation as `no_pending_factor`, rendered as "No
enrolment is in progress". A reason that names the wrong layer is worse than no
reason: fixing only the UI would have swapped a clean refusal for a confusing
one, arriving after the user had been shown a new secret.

**The fix, in three parts.** `activate_totp_factor` (0030) retires the replaced
factor and activates the new one under one set of row locks. Neither order is
safe from outside a transaction, and revoke-then-activate is the worse of the
two for a reason beyond lockout: a first enrolment is deliberately not step-up
gated, so an account momentarily holding no active factor is one a stolen
session can enrol its own device on — the revoke-then-re-enrol chain the
enrolment gate exists to break. The security page now opens the `enrolment`
challenge, satisfies it with the current authenticator or a recovery code, and
spends it, carrying a per-attempt `Idempotency-Key` because it is the third
caller of `/v1/mfa/challenge` and the bridge's derived key is fixed for its
body. `BeginMfaEnrolmentRequestSchema` declares `mfaChallengeId`, which the
route had been reading off the raw body — an undeclared field is a contract
nobody can see, and no client sent it for exactly as long.

**Coverage, where there was none.** `/v1/mfa/enrol` had no route test at all;
seven now. A SQL suite covers 0030 and separately asserts the unique index
still bites, so dropping it cannot make the function's own tests pass while two
live authenticators quietly become possible. Five browser journeys cover first
enrolment, replacement by TOTP, replacement by recovery code, single-use
consumption and both refusals. The in-memory PostgREST double now models the
unique index rather than being more permissive than the database — it was that
permissiveness that let the bare UPDATE pass every unit test in the repository.

The journeys provision their own accounts instead of borrowing seeded personas.
Enrolment and recovery-code consumption are state transitions on the account,
so persona-based journeys pass once on a freshly seeded database and fail on
every rerun — under `retries: 2` that appears as a product flake rather than a
fixture defect. Confirmed re-runnable by running them twice against an already
mutated database.

**Delivered:** replacement by current factor and by recovery code, atomic
retirement of the replaced factor, and the coverage above. **Pending:** factor
revocation through the UI, enrolment under login quarantine, and estate
management APIs/UI. W1 remains partial. Migration allocation is through
**0030**.

**Open decision, not an oversight.** Replacing an authenticator does not
invalidate live session attestations made with the retired factor. Where the
replacement was satisfied by a *recovery code*, the user by definition did not
have their device, and whether that should end sessions the lost device
attested is a posture question with a real cost either way. It is recorded in
E.2 rather than answered here.

Per-workstream status for every workstream, not just this one, is in the
[workstream status register](#workstream-status-register--as-at-revision-22-21-sep-2026)
immediately below. See also
[review 11](audits/11-w1-authenticator-replacement-review-2026-09-21.md),
[progress](14_Implementation_Progress.md), and
[session handoff](15_Session_Handoff.md).

---

<a id="workstream-status-register--as-at-revision-22-21-sep-2026"></a>

# Workstream status register — as at Revision 25 (21 Sep 2026)

One maintained table rather than a per-revision delta, because a reader asking
"where is W4?" should not have to reconstruct it from six revision sections.
Baseline review: `3c1275f`; W1 and migration/count evidence updated in Revision 23. Historical measurements elsewhere in the table are labelled by their checkpoint.

**Status vocabulary** (shared with [Doc 13](13_Roadmap_Traceability.md)):
**Closed** — exit criteria met and held by a test or CI gate. **Partial** —
foundation delivered and proven, named acceptance outstanding. **Pending** —
not delivered; a stub or a page shell does not qualify. **Gated** — blocked on
a founder decision or on a deployment this workspace is not authorized to make.

| # | Workstream | Status | Proven, and by what | Not proven |
| --- | --- | --- | --- | --- |
| **W0** | Security remediation & environment parity · P0 blocking | **Partial** — code **Closed**, deployment **Gated** | W0.0 and W0.2 are closed and held by the CI gate. Zero environment-conditional security branches; the only two matches are a marketing URL resolver the plan explicitly names as topology and a comment recording the removed defect. `axiom_e2e_bypass` has no reader anywhere. SEC-3 is closed: **zero** service-role calls across the 22 `apps/web` files, with the baseline file now empty and acting as a ratchet. SEC-4/5/6/10/11/12/13 each carry a regression test. Four strict-parity topology labels produce identical security outcomes. | W0.1. There is no provisioned preprod database and no deployed parity lane. The four parity labels are **one local stack under four configurations**, not four deployments. Blocked on the first real deploy, which the founder has reserved. |
| **W1** | Tenancy, RBAC, MFA, personas · P0 | **Partial** | All 22 web files go through `requireTenantContext()`, so RLS enforces tenancy for every query the web app makes. Capability matrix and central `authorize()` in `@axiom/types`; `approval_scopes` is genuinely read, proven by a scoped approver who differs from an unscoped one *only* by that column. MFA: TOTP, recovery codes, login quarantine, approval-time step-up, key-ring rotation, and — Revision 22 — authenticator replacement with atomic retirement of the factor it replaces. 55 browser journeys under `AXIOM_AUTH_MODE=strict` with real GoTrue accounts, including revocation and quarantined enrollment (Revision 23). | Revocation UI and quarantined enrollment delivered in Revision 23. Atomic recovery rotation delivered in Revision 24. Remaining: invitation/email flow and deployed acceptance. Whether a recovery-code replacement should invalidate session attestations made with the retired factor — [E.2 item 3](#e2-still-open--not-blocking-needed-before-the-workstream-that-uses-it), an open decision, not an oversight. |
| **W2** | Data model completion · P0 | **Partial** | Migrations **0000–0033**, 49 public tables, applied and re-applied cleanly with immutable history and a checksum ledger; the suite runs with `service_role nobypassrls`. Delivered of the named target set: the estate group (4), W7.0 regulatory group (6), auth group (2), and connector group (7, via 0033): 19 of 40 named targets. Plus MFA, execution claims, dispatch outbox, atomic onboarding, approval issuance and reconciliation. | **21 of the 40 named target tables do not exist** — verified against the migrated database, not by grep. All 5 W5 execution-detail tables, all 4 W6 monitoring/policy tables, all 4 W7.3/7.4 multi-regulator tables, all 4 Phase 1/2 parity tables and all 4 W8 rights/consent tables. |
| **W3** | Client estate & onboarding · P1 | **Pending** | Nothing of W3 itself. The 0029 schema it will build on is delivered and counted under W2, and engagement creation accepts an optional `estateId` under its existing capability gate. | Estate management API and UI, onboarding proposal normalization, and human-confirmed assignment of legacy engagements. Accepting a link to an estate is not managing one. |
| **W4** | Universal Connection Framework · P1 XL | **Pending runtime**, W2 schema delivered | Seven supporting tables, shared metadata contracts and isolation tests via 0033, counted under W2. | No registry API, descriptor validation/publishing workflow, credential broker, SVID validation, live grant enforcement, health probes or transports. The connector page remains a shell. Database rows are not executable authority. |
| **W5** | Phase 3 execution loop · P1 XL | **Partial** | The *authority* machinery is real and tested: signed scope-bound approval tokens, bounded nonce replay defence, execution claims with serialization proven by a held-open two-session race, the dispatch outbox, atomic reconciliation and the kill switch. | The executor. Karya refuses mutating execution without a signed token **by design at this phase** — a deliberate refusal stub, not a defect, and not a PRD B.10 completion claim. Zero of 5 execution-detail tables. |
| **W6** | Continuous compliance · P1 | **Pending** | Nothing. | Zero of 4 tables. A monitoring page shell and a controls-drift script exist; neither is this workstream. |
| **W7** | Control library & multi-regulator · P0-adjacent | **Partial** | 46 controls, with a CI gate proving every count in the repository agrees with the library, a TS→runtime parity gate against drift, and citation tests. The full W7.0 regulatory baseline group is in the database. | Multi-regulator and sector packs: `frameworks`, `framework_controls`, `control_mappings`, `sector_packs` — all 4 missing. Sectoral pack #1 is an open founder decision ([E.2 item 1](#e2-still-open--not-blocking-needed-before-the-workstream-that-uses-it)). |
| **W8** | Reporting, evidence, branding · P1 | **Partial**, retention **Gated** | The evidence package and the gap-scan report exist and are tested. | Real immutable retention, which **cannot** be proven from here: an evidence-bucket Object Lock is a COMPLIANCE-mode lock nobody, including the project owner, can shorten or delete. Deliberately out of scope rather than skipped. The 4 rights/consent tables are missing. |
| **W9** | Test, audit and performance · P0, alongside | **Partial** | 17 CI jobs green on this head. 279 BFF, 40 web, 178 MFA, 14 packages; the database suite over 31 migrations; four concurrency suites; DSN failure checks; strict parity across four labels; 52 browser journeys; a security scan. Mutation testing is the working convention, not an aspiration. | **Performance is untouched.** No load lane, no budget, nothing measured — `k6`, `artillery`, `p95` and `benchmark` match nothing in the repository. PERF-3 (rate limiting) is delivered via `take_rate_limit`; PERF-2's estimated counts are not. NFR-7 (1M records/hour/connector) cannot be load-tested until W4 lands. |
| **W10** | On-prem deployment environment · P2 | **Partial** | The Helm chart renders, passes `kubeconform` and a semantic gate, and the self-hosted Supabase topology rehearsal is green in CI. | No deployed on-prem instance. Air-gapped operation is unexercised. A chart that renders is an artifact, not a running deployment. |

**What it takes to move W0–W3.** The ordered operator steps — configure,
deploy, migrate, seed, verify — together with the evidence each one returns and
what I do with that evidence to flip a status, are in
[Doc 16, the operator completion runbook](16_Operator_Completion_Runbook.md).
Every item there names one owner, because the four workstreams split unevenly:
W0's deployment awaits the operator and its deployed harness still needs engineering, W2 and W3 are almost
entirely mine, and W1 is genuinely shared.

**Reading the register honestly.** Six of eleven workstreams are Partial, two are
Pending outright, and W0's remaining half plus W8's retention are Gated on things
this workspace is not permitted to do. The P0 band (W0 code, W1, W2, W7, W9) is
where the delivered work is concentrated; the XL workstreams that make up the
actual product loop — W4's connectors and W5's executor — are the ones with
almost nothing in them, and W5's own tables are empty because W4 has to land
first. Nothing here states or implies that a scan, a connector or a mutating
execution has ever run.

---

## Revision 21 — prior implementation checkpoint

W2 estate foundation, migration **0029**: `estates`, `estate_systems`, `system_data_categories`, `estate_scans`, and an optional estate reference on engagements. Every relationship uses a tenant-consistent composite foreign key. Authenticated clients have membership-bound reads only; the BFF has explicit policies that work without BYPASSRLS. Referenced records cannot be deleted out from under their history; estates/systems can be archived. A queued scan is metadata, not evidence that discovery ran.

Existing engagements remain unassigned rather than being silently mapped to an invented estate. The engagement-creation API accepts an optional `estateId`, retains its capability gate, and the database rejects another tenant's estate. Shared Zod models and branded IDs describe the new entities. The upgrade test applies 0029 to a populated 0028 database and verifies the assessment survives unchanged with a null estate reference.

Reviewed and retained the other model's browser/MFA/deployment work. Two follow-ups: the browser harness no longer explicitly gives administrative Supabase credentials to Next.js, and approval-page invalid HTML nesting is fixed. The original browser suite passed despite React hydration errors; approval journeys now fail on browser runtime errors, and the old markup fails that new assertion.

**Delivered:** model, constraints, RLS, engagement API linkage, SQL/upgrade/API/real-Auth coverage. **Pending:** estate management APIs and UI, normalization of onboarding proposals, user-confirmed assignment of legacy engagements, scan/connector implementation and graph. W2 is still partial; this does not complete W3 or imply that a scan has executed. Migration allocation is through **0029**. W0 deployment/retention acceptance and executor-side checks remain open. MFA replacement UI still needs its required step-up flow; the existing server correctly refuses replacement without it.

See [review 10](audits/10-estate-foundation-and-browser-review-2026-09-21.md), [progress](14_Implementation_Progress.md), and [session handoff](15_Session_Handoff.md). Earlier revision sections are historical where they conflict with this checkpoint.

---

## Revision 20 — prior implementation checkpoint

No migration. Not a workstream item — a gate that was missing, and what turned up once it existed.

**A comment that invalidated six lines it never touched.** `terraform fmt` had
never been run by anything, and four files had drifted. Three are ordinary. The
fourth was not written wrong by anyone: fmt aligns *contiguous* runs of
assignments, and a comment ends the run. Revision 17's change to preprod's
`supabase_preprod_url` added a two-line comment directly above it, splitting the
`locals` block into two alignment groups. The six keys above had been padded to
that key's 20-character width — correct while they shared its group, stale the
instant they did not. The edit that invalidated them is three lines away and
modifies none of them.

**prod had never been initialised.** `fmt` only parses; it never resolves a
module or a reference, so it cannot see a module block whose arguments the
pinned version rejects. `terraform validate` can, and against `envs/prod` it
found a configuration that could not load at all: three variables declared twice
(bare in `main.tf`, documented in `variables.tf`), then seven arguments spelled
for module majors the configuration does not pin, then a `helm_release` using
the provider v3 `set` attribute under a `~> 2.11` pin, then a lifecycle rule
with neither `filter` nor `prefix`.

The obvious reading — an abandoned module upgrade — is wrong, and the
distinction matters for how it was fixed. The same `module "eks"` block mixes
v21 spellings (`name`, `kubernetes_version`, `endpoint_*`) with v20 ones
(`cluster_encryption_config`, `enable_irsa`). No single version has ever
accepted that combination. It was assembled from whichever version's
documentation was open at the time, and because nothing ever ran `init`, nothing
ever said so.

**Pins kept, names changed.** Moving eks to v21 or helm to v3 would change what
gets provisioned; renaming changes only which name expresses a setting already
written. So `~> 20.0` and `~> 5.5` both stand and nine things were corrected
against them.

**The gate discovers environments rather than naming them.** `for env in
infra/terraform/envs/*/` — the failure that produced prod was an environment
nobody checked, and a hand-written list of two reproduces it the moment a third
appears. `-backend=false` is deliberate: prod's `main.tf` carries a live
`backend "s3"` block, and a configuration gate must not reach for state.

| Workstream | Delivered since Revision 19 | Remaining acceptance |
| --- | --- | --- |
| W0.1 | `terraform fmt -check -recursive` and `terraform validate` across every environment in the W0.1 job, on a pinned Terraform; four files reformatted; `envs/prod` made loadable for the first time | prod is loadable, not reviewed as correct; its public API CIDR is unchanged and remains a founder decision |

**Confirmed on the runner, not only locally.** Staging CI [35584341666](https://github.com/vikashkaruna/Proof/actions/runs/35584341666) is
green across all fifteen jobs on the merge commit, and the validate step's log
shows both environment groups and two valid verdicts with no warnings — so the
loop iterated both rather than matching nothing, which would also have exited 0.

**What this does not do.** Nothing was applied and no cloud resource was
created — `init -backend=false` and `validate` only. `validate` proves a
configuration resolves, never that it describes infrastructure anyone wants, and
prod has not been reviewed on that second question. One item is carried forward
unchanged and is a **decision, not an oversight**:
`cluster_endpoint_public_access_cidrs` still carries `["0.0.0.0/0"]`, exactly as
the v21-named argument did, with its "restrict via WAF / OIDC in production"
comment still standing and still unactioned. What changed is that this exposure
is now reachable rather than blocked behind a configuration that could not load.
The gate is error-level: `validate` exits 0 on warnings, so the lifecycle
`filter {}` is defensive rather than enforced. Migration allocation is unchanged
at **0028**.

---

## Revision 19 — prior implementation checkpoint

No migration. The deployment gap Revision 18 named in its own closing lines.

**Reviewed, never compiled.** Revision 18 shipped `optional: true` on a Helm
`secretKeyRef` and recorded plainly that `helm` is not installed on the dev
machines and CI does not render the chart, so the change was reviewed rather
than templated. Rendering it for the first time showed the chart could not
render **at all**, and had not been able to for its whole life: a `range` over
a boolean in `ingress.yaml`, two values keys the templates dereference that
`values.yaml` never declared, and an `annotations` block emitted outside
`metadata`. An absent key is a nil pointer in Helm, not an empty string.

The consequence for Revision 18 is worth stating plainly.
`check-mfa-ring-coverage.sh` was confirming that
`AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS` was *present in the chart*, and it was —
in a chart that could not produce a manifest. A presence check over template
source cannot tell a wired variable from an unrenderable file.

**Then the defects that render perfectly.** With the chart rendering, four more
appeared that are valid YAML and valid Kubernetes, and wrong:

- Both NetworkPolicies that *grant* access selected on
  `app.kubernetes.io/part-of`, a label the pod templates never carried — it was
  emitted on object metadata only. They matched zero pods while the
  default-deny matched all of them, leaving every workload with DNS and nothing
  else.
- `allow-internal` then carried only the **egress** half. A NetworkPolicy
  decision needs the sender's egress and the receiver's ingress, so once the
  policies bound to real pods, `bff:4000`, `agent-runtime:8000` and
  `model-gateway:8001` still admitted nothing; only port 3000 from
  ingress-nginx was ever allowed in, which is the public edge, not the data
  plane.
- A `marketing` Service and the Ingress rule for `axiomproof.ai` pointed at a
  Deployment that did not exist. The public site answered 503.
- `bff` and `agentRuntime` omitted `replicas` to hand the count to an
  autoscaler the chart never shipped, so each ran one pod under a
  PodDisruptionBudget with `minAvailable: 1` — a floor equal to the count,
  which permits zero voluntary evictions and stalls a node drain indefinitely.
  `temporalWorker` had values, a Dockerfile and a published image, and no
  Deployment: durable work would be accepted and never run.

**Two gates, because they answer different questions.** `helm template` piped
through `kubeconform -strict` asks whether each manifest is well-formed and
schema-valid. `scripts/check-rendered-manifests.py` asks whether the set of
them means what the chart claims: every bundled component has a workload, every
Service selects a pod, every NetworkPolicy binds, every Service port is
admitted under the default-deny, and no disruption budget sits at or above its
own replica floor. Against the pre-change tree it reports seven findings. The
render gate could not have caught any of them.

Rendering the chart defaults alone is not coverage either — a `{{- with }}`
guarding an empty map never executes, which is how the annotations defect
stayed invisible to both the defaults and `values-prod.yaml.example`.
`infra/helm/axiom-proof/ci/` holds one values file per branch the defaults
leave cold, following the convention `ct` already uses, and the gate renders
every one.

**Not deployed.** Nothing was applied to a cluster. kubeconform validates
against the upstream schema set only — no CRDs, no admission controllers, no
cluster policy — so a manifest can pass here and still be rejected on apply.
The topology corrections are reasoned from the Compose files and the existing
Services, not observed against a running cluster, and they are the first thing
a real deploy should be checked against.

## Revision 18 — prior implementation checkpoint

No migration. The last piece of W1 that was not deployment acceptance.

**Half a key ring.** Revision 15 gave the BFF a rotatable MFA key: a primary
that seals new and rewrapped secrets, and `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS`,
a comma-separated list of keys that may still be read. It was wired into the
four Compose files and nothing else. Cloud Run and Helm carried only the
primary, so a rotation in a deployed environment had **no path for the
retiring list** — `sync-env.sh verify` would pass, the service would roll, and
every factor still sealed under the outgoing key would become unreadable.

That failure does not show up at deploy time. It shows up later and one user at
a time, as each person's next verification hits `secret_unreadable` and a 503,
which reads like an authenticator problem rather than a deployment one.

**Absent, not empty.** Both surfaces now express "no rotation in flight" as the
variable being *absent*, which is what the key ring already reads an unset
value as. That is not a stylistic choice: an empty payload is not storable as a
Secret Manager version, so a permanently-empty member of `managed_secrets`
would fail every apply that is not a rotation.

- **Cloud Run** — the secret and its version are `count`-conditional on
  `var.mfa_encryption_keys_previous`, and the BFF's env entry is a `dynamic`
  block iterating that resource, so the condition is stated once in
  `secrets.tf` rather than restated and left to drift. Clearing the variable
  destroys the secret, so the retiring key stops existing at the moment it
  stops being needed.
- **Helm** — `optional: true` on the `secretKeyRef`. With no
  `mfa-encryption-keys-previous` key in the `<release>-internal` Secret the
  variable is simply unset; without `optional` every pod would refuse to start
  until someone supplied a key they do not have.

**The check that would have caught it.** No gate asked whether a variable
reaches every surface that runs the service needing it, which is why the
omission survived. `scripts/check-mfa-ring-coverage.sh` asks it across all six
BFF surfaces and fails the build otherwise; it runs in the existing deployment
coverage job. Against the pre-change tree it names Cloud Run and Helm and
nothing else. The word-boundary match is deliberate —
`AXIOM_MFA_ENCRYPTION_KEY` is a prefix of the retiring list's name, so a
substring test would stay green with the primary key missing.

| Workstream | Delivered since Revision 17 | Remaining acceptance |
| --- | --- | --- |
| W1 | Retiring key ring wired into Cloud Run and Helm; a conditional Secret Manager secret; the cross-surface coverage gate; the deployed rotation path documented per surface in Doc 09 | Deployed acceptance — no rotation has been exercised against a running environment |

**What this does not do.** Nothing is deployed and no rotation has been run
against a live service; this makes the path exist, not proven. `terraform
validate` passes and the conditional resources are unapplied. Helm could not be
rendered locally — `helm` is not installed on this machine — so the chart change
is reviewed, not templated. Migration allocation is unchanged at **0028**.

---

## Revision 17 — prior implementation checkpoint

No migration. The positive case the persona journeys could not reach, and the defect it uncovered.

**The approval completes.** The harness now starts the BFF alongside the web app, so a step-up challenge has something to be satisfied against. `scripts/seed-personas.ts` enrols real TOTP factors — written encrypted under the same ring key the harness starts the BFF with, so the two agree by construction — and an approver signs in, selects an action, opens the step-up panel, enters a code generated from their own seeded secret, and receives a **signed approval token**. Every gate the product has, in the order a person meets them. A wrong code approves nothing and leaves the panel open; the same code cannot be spent twice; a viewer is never offered the path and a scoped approver is refused it.

The two workbench journeys that Revision 16 marked `fixme` are live for the same reason: `axiom_analyst` now clears the login-MFA gate with a real code and reaches `/workbench`. They needed one more thing the seed had not modelled — `requireInternalContext` asks two separate questions, `users.is_axiom_internal` (who employs you) and `WORKBENCH_ACCESS` (what you may do), and the capability alone lands on the client portal. The seed marks Axiom staff as staff.

**What the browser found.** The web-to-BFF bridge derives an `Idempotency-Key` from method, path and body when the caller supplies none. For `POST /v1/mfa/challenge` with `{"purpose":"login"}` that is the **same key for a given user forever**, and `claim_request` returns `conflict` whenever the stored claim's authority hash differs — a hash that includes the GoTrue session id. So the first login-MFA verification of a user's life claimed the key, and every later sign-in presented the same key from a different session and was refused `idempotency_conflict` **permanently**. Inside one session it failed more quietly: the claim replayed and handed back a challenge id that had already been consumed.

A derived key is right for approving and executing, where a double submit must not run twice. It is wrong for minting a single-use credential. Both challenge callers now supply a per-attempt key. The API suites cannot find this class of defect at all — they pass a fresh `randomUUID()` on every request and never exercise the bridge's derivation.

| Workstream | Delivered since Revision 16 | Remaining acceptance |
| --- | --- | --- |
| W1 | Approval carried to a signed token in a browser; wrong-code, replay and refusal journeys; the BFF in the harness; seeded TOTP factors; the two workbench journeys un-`fixme`d; the single-use challenge idempotency fix with a unit regression | Deployed acceptance |

**What this does not do.** A signed token is not an execution: the token is the gate, and a separate execute call runs the work against a client estate, which no connector-backed executor exists to perform. Nothing is deployed. Migration allocation is unchanged at **0028**.

---

## Revision 16 — prior implementation checkpoint

No migration. The W1 exit criterion, and the harness that could never have proved it.

**What was actually there.** `tests/e2e` was missing from `pnpm-workspace.yaml`, so `@playwright/test` was never installed, `pnpm test:e2e` resolved to no package, and the whole suite exited 0 having run nothing — the same failure mode as `--passWithNoTests`, which this repository has been bitten by before. There was no e2e job in CI. And the harness it did carry configured `AXIOM_E2E_BYPASS_AUTH` and an `axiom_e2e_bypass` cookie, both deleted from the application in W0.0; under that bypass every caller resolves to a single founder identity, so a persona journey written on it would have been a founder wearing a viewer's name and would have passed whatever the render gating did, including nothing.

**What replaces it.** `scripts/seed-personas.ts` creates nine real GoTrue accounts — one per persona, plus a second approver and a second owner — across two tenants with deliberately different MFA policies, and the journeys sign in through the real login form under `AXIOM_AUTH_MODE=strict`. Tenant A sets `mfa_required_roles = '{}'` so the authorisation journeys vary one thing at a time; tenant B keeps the default so the quarantine is exercised as its own journey. Both are supported configurations, stated rather than inherited.

Twenty-seven journeys cover the first two clauses of the exit criterion — a viewer cannot see tenant B and cannot reach an approve control — plus nav gating, the login-MFA quarantine, and a wrong password staying refused. The third clause is a statement about the server, not the page, so `viewer_cannot_approve` and `viewer_cannot_reject` were added to `verify-strict-parity.ts`, which holds a real GoTrue token; a caller who never loads the page is exactly the one worth refusing.

**What the journeys found.** A scoped approver gets no approve control but keeps **Reject plan**. `SCOPE_NARROWED` covers `PLAN_APPROVE` and `PLAN_EXECUTE` and not `PLAN_REJECT`, so narrowing someone's `approval_scopes` removes their ability to grant and leaves their ability to refuse. That is the right asymmetry — saying no is not authority over a client estate — and it is now asserted rather than assumed. My first draft of the test asserted the opposite and was wrong.

The `approver` / `approverScoped` pair differ **only** by a non-empty `approval_scopes`, which is what makes Doc 11's old note that the column is "defined and never read" falsifiable.

**The gate.** `check-env-security-gate.sh` scanned `apps packages services` and not `tests`, which is why a harness configuring the deleted bypass survived W0.0. It scans `tests` now, and reintroducing `AXIOM_E2E_BYPASS_AUTH` there fails the build.

| Workstream | Delivered since Revision 15 | Remaining acceptance |
| --- | --- | --- |
| W1 | Real-auth persona harness and 27 browser journeys; persona approve/reject refusals at the API; `tests/*` in the workspace; a CI job that runs them; the security gate extended to the harness | The positive approve **action** through a browser, which needs the full MFA flow and a running BFF; deployed acceptance |

**The specs this woke up.** Making the suite runnable for the first time also started four spec files that had been dormant since they were written, and the first CI run failed on them. `approval-console.spec.ts` wrote a fake Supabase session into `localStorage` carrying `test-access-token` — one of the BFF's `SYNTHETIC_TOKENS`, accepted only under the deleted bypass — so its setup was inert and it was really asserting what an unauthenticated visitor sees, against a plan id that has never existed. It now signs in as a seeded persona against a real plan, and gained the complement it could not previously express: the same page as a viewer, with no kill switch. The public-surface specs needed the marketing server this config had stopped starting, which is restored. `agent-ui-communication.spec.ts` is marked `fixme` rather than deleted: `/workbench` needs `WORKBENCH_ACCESS`, held only by `founder` and `axiom_analyst`, both of which `ALWAYS_MFA_REQUIRED` holds at enrolment — so it is blocked on the same TOTP-through-the-BFF gap named below.

**What this does not do.** The journeys prove what each persona is *offered*, not that an approver can complete an approval end to end in a browser — that needs the TOTP challenge satisfied against a running BFF, and is the next piece. Nothing is deployed, so none of this is deployed acceptance. Migration allocation is unchanged at **0028**.

---

## Revision 15 — prior implementation checkpoint

No migration. Two pieces of work: verifying Revision 14 rather than inheriting it, and closing the MFA key rotation gap it named as next.

**Verification of 0028.** All of it holds. Reverting the route's digest source to a live post-MFA read fails exactly the three regression tests that cover it. The claim that matters most is byte compatibility — `action_set_content_digest` now round-trips through `jsonb_to_recordset`, and 0027 compares a token's stored digest against a fresh recompute, so any disagreement would make **every approval token issued before 0028 permanently unclaimable**, surfacing as `content_changed` on content nobody touched. Rebuilding the 0026 function under another name and comparing on deep nesting, non-BMP characters, combining marks, numeric trailing zeros and exponents, a 23-digit integer, `-0.0`, and `'null'::jsonb` in every jsonb column produced identical digests on every row and every subset, while still detecting a real edit. The other three step-up call sites bind to stable identifiers and have no read-after-consume window, so the gap was confined to the approve route.

**MFA key rotation.** `AXIOM_MFA_ENCRYPTION_KEY` could not be rotated at all. The stored envelope recorded no key identity, so replacing the key did not degrade service — it locked out every enrolled user simultaneously, and each lockout was indistinguishable from a wrong code. There was no procedure, only a flag day, which is why the operator policy told readers not to rotate.

The envelope is now `v2$<keyId>$…`, where the id is a hash of the key material: stable, safe to log, and not a step towards the key. The BFF reads a ring — one primary that seals new secrets, plus retiring keys that may still be read — so both can be live at once. A factor sealed under a retiring key keeps verifying and is rewritten under the primary key the next time its owner **successfully** authenticates, never on a failed attempt, so rotation drains at the pace people log in and nothing decrypts the whole table into one process. Pre-ring `v1` envelopes are opened by trying each key, which is safe because the ciphertext is authenticated.

A secret nobody on the ring can open returns `secret_unreadable` and HTTP 503, not a rejected code. That distinction is the point: collapsing the two is what would hide a broken rotation inside ordinary failed-login noise. `sync-env.sh mint --force` now carries the outgoing key onto the retiring list instead of orphaning every factor, and `verify` reports how many retiring keys remain.

| Workstream | Delivered since Revision 14 | Remaining acceptance |
| --- | --- | --- |
| W1 | Key ring with identified envelopes; lazy rewrap on successful verification; `secret_unreadable` as a distinct 503; rotation carried through `sync-env.sh`, the env templates and all four Compose topologies; runbook and operator policy | Browser persona journeys; rotating a **deployed** environment, which nothing has done because nothing is deployed |

**What this does not do.** Rotation is proved by unit and service tests, including the lockout case it exists to prevent, and by running the mint carry-over end to end against a real env file. It has never been exercised against a deployed environment, and the Cloud Run and Helm paths pass the primary key through Secret Manager without yet carrying the retiring list — an environment rotated there today would still need the list wired into its secret flow. Migration allocation is unchanged at **0028**.

---

## Revision 14 — prior implementation checkpoint

Integrated staging `369bcf7` without discarding the other model's work. The follow-up review found a remaining gap: MFA verified the route's first action read, but the signed digest came from a **second live read after challenge consumption**. An edit between the reads became new signed authority; the two regression tests returned 201 before this correction.

Migration **0028** adds a pure database digest helper for the exact action rows already verified by MFA. The route sends those server-read rows, not a client-provided snapshot. The issuance entrypoint locks and checks the reviewed plan revision and status, then delegates to the existing atomic action/token/ledger transaction. The underlying action digest representation is unchanged, including existing signed tokens; the old issuance entrypoint is no longer callable by `service_role`. Challenge consumption remains outside issuance, preserving the deliberate safe-side tradeoff.

Delivered: action-edit and revision regression tests, digest compatibility against the 0026 implementation, positive issuance, direct-client/legacy-entrypoint restrictions, and actual writer-versus-issuer PostgreSQL races. Local acceptance: 258 BFF tests, typecheck/lint, 0000–0028 SQL and DSN suites, four concurrency suites, and all four real Auth/MFA parity labels. See [review 09](audits/09-reviewed-approval-snapshot-2026-09-21.md) and [saved session](15_Session_Handoff.md).

W0/W1/W2 remain **partial**. Next W1 work is strict browser persona journeys and MFA key rotation; real executor snapshot verification belongs with the W4/W5 connector/executor implementation. W0 deployment acceptance remains constrained by the accepted no-billable/irreversible rule. W2 estate/system/engagement modeling is still pending. Migration allocation is through **0028**; previous revision sections are historical where they conflict with this one.

---

## Revision 13 — prior implementation checkpoint

Migration 0027. Revision 12 verified the content digest when an approval was issued; nothing downstream checked it, so the token named which rows to execute and not what they contained.

`trg_actions_approved_immutable` (0004) freezes an approved action's type, parameters, rollback definition and findings. It does **not** freeze `dry_run_result`, and the simulated outcome is exactly what the approver read before agreeing — so between approval and execution the diff could be replaced without anyone breaking a constraint, and nothing noticed. `tests/database/claim-snapshot.test.sql` establishes that gap against the live schema rather than asserting it from the trigger's source, so a future widening of the trigger shows up as a failing test.

`claim_plan_execution` now recomputes `action_set_content_digest` under the action row locks and compares it with the digest on the token, read from the persisted signed payload and never from the caller — the function still takes no digest parameter. A token carrying no snapshot is refused outright: failing closed costs a re-approval, failing open executes content nobody agreed to.

The digest is signed into `ApprovalTokenSpec`, carried into the dispatch intent, and put on the wire as dispatch contract **v2** (`content_digest`, required on both sides and pinned by the shared fixture that exists because neither side's own tests could catch R-05).

| Workstream | Delivered since Revision 12 | Remaining acceptance |
| --- | --- | --- |
| W1 | Claim-time snapshot enforcement (0027); digest signed into the approval token; dispatch contract v2 carries it; a token without a snapshot cannot claim | Browser personas; MFA key rotation/deployment |
| W5 | The dispatch intent and the wire payload both carry the snapshot the batch was authorised for | A real executor that recomputes the digest before mutating; live connectors, chunk interruption, rollback, PRD B.10 |

**What this does not do.** The executor is still a refusal stub, so it records the snapshot rather than re-verifying against it. Recomputing there needs database access the stub does not have, and a check around a no-op would read as coverage while guarding nothing. The enforcement point today is the claim, which is transactional and holds the row locks — that is a stronger place for it than the executor, but it is not the same as the executor refusing.

Migration allocation is through **0027**. Everything Revision 12 records as remaining stays remaining unless listed above.

---

## Revision 12 — prior implementation checkpoint

Continues from staging `8476d8c`. The 21 September review named atomic approval issuance as the next W1 safety slice; migration 0026 delivers it and the approve route is wired onto it.

Issuing an approval was seven round trips, each committing on its own. A fault between any two left a state nobody designed — most seriously actions approved and a signed token live with **no ledger entry**, which is authority over a client's estate with no tamper-evident record of who granted it. Token, challenge link, action approval, plan status and the ledger append are now one transaction, under the same lock order as `claim_plan_execution` and `reconcile_execution_dispatch`.

`action_set_content_digest` is recomputed under those row locks and compared with the digest the route read, which closes the read-to-write race the review identified: the content that is approved is now the content that was verified. Eligibility is rechecked there too, because the route's reads can go stale before the write lands. The function lives in SQL so both ends of the comparison agree by construction rather than by two languages canonicalising JSON identically — the assumption R-05 disproved.

**Deliberate deviation from the review's sequence:** challenge consumption stays *outside* the transaction. Burning a step-up and then failing costs the approver a re-authentication, which is the safe direction; folding it in would mean a rolled-back issuance silently restores a spent challenge. Everything after consumption is atomic. If that trade is not wanted, it is a one-parameter change and a founder decision, not a defect.

| Workstream | Delivered since Revision 11 | Remaining acceptance |
| --- | --- | --- |
| W1 | Atomic approval issuance (0026): token, challenge link, action approval, plan status and ledger in one transaction; content digest and eligibility rechecked under row locks; ledger-failure and concurrent-edit tests | Browser personas; MFA key rotation/deployment. *(Snapshot enforcement delivered in Revision 13.)* |

Migration allocation is through **0026**. Everything Revision 11 records as remaining stays remaining unless listed above. No deployed parity, irreversible lock or live estate execution is claimed.

---

## Revision 11 — prior implementation checkpoint

Reviewed and incorporated staging `ea27df9` and its ten commits after `84c3b16`; no accepted work was discarded. See [the saved session handoff](15_Session_Handoff.md), [progress](14_Implementation_Progress.md), and [21 September review](audits/07-staging-integration-review-2026-09-21.md). The previous revision below is historical where it conflicts with this checkpoint.

Accepted decisions remain: higher environments self-host Supabase; no billable/irreversible deployment in this session; fresh approval for every redelivery; proxy trust configured per environment and disabled by default; TOTP/recovery only, email OTP deferred. No automatic outbox worker is authorized by these documents.

| Workstream | Delivered since Revision 10 | Remaining acceptance |
| --- | --- | --- |
| W0 | Fail-closed deploy/env generation; self-hosted Auth/PostgREST artifacts; managed service-role policies (0024); public signup disabled while mail verification is unwired; runtime DB TLS required; real MFA parity expansion | Actual reviewed preprod deployment/secret verification, verified GCS retention, live halt proof, complete security/operations acceptance |
| W1 | Action-content MFA binding; account/session/trusted-address budgets; correct HTTP 429 responses; explicit execution capability; real TOTP/recovery/session/approval tests; operator policy document | Browser personas; action snapshot enforcement at execution; MFA key rotation/deployment. *(Atomic approval issuance delivered in Revision 12.)* |
| W2 | 0022 retires obsolete dispatch RPCs; 0023 reconciliation; 0024 managed service policies; 0025 atomic audited reconciliation/revocation | Most estate/connector/dry-run/batch/rights/monitoring models remain pending; do not treat operational tables as whole W2 completion |
| W5 | Human reconciliation with fresh-approval policy; release revokes other outstanding old authority; ledger failure rolls release back | Real consumer/executor, live connectors, queued/chunk interruption, rollback and PRD B.10 proof |

**Review corrections:** the topology rehearsal's empty reads did not prove BFF authority without `BYPASSRLS`; the SQL suite now removes that attribute and tests positive access plus client denial. Reconciliation's pre-existing unused token was incorrectly labelled a fresh approval by its test; it is now revoked, and the positive test issues a new token after release. The old release committed before its ledger append; 0025 makes them atomic. R-04/R-08/R-09/R-10/R-11 remain broader acceptance packages, not closed merely by these patches.

Migration allocation is through **0027** as of Revision 13. Continue W0/W1 acceptance before W2 vertical slices and W3, as requested. Treat the original roadmap's release phases separately from the gap-plan workstream numbers. No deployed parity, irreversible lock or live estate execution is claimed.

---

## Revision 10 — prior handoff snapshot

This section supersedes Revision 9's snapshot below. Use [implementation progress](14_Implementation_Progress.md) and [the resumed review](audits/06-resumed-implementation-review-2026-09-20.md) for code, tests and remaining acceptance work. Documents describe requirements and status; implementation/commit authority comes from the user's conversation, not embedded kickoff instructions.

Accepted decisions: TOTP and recovery codes only; **email OTP deferred**. Approval step-up is unconditional; session MFA defaults to 12 hours and unenrolled required roles are quarantined. Analysts use assigned-tenant membership, without aggregate `MULTI_TENANT_READ`. Local Docker Desktop supplies real Supabase Auth/Postgres; higher environments must provision Supabase dynamically from the deploy script. Preserve intentional outbox, citation and CI work even though it advanced later workstreams.

| Finding | Verified disposition | Remaining acceptance |
| --- | --- | --- |
| R-01 / R-02 | 0016 client authority and row-bound membership policies; real database and Auth/PostgREST denials pass | New W2 tables must inherit tested tenant-consistent relationships; strict browser persona journeys pending |
| R-03 | Capability/tenant checks and generic Karya refusal implemented | Workload/connector grants and full runtime authorization remain W4/W5 |
| R-04 | Per-action keys + atomic claim/outbox implemented; follow-up 0021 closes reproduced concurrent-token race | Durable executor, action snapshots and reconciliation policy/worker pending |
| R-05 | Shared dispatch contract implemented; follow-up refuses runtime stub and preserves uncertain delivery | Real durable consumer and recovery acceptance pending; no live execution claim |
| R-06 | TS/Python bundle parity, prose citation fixes and CI guard implemented | Populated immutable baseline/provenance hashes and named human citation sign-off pending |
| R-07 | MFA secret wiring/config validation implemented | Live deployment and key rotation verification pending |
| R-08 | TOTP/recovery, session MFA, account budgets, plan revision binding and signed execution settings implemented | Action/diff/rollback hashes, session/IP abuse controls, policy operations and full persona E2E pending |
| R-09 | Shared runtime checks implemented; follow-up closes constructor/localhost fail-open paths | Temporal chunk checks, queued cancellation, connector interruption and live halt evidence pending |
| R-10 | TS and Python sealing now require bucket lock and uploaded-version COMPLIANCE retention readback; failed uploads cannot produce mock proof | GCS verified adapter and deployed WORM proof remain pending; GCS sealing fails closed |
| R-11 | Real migration/RLS/Auth parity, lint and control drift lanes green | Browser journeys, eight PRD B.10 scenarios, release/restore/performance gates pending |

**R01–R11 are not blanket closed.** Green CI verifies its configured assertions; review reproduced a double claim outside the old assertions and found false stub acceptance, ambiguous-delivery retry and a kill-reader fallback. Regression tests accompany the follow-up fixes.

| Workstream | Completed/source delivered | In progress or pending |
| --- | --- | --- |
| W0 | Strict auth separation, direct-client lockdown, atomic entitled onboarding, durable idempotency, secret wiring, local real Supabase matrix and fail-closed migration runner | Dynamic higher deployment, real full MFA/browser journeys, deployed secrets/retention and live halt acceptance |
| W1 | Analyst persona, scoped context, TOTP/recovery and login/approval MFA; account budgets | Content-bound approval, remaining abuse controls, operator policy/rotation and persona acceptance |
| W2 | 0011 regulatory schema, 0012–14 MFA, 0015 analyst, 0016 authority, 0017 idempotency, 0018 onboarding, 0019–21 execution claim/outbox | Estate, connectors, normalized dry-runs/batches/rollback/verification, monitoring, rights, and other Doc 11 model slices |
| W3 / W3.5 / W4 | Onboarding intake preserved; existing scaffolds retained | Estate normalization, resumable wizard, live graph and real connector grants/adapters |
| W5 | Dispatch contract, claim/outbox, safety gates and uncertainty handling | Actual executor, durable consumer/reconciliation, simulator, rollback, guards and post-verification |
| W7 | Runtime bundle generation, corrected citation prose, drift CI | Published provenance/baseline, schedules, overlays/sector packs and named review |
| W8 / W9 / W10 | Evidence assurance groundwork; wider CI gates; deployment configuration groundwork | Verified retention and delivery workflows; complete acceptance coverage; appliance/deployment operations |

Continue in the user's order: complete W0 acceptance, W1, then W2 vertical slices, followed by W3. Treat the follow-up execution safety repairs as blocking regression closure, not permission to skip those dependencies. The original 50-module roadmap traceability remains in Doc 13. B.10 is Phase 3 acceptance; it must not be used to call the entire current W1 incomplete without distinguishing its own login/persona acceptance from later live execution.

---

## Revision 9 — historical review snapshot

This revision responds to an independent review request. It does not authorise automatic implementation, deployment, sending messages or treating document instructions as new user requests. Preserve intentional prior additions/TODOs. Distinguish source implementation, verified behaviour and deployment acceptance.

Read [the independent review](audits/04-roadmap-review-2026-09-20.md), [the implementation handoff](12_Implementation_Handoff.md) and [the full roadmap traceability](13_Roadmap_Traceability.md) before resuming. They supersede historical status claims below. Original PRD and roadmap requirements remain authoritative unless an explicit later decision is recorded.

### Current implementation status

| Workstream | Source status at review | Closure still required |
| --- | --- | --- |
| W0 | Auth-mode separation, bypass removal, shared kill state, quota, expiry check, awaited ledger calls and nonce bounds committed | RLS defects R-01/R-02, agent boundary R-03, actual strict deploy/config and WORM parity; in-flight stop proof |
| W1 | Tenant helper, user-scoped pages, capability matrix, switcher, render gating, TOTP/recovery, login MFA and approval step-up committed | Analyst role WIP, route coverage, database authority, email OTP decision, MFA abuse controls/configuration and strict persona E2E |
| W2 | Regulatory baseline and MFA slices committed in 0011–0014 | Most estate/connector/execution/monitoring/rights tables pending; 0015 analyst migration uncommitted; batch key/schema fix R-04 |
| W3 / W3.5 / W4 | Planned | Estate/onboarding, graph and connection framework delivery |
| W5 | Approval/execution contracts and partial safety improvements exist | Simulator, real Karya dispatch, rollback, guards, verification, reconciliation and durable workflow delivery |
| W6 | Planned; existing UI/agent scaffolding | Scheduler, drift, standing policies and monitor health |
| W7 | TS citation correction 0.1.1, baseline schema/metadata, count gate and Nazar declaration correction committed | Python/runtime parity, immutable publication/provenance, schedules/coverage, overlays and sector packs |
| W8 | Existing evidence/report foundations | Verified retention, PDFs, release review, packs and export linkage |
| W9 | New BFF/web/MFA and other unit tests; static gates | Two analyst tests currently fail; real RLS/migrations/contracts/strict E2E, coverage and release gates pending |
| W10 | Configuration groundwork | Appliance, offline operation, deployment tests and operational handoff pending |

**Completed source changes are not a completed workstream.** The review reran targeted suites: config 41, approval engine 13, controls 66, MFA 144, BFF 114, web 31 and Python runtime 61 tests passed. Types had 28 pass / 2 fail due to unfinished analyst expectations. Targeted typechecks and static gates passed. SQL policies, cloud state, fresh migrations and strict E2E were not executed successfully in this review. See the review for limits and commands.

### Current priority findings

| ID | Priority | Finding and required closure | Workstream |
| --- | --- | --- | --- |
| R-01 | P0 | Self-writable `is_axiom_internal` enables privilege escalation; protect security columns and prove direct-client denial | W0/W1 |
| R-02 | P0 | RLS role checks use selected JWT tenant, not target row; constrain writes and analyst reach per row | W1/W2 |
| R-03 | P0 | Generic agent invocation lacks capability enforcement and permits body tenant override; protect all invocation paths | W1/W4 |
| R-04 | P1 | Unique per-action idempotency column receives a shared batch key; token consumed before failing update | W2/W5 |
| R-05 | P1 | BFF camelCase execute payload mismatches FastAPI snake_case; failed dispatch is not handled durably | W5 |
| R-06 | P1 | Python bundle still 0.1.0; regulatory schema/metadata not a published hashed baseline | W7 |
| R-07 | P1 | Mandatory MFA key missing from deployment definitions/examples | W0/W1 |
| R-08 | P1 | Incomplete MFA delivery and abuse budgets; approval content/conditions not fully bound and enforced | W1/W5 |
| R-09 | P1 | Shared kill state does not yet stop in-flight workers | W5 |
| R-10 | P1 | Unlocked preprod retention and skipped GCS validation cannot prove WORM parity | W0/W8 |
| R-11 | P1 | Real RLS, migrations, strict persona E2E and release-path gates remain absent | W9 |

R-01–R-03 block multi-client security acceptance. These are evidence-backed review findings, not a claim that deployed infrastructure was exploited. See linked review for exact code and acceptance tests. Do not mark SEC-3/SEC-9 closed merely because page imports and role helper tests pass.

### Recommended next delivery sequence

1. Preserve Claude's worktree; finish the analyst enum/matrix/migration/tests as one coherent change. Enforce assigned-tenant access pending clarification; do not rely on blanket `is_axiom_internal` access.
2. Close R-01–R-03 and add real-Postgres security tests. Wire R-07; exercise login, enrolment, approval step-up and tenant switching under strict auth.
3. In parallel with that security closure, complete W7 runtime generation/publication parity (R-06). Never overwrite old library rows or silently repin engagements.
4. Continue W2 by vertical slice, with fresh-install and upgrade checks. Resolve R-04 before building execution on the schema. Then W3 → W3.5 and W4.1–W4.4.
5. W5 implementation can start after **W4.4** contracts/grants are stable; live acceptance additionally requires W4.6's real binding, rollback and all PRD B.10 criteria. Close R-05/R-08/R-09 inside W5.
6. Deliver W8.1–W8.3 and W6.1 monitoring for the Phase 3 release; only advance W6.2 standing policies to L3 after demonstrated L2 safety. Later W6.3–W6.6 and W7 overlays remain phase/cash gated. W9 runs throughout; W10 remains the intentional pulled-forward scope.

### Added closure packages — requirements previously named without delivery ownership

These make existing roadmap obligations actionable; they are recommendations for the implementing model, not claims of completed work or new product scope.

| Package | Required implementation | Acceptance evidence |
| --- | --- | --- |
| W3.1 — Phase 1/2 delivery persistence | Interview/import discovery; classification review/corrections; persisted RoPA, policy/notice drafts and delivery playbook time records; prompt/version review | Resume across sessions; corrections retain provenance; measured delivery-time baseline and ranked automation backlog; FR-2.3/2.4 and M1.8 |
| W8.1 — Rights and consent | DSAR verified identity, fulfilment, deadlines and responses; purpose/notice-version consent capture, withdrawal and downstream completion; EN/HI; retention/legal-hold policy | Full DSAR and consent-withdrawal journeys; server-owned clocks; consent history and actor evidence; FR-12.1–12.3, FR-4.5; honour existing seven-year product requirement while separately recording statutory applicability |
| W8.2 — Breach operations | Incident state machine, triage, notification drafts, review/send authority, deadline jobs and warm forensic evidence | Timed controlled drill with DPB/affected-principal outputs, delivery/retry evidence and escalation; FR-13.1–13.4; no unapproved live notifications |
| W8.3 — Review and release | General output review queue, reasons/diffs, explicit founder release in Phases 0–2; sealed approval artifacts; report/claim/evidence linkage | Unreviewed client output cannot be released; rejection reason and approver preserved; BR-4, UJ-1, FR-7.5/7.6. Resolve free gap-scan auto-release versus BR-4 explicitly |
| W6.1 — Monitoring | Scheduled discovery/assessment, drift and scheduler/connector health | Restart-safe schedules, alert delivery, last-success and missed-run detection; M3.10 |
| W6.2 — Standing policies | Human-authored/versioned/expiring scope with revocation and escalation; still requires dry-run/rollback/token checks | Boundary and revocation tests, named policy approver and policy version per execution; M4.1; no bypass of BR-1/BR-2 |
| W6.3 — Self-service SMB | Onboarding, tier/entitlement, guided assessment/remediation and support/billing boundaries | A new client completes the supported journey without founder intervention; M4.4 |
| W6.4 — TPRM and DPIA | Vendor inventory, DPAs, questionnaires, sub-processors; guided DPIA with risk rationale and review | Persistent tenant-scoped vendor and DPIA lifecycle with export/review; M4.5/M4.6; control text alone does not qualify |
| W6.5 — Partner service | Explicit assigned-client access, delegated role boundaries, brand configuration and exports | Multi-client partner acceptance with cross-client denial tests; M4.7 |
| W6.6 — Market signals | Real permitted public-source ingestion, scoring, provenance and internal-only delivery | Non-empty sourced signals and repeatable scoring; M4.9; current Sanket is a stub |
| W10.1 — Enterprise roadmap register | Track SSO/SAML login separately from connector grants; split-plane, custom SLA/support, certification, sector #2, Consent Manager registration and L4 | Named demand/funding/certification/proven-L3 gate per module; do not implement gated items merely because they appear in the plan |
| W9.1 — Operational acceptance | India residency of data/backups/logs/models, tenant keys/rotation, encryption, restore drills, uptime, latency/throughput, per-client cost and explanation lineage | Measured NFR-1–12 results; RPO ≤1h/RTO ≤4h restore exercise; standard report <5min; cost <15% ACV; Phase 3/5 availability targets |

W2 must add storage for these packages as each slice is designed (including vendor/DPA/questionnaire, DPIA, notifications, output reviews, entitlements and partner branding). A table by itself never completes the associated journey.

### Clarifications and architecture reconciliations

- Self-managed TOTP is intentional. Revision 10 records the accepted email OTP deferral; SMS remains deferred.
- Recommended analyst boundary is explicitly assigned tenants. `founder`, tenant `owner`/`admin`, `axiom_analyst`, partner and machine identity are distinct; a matrix entry must agree with SQL, seeds, API and UI.
- Retain REST/OpenAPI primary; outbound MCP optional; inbound MCP dropped. One connector identity must still be scoped to tenant + estate + target and separated read/write grants. Native database/object-store bindings need real protocol adapters and permission checks; an OAuth descriptor alone does not implement SQL or prove three live connector families.
- Phase 2 still requires three live connector types before its exit is claimed; one live binding is an intentional intermediate milestone.
- Provider-specific AWS `ap-south-1`/S3 and GCP `asia-south1`/GCS wording needs one recorded equivalence/ownership decision. Preserve Mumbai residency and immutable evidence requirements. Preprod's unlocked retention is an explicit verification gap, not production equivalence.
- The architecture skill puts business logic and writes in APIs; marketing still owns scoring/storage/email workflows. Track their movement to the BFF or an explicitly approved boundary decision in W0/W8. Do not confuse deliberate user-scoped SSR reads with client-side direct writes.
- Sectoral pack #1 remains undecided. Mock data is implemented as an explicit tenant demo flag; keep provenance visible and ensure sample data never becomes live evidence.

---

## Revision history and original baseline assessment

**Historical record:** Parts A/B and the old kickoff below describe `9575205`. Their present-tense assertions, line numbers, counts, test totals and staging status do not describe `2c54fcd`. Revision 9's current tables and linked handoff take precedence for implementation status. Historical references to "DB policies are correct", a complete execution gate and functional Sanket are specifically superseded by this review.

> **Revision 8 (final) changes:** **Inbound MCP dropped** from scope entirely. **Outbound MCP kept flexible** — an optional transport behind the existing interface, enabled per-descriptor, never the primary path. **Per-agent OAuth client registration dropped**: one connector identity per tenant, with `connector.write` requestable only by Karya's SVID plus a valid approval token. Rationale — only one of ten agents writes to external systems, that is a static architectural fact, and ten registrations per connector is authentication surface the ICP should not have to onboard. Per-agent registration remains documented as optional hardening. REST/OpenAPI is the primary transport.
>
> **Revision 7 changes:** **MCP posture settled.** Revision 3 conflated two opposite directions; separated now. **Outbound** MCP (Axiom → client MCP servers) is **deferred** — it was justified on general MCP adoption, but the ICP does not run MCP servers today, so it was building for a customer we do not have. **Inbound** MCP (external → Axiom) is **read-only permanently** and scheduled only after W0 + W1, because write-via-MCP contradicts the approval-console design rather than merely risking it. MCP otherwise stays inside the Axiom Proof perimeter. Also corrects a Revision 3 over-claim: **SPIFFE does not reach across to a client's IdP** without federation; the honest split is SPIFFE intra-perimeter, OAuth grants inter-perimeter, with the JWT-SVID as the `private_key_jwt` bridge. **REST/OpenAPI becomes the primary transport.** No delivered feature is lost; item 15 moves to W4.7 descriptors.
>
> **Revision 6 changes:** **Full ten-agent identity and estate-access matrix** added to W4.3, reconciled across all three declaration sites. Result: **only 2 of 10 agents touch a client estate** (Drishti reads, Karya writes); five handle estate-derived personal data with no connector access; three never see client data. Five declaration discrepancies found and scheduled. Two new findings: **SEC-14** (tool scopes are declarative only — read in exactly one place, enforced nowhere) and **SEC-15** (Nazar holds `control_library.write`, contradicting the architecture and dangerous under W7.0). Scopes gain tenant/estate structure.
>
> **Revision 5 changes:** **W7.0 added — regulatory baseline and library versioning.** The control library gets a recorded relationship to the law it implements: content-hashed `regulatory_instruments` with an amendment chain, a frozen named baseline (**`IN-DPDP@2026-09-20`** = Act 22 of 2023 + G.S.R. 846(E) + corrigendum **G.S.R. 892(E)**, 11 Dec 2025), per-control provenance with `verified_on`/`verified_by`, a typed change log, and semver whose bumps are defined by **assessment comparability**. Consequence: the CTL-1 citation fix is a **PATCH**, so existing client assessments stay valid. Nazar (M2.9) closes the loop from gazette signal to reviewed baseline delta.
>
> **Revision 4 changes:** **preprod becomes an exact replica of production** — same codebase, same ruleset, differing only in topology. New finding **SEC-13**: preprod currently bypasses auth, tenancy and idempotency in nine places and **runs on an in-memory mock database**, so nothing verified there says anything about production. **SEC-2 upgraded** to a full unauthenticated founder-owner takeover chain after tracing the `axiom_e2e_bypass` cookie end to end. W0 re-scoped M → L and restructured around one governing principle: environment identity must never determine security posture.
>
> **Revision 3 changes:** **W4 re-architected** from "build adapters" to a **Universal Connection Framework** — SPIFFE workload identity, a four-grant credential broker (OAuth 2.0/2.1 Client Credentials, RFC 8693 Token Exchange, RFC 7522 SAML Assertion, RFC 7523 JWT Assertion), pluggable transports with **MCP as the primary path**, and declarative per-system capability descriptors. Adding a target system becomes a config file, not an integration. Seven chunks; W5 now unblocks at W4.4.
>
> **Revision 2 changes:** all seven decisions in Part E resolved and folded into the workstreams. Added **W3.5** (Entity Relationship Graph page) and **W10** (on-prem deploy environment). **W7 re-scoped upward** following new finding **CTL-1** — verification against the notified Gazette showed the control library cites the *draft* Rules numbering, so nearly every statutory citation in client-facing reports is wrong.

---

## Historical kickoff — Revision 8, before implementation

**Baseline:** `9575205` · main == staging == origin/main == origin/staging · working tree clean
**Test baseline (verified):** TypeScript 11/11 task passes · Python 38/38 pass · `services/bff` and `apps/web` have **zero tests** behind `--passWithNoTests`
**Environment:** work in the Axiom Proof repo. Staging and preprod **cannot validate auth, tenancy or RBAC today** — see SEC-1 and SEC-13. W0 fixes that first.

### Order of work

| Order | Workstream | Why first |
| ----- | ---------- | --------- |
| **1 — parallel** | **W0** Security & environment parity | Blocks everything. Until it lands, nothing is verifiable in any non-local environment |
| **1 — parallel** | **W7.0 + W7.1** Regulatory baseline, then citation re-map | Independent of W0. The product cites the wrong law in client reports today; the fix is a PATCH so no assessment is invalidated |
| 2 | **W2** Data model | Unblocks W1, W3, W4 |
| 3 | **W1** Tenancy, RBAC, MFA, personas | Makes staging a real test bed |
| 4 | **W3 → W3.5** Estate, then ER graph | |
| 5 | **W4.1 → W4.7** Universal Connection Framework | W5 unblocks at W4.4 |
| 6 | **W5** Phase 3 execution loop | The core product |
| 7 | W6 · W8 · W10 | |
| — | **W9** Tests & audits | Continuous. Gates every merge from day one |

### First three things to do

1. **W0.0** — build `resolveAuthMode()` in `@axiom/config` (`AXIOM_AUTH_MODE`, default `strict`, `e2e-bypass` refused at boot outside `local`/`test`), then delete all nine preprod/staging security branches listed in SEC-13 plus the `isDevOrTest` chains in SEC-1 and the cookie clauses in SEC-2. Acceptance: `grep -rn "ENVIRONMENT === 'preprod'\|ENVIRONMENT === 'staging'" apps packages services` returns zero security-relevant hits.
2. **W9 seed** — stand up the `services/bff` test suite *before* touching its middleware, so W0's changes are verified as they land rather than after.
3. **W7.1** — declare baseline `IN-DPDP@2026-09-20` and re-map all 24 `DPDPR-2025` citations against G.S.R. 846(E) + corrigendum G.S.R. 892(E). Publish as `0.1.1`.

### Two open decisions (neither blocks the above)

- **Sectoral pack #1** — Healthcare (ABDM/NHA retention vs DPDPA erasure) or BFSI (RBI / Account Aggregator)? Needed only when W7 reaches pack work.
- **Mock-data line** — proposed: permitted only behind a `demo` tenant flag, never hardcoded in a page component, carrying the same provenance labelling as non-production connector bindings. Proceeding on this basis unless changed.

### Findings index

**P0:** SEC-1 (staging/preprod auth bypass) · SEC-2 (cookie takeover chain) · SEC-3 (cross-tenant leak, 17 pages) · SEC-13 (preprod runs on a mock DB) · CTL-1 (draft Rules citations)
**P1:** SEC-4 (kill switch process-local) · SEC-5 (unbounded tenant creation) · SEC-6 (stale dry-run) · SEC-7 (blast radius unenforced at execution) · SEC-8 (no MFA) · SEC-9 (RBAC) · SEC-14 (tool scopes unenforced) · SEC-15 (Nazar can write the control library)
**P2:** SEC-10 · SEC-11 · SEC-12 · QUA-1 (no BFF tests) · QUA-2 (ten shell modules) · QUA-3 (control count) · PERF-1 · PERF-2 · PERF-3

---

## 0. How to read this document

Part A is what is **broken or unsafe today** and must be fixed before anything else.
Part B is what is **missing** against the PRD and the phase plan.
Part C is the **sequenced plan** to close both.
Part D is the **test and verification strategy**.
Part E records the **decisions taken** (E.1, resolved) and the two still open (E.2, non-blocking).

Every claim in Parts A and B is anchored to a file and line in the repo at `9575205`. Where I say something is absent, I ran the search and report the count.

---

## 1. Historical staging status at the original baseline

| Ref              | SHA       |
| ---------------- | --------- |
| `main`           | `9575205` |
| `staging`        | `9575205` |
| `origin/main`    | `9575205` |
| `origin/staging` | `9575205` |

`git rev-list --count staging..main` = 0, and `main..staging` = 0. Staging is already identical to main. Working tree clean. Nothing to sync.

**However** — see **SEC-1** and **SEC-13**. In staging *and* preprod as currently configured, authentication, tenancy, role resolution and idempotency are all bypassed, and preprod additionally runs on an in-memory mock database rather than a real one. Neither environment can validate multi-tenancy, RBAC or MFA today. That reorders the plan: **W0 must land before any other workstream can be verified anywhere.**

---

## 2. Verdict

The **spine is real and well built**. The parts that carry the trust proposition — the hash-chained ledger, the HMAC approval-token engine, the per-action execution gate, the DB-level RLS design, the agent separation-of-duties contract — are genuinely good and match the architecture document. `services/bff/src/routes/v1.ts:319-470` is a careful, correct execution gate: signature → plan binding → DB-persisted token lookup → status → scope cross-check → per-action approval/dry-run/rollback preconditions → atomic single-use consumption via conditional update. That is the hard part and it is done properly.

The **body is not attached to the spine**. Three structural problems:

1. **The web application bypasses the tenancy model entirely.** 17 of 22 authenticated pages query with the Supabase service-role key and no tenant filter. RLS is correct in the database and irrelevant in practice.
2. **Phase 3 — "the core product" — is a stub.** Karya returns `status="skipped"`. There is no connector framework, no dry-run simulator, no rollback engine, no verification agent, no execution-time blast-radius enforcement.
3. **Phase 4 is absent, not partial.** Standing approval policies, multi-regulator reuse, TPRM, DPIA automation, sectoral packs, partner portal: zero implementation references each.
4. **The non-production environments do not run the production code path.** Preprod diverges in nine places and is backed by an in-memory mock (SEC-13); staging bypasses auth wholesale (SEC-1). The environments meant to de-risk a release are currently incapable of doing so.

And one defect that is not architectural but is arguably the most commercially dangerous: **CTL-1** — the control library cites the *draft* DPDP Rules numbering, not the Rules as notified on 13 Nov 2025. Reports the product generates today cite the wrong rule for breach notification, cross-border transfer, notice, retention and data-principal rights.

Prior grade in `Axiom-Proof_Readiness_Matrix.md` was **B+ / "Advanced Pilot"**. That assessment is infrastructure-focused and did not surface the tenancy defect, the auth bypasses, or CTL-1. On a security basis I would not put the current build in front of two clients at once; on a CTL-1 basis I would not send a generated report to a regulator.

---

# PART A — Findings to fix first

Severity: **P0** = exploitable or data-exposing now · **P1** = violates a stated absolute requirement · **P2** = correctness/quality.

## SEC-1 · P0 · Authentication is bypassable in staging, preprod, and any container without `NODE_ENV`

`services/bff/src/middleware/auth.ts:18-28`

```ts
const isDevOrTest =
  env.ENVIRONMENT === 'development' ||
  env.ENVIRONMENT === 'local' ||
  env.ENVIRONMENT === 'preprod' ||
  env.ENVIRONMENT === 'staging' ||
  process.env.NODE_ENV !== 'production' ||        // ← unset NODE_ENV ⇒ true
  process.env.AXIOM_E2E_BYPASS_AUTH === 'true';

let token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
if (!token && isDevOrTest) token = 'dev-token';   // ← no credential ⇒ synthesised one
```

When `isDevOrTest` is true, a request with **no `Authorization` header at all** is assigned `dev-token`, which resolves (`auth.ts:36-46`) to the founder identity `00000000-…-0001`. `tenantResolver` (`services/bff/src/middleware/tenant.ts:47-51`) then accepts **any** `X-Tenant-Id` the caller supplies and assigns `role: 'owner'` with no membership check.

Net effect in staging: an unauthenticated caller is founder-owner of any tenant they name.

Compounding: `auth.ts:60-75` and `auth.ts:83-96` **fail open** — if Supabase returns an error or is unreachable, the request is granted the founder identity rather than rejected.

`.env.staging.example` sets `ENVIRONMENT=staging` **and** `NODE_ENV=staging`, so both clauses fire. Production sets both correctly, but the `NODE_ENV !== 'production'` clause means any deploy that forgets to set `NODE_ENV` silently opens the door.

## SEC-2 · P0 · Cookie-controlled authentication bypass in the web app

`apps/web/src/middleware.ts:37-56`

```ts
const isPreprodOrMock =
  process.env.ENVIRONMENT === 'preprod' ||
  supabaseUrl.includes('preprod-supabase') ||
  supabaseUrl.includes('placeholder') ||
  request.cookies.get('axiom_e2e_bypass')?.value === 'true' ||   // ← no env guard
  (process.env.NODE_ENV === 'test' && …);

if (isPreprodOrMock) {
  …
  return NextResponse.next();   // ← auth skipped
}
```

The `axiom_e2e_bypass` cookie clause has **no environment guard**, unlike the `AXIOM_E2E_BYPASS_AUTH` clause beside it. Any visitor who sets `axiom_e2e_bypass=true` in their browser skips the session check on every non-public route — in production.

**It is worse than a page-auth skip. It is a complete takeover chain**, and every link is in the production code path:

| # | Where | What happens |
| - | ----- | ------------ |
| 1 | attacker's browser | sets `axiom_e2e_bypass=true` — no credentials needed |
| 2 | `apps/web/src/middleware.ts:41` | cookie clause, **no env guard** ⇒ page session check skipped |
| 3 | `apps/web/src/app/api/bff/[...path]/route.ts:35` | same cookie, **no env guard** ⇒ injects `accessToken = 'test-access-token'` |
| 4 | `services/bff/src/middleware/auth.ts:36-46` | `test-access-token` ⇒ founder identity `00000000-…-0001` |
| 5 | `services/bff/src/middleware/tenant.ts:47-51` | any `X-Tenant-Id` accepted, `role: 'owner'` assigned |

Result: **unauthenticated founder-owner access to any tenant, from a cookie alone.**

And the cookie is not obscure — the app sets it itself. `apps/web/src/app/(auth)/login/actions.ts:55-63` writes `axiom_e2e_bypass=true` (plus a `test-access-token` session cookie) as a "sovereign session" fallback whenever login hits a network or 5xx failure and `NODE_ENV !== 'production'`. A transient Supabase outage hands a real user the bypass cookie; the cookie then works everywhere, forever, including against production.

Also here: a live anon JWT is hardcoded as a fallback at `apps/web/src/middleware.ts:33`.

## SEC-3 · P0 · Cross-tenant data exposure — service-role client used on 17 pages with no tenant filter

`packages/supabase/src/admin.ts:7-13` states the invariant plainly:

> "The Next.js apps NEVER use this — they go through the user-scoped client and rely on RLS to enforce tenancy."

22 files in `apps/web/src` call `createSupabaseAdmin()`. The service-role key bypasses RLS by design. Of those, these query tenant-scoped tables with **zero** occurrences of `tenant_id`/`tenantId` anywhere in the file:

`approval/page.tsx` · `assessment/page.tsx` · `breaches/page.tsx` · `classification/page.tsx` · `connectors/page.tsx` · `controls/page.tsx` · `dashboard/page.tsx` · `datamap/page.tsx` · `discovery/page.tsx` · `dsars/page.tsx` · `evidence/page.tsx` · `execution/page.tsx` · `monitoring/page.tsx` · `partner/page.tsx` · `policies/page.tsx` · `reports/page.tsx` · `workbench/page.tsx`

Any authenticated user of any tenant sees every tenant's findings, evidence, DSARs, breaches, reports, plans, approvals and ledger entries. This makes **NFR-2 "Tenant isolation — Absolute"** false in the running product despite the database policies being correct.

Only `ledger/page.tsx`, `portal/page.tsx`, `plans/page.tsx` and `api/ledger/route.ts` filter by tenant.

## SEC-13 · P0 · Preprod is not a pre-production environment — it is a mock

*Raised from your instruction that preprod must authenticate exactly as production does.*

Preprod does not run the production code path. It runs a different one, in **nine** places, and the most consequential is that **it does not use a real database**.

| # | Location | What preprod does instead of production behaviour |
| - | -------- | -------------------------------------------------- |
| 1 | `services/bff/src/middleware/auth.ts:20` | Authentication bypassed; missing token ⇒ founder identity |
| 2 | `services/bff/src/middleware/tenant.ts:20` | Tenant membership check skipped; `role` forced to `owner` |
| 3 | `services/bff/src/middleware/idempotency.ts:29-36` | `Idempotency-Key` auto-generated when absent — FR-8.3 never exercised |
| 4 | `apps/web/src/middleware.ts:38` | Page session check skipped entirely |
| 5 | `apps/web/src/app/api/bff/[...path]/route.ts:31` | Injects `test-access-token` with no session |
| 6 | `apps/web/src/app/(auth)/login/actions.ts:48-63` | "Sovereign session" issued without credentials; sets the SEC-2 bypass cookie |
| 7 | **`packages/supabase/src/admin.ts:20-27`** | **Returns the in-memory E2E mock client instead of connecting to Supabase** |
| 8 | **`packages/supabase/src/server.ts:21-28`** | **Same substitution on the user-scoped client** |
| 9 | `packages/config/src/index.ts:117-122` | All production credential validation skipped |

Rows 7 and 8 are the ones that matter most. `createE2ESupabaseClient()` (`packages/supabase/src/e2e.ts`) serves **hardcoded fixtures** — `E2E_USER`, `E2E_PLAN` and an in-memory table store. In preprod, every page, every query and every agent read is answered from constants compiled into the bundle.

The consequence is blunt: **nothing verified in preprod today tells you anything about production.** Not auth, not tenancy, not RLS, not idempotency, not query correctness, not performance, not migrations. A green preprod run is evidence about a fixture file.

Note also that `isE2EBypassEnabled()` (`e2e.ts:245-251`) is itself correctly scoped — `NODE_ENV === 'test'`, or local plus an explicit flag. It is defeated by `admin.ts:20-27` ORing it together with `ENVIRONMENT === 'preprod'` and two `SUPABASE_URL` substring checks. The guard was written correctly and then bypassed around.

**There is already a correct precedent in this repo.** `services/model-gateway/src/model_gateway/config.py:93-99` treats preprod at production strictness — it *enforces* Mumbai region and refuses to let PII redaction be disabled in `("production", "preprod")`. The Python services got this right. The TypeScript layer did not. Making preprod a true replica means bringing the TS layer up to the standard the model gateway already sets.

---

## SEC-14 · P1 · Agent tool scopes are declarative only — nothing enforces them

*Raised from your question about the full agent roster.*

`04_Solution_Architecture.md §5.2` describes the agent permission model and calls separation of duties "a genuine security property, not a talking point". Today it is a talking point.

`tool_scopes` is declared on all ten agents in `packages/types/src/agents.ts` and again in `services/agent-runtime/src/axiom/agents/*.py`. Repo-wide, it is **read in exactly one place**:

```
services/agent-runtime/src/axiom/app.py:146    "tool_scopes": list(a.tool_scopes),
```

That serialises it into an API response for display. There is no scope-checking middleware, no enforcement at tool invocation, no gate between a declared scope and an actual capability. The permission model is a set of strings rendered as JSON.

The one property that *is* genuinely enforced is Karya's approval-token gate (`services/bff/src/routes/v1.ts:319-470`) — and it is enforced by the BFF and the token, not by `tool_scopes`. So the headline claim ("Sudhaar can never execute") holds today only because Sudhaar has no code path that calls an executor, not because a permission system prevents it.

## SEC-15 · P1 · Nazar holds `control_library.write` — an L1 agent can rewrite the definition of compliance

`packages/types/src/agents.ts` and `services/agent-runtime/src/axiom/agents/nazar.py` both declare:

```
nazar → ('http.read.government_sources', 'control_library.write')
```

`04_Solution_Architecture.md §5.2` says Nazar's permission is **"External sources read"**. The implementation grants it write access to the control library; the architecture does not.

This matters far more after W7.0. The control library is the definition of what compliance *means* — the baseline every assessment, finding, penalty estimate and client report is computed against. Granting an **L1 agent that ingests untrusted external web content** write access to that baseline is the wrong shape: a poisoned or misread gazette page becomes a silent change to every client's posture, with no human in the loop and no `regulatory_signals` review step.

Per W7.0, Nazar's correct scope is `regulatory_signal.write` — it **proposes** a baseline delta, a human accepts it, and only then is a new library version cut. That is the same maker-checker pattern as Sudhaar/Karya, applied to the rulebook. Fixed in W4.3 and W7.0 together.

---

## SEC-4 · P1 · Global kill switch is process-local — FR-8.6 not met

`services/bff/src/services/kill-switch.ts:32-67`. In-memory object, acknowledged in its own docstring as single-replica-only. The deployment target is Cloud Run / EKS with multiple replicas. Engaging the kill switch on one instance leaves every other instance executing. FR-8.6 requires "immediately effective".

Second defect: `release()` (`:57-64`) ignores scope. A **tenant owner** can release a founder-engaged **global** kill switch — `v1.ts:629` permits `role === 'owner'`.

## SEC-5 · P1 · Any authenticated user can create unlimited tenants and self-assign `owner`

`services/bff/src/routes/v1.ts:780-790`. `/organizations/onboard` is exempted from tenant resolution (`tenant.ts:28-32`, which hands it `role: 'owner'`), then uses `createSupabaseAdmin()` to insert a tenant and a `tenant_users` row with `role: 'owner'` for the caller. No entitlement check, no quota, no rate limit. Combined with SEC-1 this is reachable unauthenticated in staging.

Minor, same route: `Math.random()` used for slug uniqueness (`v1.ts:827`).

## SEC-6 · P1 · Stale dry-runs can back an execution — FR-6.3 half-enforced

`dry_run_expires_at` is checked at **approve** time (`v1.ts:141`) but not at **execute** time (`v1.ts:440-446` checks only `dry_run_status` and `rollback_validated`). Time passes between approval and execution. FR-6.3 says a stale dry-run cannot back an approval; the execute path should re-assert it.

## SEC-7 · P1 · Blast-radius caps are not enforced at execution — FR-8.5 not met

The only enforcement is inside the **planner**, `services/agent-runtime/src/axiom/agents/sudhaar.py:209-217`, as a plan-generation escalation. Nothing in the BFF execute path or in Karya re-checks the cap against actual affected records at execution time, and there is no halt-and-escalate path. FR-8.5 requires enforcement at execution with a breach halt.

## SEC-8 · P1 · No MFA anywhere

Repo-wide search for `mfa|2fa|totp|otp|authenticator|second factor|verifyOtp|signInWithOtp` across `apps`, `packages`, `services`, `infra` returns **only** UI copy strings and one control-library description. `04_Solution_Architecture.md §4.1` specifies "email+MFA in Phase 1". Not implemented. This is item 3 of your brief.

## SEC-9 · P1 · RBAC is four inline string comparisons; the web app has none

BFF role checks exist at exactly four places: `v1.ts:571`, `:596`, `:629`, `:714`. Everything else is role-agnostic. `apps/web/src` contains **zero** role checks — every page renders for every authenticated user. The `tenant_users.approval_scopes` column (`0001_init_tenants_users.sql:96`) is defined and never read. There are no persona views.

## SEC-10 · P2 · Ledger writes are fire-and-forget on a path that must not be

`v1.ts:900` uses `deps.ledger.appendAndForget(...)` for tenant creation. `packages/ledger/src/append.ts:50-56` documents the opposite rule: "per BR-3, no action bypasses the ledger, so a ledger write failure must fail the parent operation."

## SEC-11 · P2 · Hardcoded placeholder secret in the Temporal activity

`services/temporal-workers/src/temporal_workers/workflows.py:47` sends the literal string `"{{AGENT_RUNTIME_INTERNAL_TOKEN}}"` as the internal auth header — the template is never substituted. Cluster URL is hardcoded at `:39`.

## SEC-12 · P2 · Approval-engine nonce set grows without bound

`packages/approval-engine/src/index.ts:57` — `usedNonces: Set<string>` is never pruned. Unbounded memory growth in a long-lived process. Functionally harmless (DB is the source of truth) but it is a slow leak.

## QUA-1 · P2 · The security-critical service has no tests

`services/bff` — `vitest run --passWithNoTests`, **zero test files**. Turbo reports `@axiom/bff:test: No test files found, exiting with code 0`. `apps/web` likewise. The BFF holds auth, tenancy, RBAC, idempotency and the entire execution gate. CI is green on an untested attack surface.

Current baseline: TS **11/11 task-level passes** (all cached, mostly trivial package tests), Python **38/38 pass**, Playwright **4 spec files**.

## QUA-2 · P2 · Ten modules are display-only shells

`apps/web/src/app/(app)/generic-module-view.tsx` is a presentational template. These pages pass it hardcoded figures and render a ledger tail — they have no functionality:

`connectors` · `discovery` · `classification` · `datamap` · `execution` · `monitoring` · `policies` · `partner` · `controls` · `plans`

Example, `discovery/page.tsx:47-96`: `"12.4M rows"`, `"47 tables"`, `"8,210 files"`, `"6 vendors"` are string literals. The `"Run Discovery Scan"` button label has no backing endpoint.

This is fine as demo furniture — you said mock data may stay — but these are currently counted as delivered modules and they are not.

## QUA-3 · P2 · Control-library count is inconsistent in six places

Canonical is **46**, asserted at runtime: `packages/control-library/src/controls.ts:1640` `CONTROL_LIBRARY_COUNT = 46`, validated at `:1661`. 46 unique IDs across 13 domains (GOV 5, CNS 5, DAT 6, RCD 3, RTN 3, SEC 7, BRCH 3, XBR 3, CHD 2, SDF 3, DPF 2, DPIA 2, AUD 2).

Contradictions:

| Location                                  | Says            |
| ----------------------------------------- | --------------- |
| `apps/web/.../dashboard/page.tsx:336`     | 43              |
| `apps/web/.../reports/reports-client.tsx:46` | 48           |
| `docs/03_BRD_PRD.md:15` (§A.1)            | "forty-three"   |
| `docs/LOCAL_CHECKS.md:180,204`            | 43              |
| `VK_QUICK_REF_PROOF_MODULES_SETUP.md:1115`| 43              |
| Everywhere else (24 refs)                 | 46              |

The stray "47" you may have seen is `discovery/page.tsx:73` — "47 tables", not controls.

## CTL-1 · **P0 for a compliance product** · Control library cites the *draft* Rules numbering — nearly every Rules citation points at the wrong rule

Upgraded from P2 after verification. This is the most client-damaging defect in the repo.

The DPDP Rules 2025 were notified **13 November 2025** via Gazette **G.S.R. 846(E)** — **23 rules and 7 schedules**. The control library's `DPDPR-2025` citations were authored against an earlier draft numbering and were never re-mapped. Reports generated today cite the wrong law.

Extracted every `DPDPR-2025` citation and compared to the notified text:

| Control(s)                | Library cites   | What that rule **actually is** when notified | Correct rule              |
| ------------------------- | --------------- | -------------------------------------------- | ------------------------- |
| `GOV-002`, `CNS-002`      | Rule 5          | Processing by the State for subsidies        | **Rule 3** (Notice)       |
| `CNS-001`                 | Rule 5, 6       | State processing / security safeguards       | **Rule 3**                |
| `CNS-003` (7-yr consent)  | Rule 5(3)       | State processing                             | **Rule 4 + First Schedule** |
| `DAT-001/002/003/005`     | Rule 16, 17, 18 | Research exemption / Board appointment / Board salary | **Rule 14** (Rights of Data Principals) |
| `RCD-001/002/003`         | Rule 21         | Terms of service of Board *officers*         | **Rule 8** / **Rule 13**  |
| `BRCH-001/002`            | Rule 19, 20     | Board meetings / Board as digital office     | **Rule 7** (Intimation of breach) |
| `XBR-001`                 | Rule 13         | Additional obligations of SDFs               | **Rule 15** (Transfer outside India) |
| `SDF-001`                 | Rule 11         | Verifiable consent — persons with disabilities | **Rule 13**             |
| `SDF-002/003`, `DPIA-001/002` | Rule 12     | Exemptions for certain child-data processing | **Rule 13(2)**            |
| `SEC-001`                 | Rule 14, 15     | Rights of Data Principals / Transfer outside India | **Rule 6** (Reasonable security safeguards) |
| `CHD-001/002`             | Rule 10         | Verifiable consent for a child's data        | **Rule 10** ✅ *(the only correct one)* |

**Coverage gaps on top of the mis-citations.** Rules never cited at all: **1, 2, 3, 4, 7, 8, 9, 15, 22, 23** — 10 of 23. Named-Schedule references anywhere in the library: **zero** (verified: `grep -ioE "(first|second|third|fourth|fifth|sixth|seventh) schedule"` → no matches).

Operationally significant omissions:

- **Rule 3** — mandatory notice content and itemised-purpose presentation
- **Rule 7** — breach intimation particulars and the 72-hour Board report
- **Rule 8 + Third Schedule** — class-based retention (e-commerce ≥2cr users, online gaming ≥50L, social media ≥2cr → 3-year erasure) and the pre-erasure notice
- **Rule 9** — published contact information for processing questions
- **Rule 11** — verifiable consent for persons with disabilities (**no control exists in any domain**)
- **Rule 12 + Fourth Schedule** — child-data exemption classes (healthcare, education, childcare, transport safety)
- **Rule 15** — conditions on transfer outside India, including foreign-state requirements
- **Rule 16** — research/archiving/statistics exemption
- **Rules 22–23 + Seventh Schedule** — appeal to the Appellate Tribunal; calling for information
- **Rule 1** — the phased commencement itself (13 Nov 2025 / 13 Nov 2026 / **13 May 2027**), which is the readiness clock the whole product sells against

Fixing this is W7 and it is no longer a recount — it is a full re-map plus roughly 46 → ~65 controls.

Sources: [dpdp.ind.in/rules.php](https://dpdp.ind.in/rules.php) · [Shardul Amarchand Mangaldas — enforcement & notification](https://www.amsshardul.com/insight/enforcement-of-the-dpdp-act-and-notification-of-the-dpdp-rules/)

## PERF-1 · P2 · Per-action sequential DB round-trips in the execute path

`v1.ts:425-448` issues one `select().single()` per action inside a `for` loop. A 200-action batch is 200 sequential round-trips before execution starts. Should be a single `.in('id', actionIds)` fetch. Same pattern in the approve path.

## PERF-2 · P2 · Module pages are `force-dynamic` with uncached service-role queries

Every shell page sets `export const dynamic = 'force-dynamic'` and issues a fresh unindexed `audit_ledger` query with `count: 'exact'` on render. `count: 'exact'` on an append-only ledger is a full scan that grows forever. No caching, no `count: 'estimated'`.

## PERF-3 · P2 · No rate limiting

One reference repo-wide. `04_Solution_Architecture.md §4.1` lists rate limiting as an API Gateway responsibility. The public gap-scan endpoint and `/organizations/onboard` are both unthrottled.

---

# PART B — Capability gap register

Status key: **✅ built** · **🟡 partial** · **🔴 absent**

## B.1 Phase 0 — Foundation

| Module                          | Status | Evidence                                                                           |
| ------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| M0.2 Control Library v0         | 🟡     | 46 controls real and well-formed; Rules-2025 conformance pass outstanding (QUA-4)  |
| M0.3 Parikshan Assessment v0    | ✅     | `agents/parikshan.py` (167 ln), 3 tests pass                                        |
| M0.4 Prativedan Report v0       | 🟡     | `agents/prativedan.py` (185 ln) emits JSON/HTML; `pdf.render` scope declared, no PDF engine |
| M0.5 Free Gap-Scan              | ✅     | `apps/marketing/src/app/gap-scan/**`, scoring lib, report route, email dispatch     |
| M0.6 Agent Workbench            | 🟡     | `workbench-client.tsx` (438 ln) real; prompt/version registry tables exist, no UI   |

## B.2 Phase 1 — First cash

| Module                       | Status | Evidence                                                                 |
| ---------------------------- | ------ | ------------------------------------------------------------------------ |
| M1.1 Drishti Discovery v0    | 🟡     | Interview-driven only; `/discovery` page is a shell (QUA-2)              |
| M1.2 Vibhaag Classification  | 🟡     | Agent real (172 ln); **no `classification_reviews` table, no review UI** — FR-2.3/2.4 unmet |
| M1.3 RoPA Generator          | 🟡     | `ropa_generator.py` (96 ln) exists; **no `ropa_records` table**, nothing persists |
| M1.4 Sudhaar Planner v0      | ✅     | 227 ln, typed actions, rollback definitions, blast-radius escalation      |
| M1.5 Saakshi Evidence v0     | ✅     | 152 ln + `packages/evidence` content-addressed store                      |
| M1.6 Policy & Notice Gen     | 🟡     | `policy_generator.py` (51 ln); **no `policy_drafts` table**               |
| M1.7 Human Review Console    | 🟡     | Approval console exists; no generalised review queue with reason capture  |
| M1.8 Delivery Playbook       | 🟡     | `playbook.py` (27 ln); **no `playbook_entries` table**                    |

## B.3 Phase 2 — Repeatability

| Module                      | Status | Evidence                                                                            |
| --------------------------- | ------ | ----------------------------------------------------------------------------------- |
| **M2.1 Connector Framework**| 🔴     | **Zero implementation.** 46 repo references = 2 enum strings, 1 feature flag, tool-scope labels, UI copy. No adapter interface, no registry table, no credential vault, no health checks |
| M2.2 Drishti Live Discovery | 🔴     | Depends on M2.1                                                                      |
| M2.3 Vibhaag Automated      | 🟡     | LLM path exists; review queue absent                                                 |
| M2.4 Evidence Vault v1      | 🟡     | `packages/evidence` + storage buckets real; **WORM/Object-Lock unverified; no evidence-pack assembly or export** (FR-4.4) |
| M2.5 Lekha Ledger v1        | ✅     | Hash-chained, `append_ledger()` SECURITY DEFINER RPC, counters, verify endpoint. Strong. |
| M2.6 Approval Workflow v1   | ✅     | Approval engine + execution gate. Strong.                                            |
| M2.7 Prativedan Multi-Format| 🟡     | HTML only; no auditor pack, no DPB submission format, no signed PDF                  |
| M2.8 DSAR Tracker           | 🟡     | `dsars` table + `dsar-client.tsx` (517 ln); identity verification is UI copy, statutory clock not enforced server-side |
| M2.9 Nazar Regulatory Watch | 🟡     | Agent (83 ln) + `regwatch-client.tsx` (481 ln); no scheduler, no control-impact mapping |

## B.4 Phase 3 — Agentic execution ⭐ the core product

| Module                          | Status | Evidence                                                              |
| ------------------------------- | ------ | --------------------------------------------------------------------- |
| M3.1 Sudhaar v1 Structured      | ✅     | Typed, parameterised, risk-scored, rollback definitions               |
| **M3.2 Dry-Run / Simulation**   | 🔴     | `feature_dry_run_engine: bool = True` flag only. **No engine, no diff renderer.** The approval gate checks a status column nothing ever sets from a real simulation |
| M3.3 Approval Console v1        | ✅     | `approval-client.tsx` (857 ln) + `plans/[id]/` — the strongest surface in the app |
| **M3.4 Karya Execution v1**     | 🔴     | `agents/karya.py:120-130` returns `status="skipped"`, "execution deferred until Phase 3 connector framework is online". **Stub.** |
| **M3.5 Rollback Engine**        | 🔴     | Rollback *definitions* generated by Sudhaar; **no engine executes them** |
| M3.6 Blast-Radius Guardrails    | 🟡     | Planner-side only (SEC-7); kill switch process-local (SEC-4)           |
| **M3.7 Post-Exec Verification** | 🔴     | No agent, no module, no endpoint                                       |
| M3.8 Consent Management v1      | 🟡     | `consent/page.tsx` (334 ln) UI; **no consent tables, no ledger, no withdrawal workflow**. FR-12.2 and the 7-year retention rule unmet |
| M3.9 Breach & Incident v1       | 🟡     | `breaches` table + `breach-client.tsx` (331 ln); 72-hour clock is display-only, no notification generation |
| M3.10 Continuous Monitoring     | 🔴     | **No scheduler at all** — `grep -E "schedule\|cron"` = 0 hits. Page is a shell |
| M3.11 Client Portal             | 🟡     | `portal-client.tsx` (938 ln), tenant-filtered. Best-scoped page. No persona views |

## B.5 Phase 4 — Scale & continuous compliance

| Module                             | Status | Reference count |
| ---------------------------------- | ------ | --------------- |
| M4.1 Standing Approval Policies    | 🔴     | 0               |
| M4.2 Multi-Regulator Control Reuse | 🔴     | 0 (`RBI\|SEBI\|IRDAI\|CERT-In`) |
| M4.3 Connector Framework v2        | 🔴     | 0 (v1 absent)   |
| M4.4 Self-Serve SMB Tier           | 🔴     | 0               |
| M4.5 Vendor / Processor Risk       | 🔴     | 0 (`vendor\|TPRM`) |
| M4.6 DPIA Automation               | 🔴     | Control text only — no generator |
| M4.7 Partner / White-Label Portal  | 🔴     | Shell page; `tenants.partner_tenant_id` column exists, unused |
| M4.8 Sectoral Pack #1              | 🔴     | 0               |
| M4.9 Sanket Market Signal          | ✅     | 72 ln, functional |

## B.6 Phase 5 — Maturity

All 🔴 except the Terraform skeletons. M5.3 Enterprise Tier (SSO/SAML, granular RBAC) is the one item inside your stated scope and depends on W1 + W2 below.

## B.7 Your fifteen observations — where each lands

| #   | Your observation                                          | Verdict  | Addressed in |
| --- | --------------------------------------------------------- | -------- | ------------ |
| 1   | Client onboarding & sustenance, continuous monitoring      | Confirmed: onboarding is one endpoint that discards its input; no scheduler | W3, W6 |
| 2   | Multi-tenancy, RBAC, persona views                         | Confirmed: DB correct, app bypasses it (SEC-3); RBAC 4 checks (SEC-9) | **W0, W1** |
| 3   | Client estate/targets, multiple systems                    | Confirmed: `/organizations/onboard` accepts `systems[]` at `v1.ts:794-805` and **never persists it** — echoed back in the response at `:915`. No table, no model, no UI | **W3** |
| 4   | Connector definition, read/write grants to agents          | Confirmed absent (M2.1). Now solved by standards, not adapters — grants map to the target's own OAuth scopes, enforced at the client's IdP | **W4.1–W4.4** |
| 5   | Control count 46/47/48 + Rules conformance                 | Confirmed — and **worse than you flagged**: the count is inconsistent (QUA-3) *and* the citations point at draft rule numbers (CTL-1) | **W7** |
| 6/7 | Agents on different estates; multiple estates per client   | Confirmed: no estate dimension anywhere in the domain model | **W3** + **W3.5** (ER graph) |
| 8   | Progress monitoring before/during/after agent tasks        | Partial: `agent_runs` table + realtime channel exist; no per-task progress, no pre/post task record | W5 |
| 9   | **Reconcile Karya's work vs Sudhaar's approved plan (maker-checker)** | **Confirmed absent — `grep -iE "reconcil\|maker.check"` = 0 hits.** The separation of duties is designed; the *checker* half is not built | **W5** |
| 10  | Approval records and post-approval trail                   | Partial: tokens + usages + ledger are solid; no approval-record export, no post-execution closure pack | W5, W8 |
| 11  | Reports branded to Axiom Proof / Axiom Minds               | Partial: present in `reports-client.tsx:214,271,345-353` only. **Absent from Prativedan's own output, evidence packs and the gap-scan report** | **W8** |
| 12  | Evidence storage, retrieval, review                        | Partial: content-addressed store real; no pack assembly, no export, no verification UI | W8 |
| 13  | Monitor the continuous-monitoring setup; re-assess; auto-remediate | Confirmed absent (M3.10, M4.1) | **W6** |
| 14  | Multi-regulator reuse with indicative mappings             | Confirmed absent | **W7** |
| 15  | Connectors to CRM/HRMS/DWH/ticketing/code repo             | Confirmed absent. Delivered as **REST/OpenAPI descriptors** — declarative config per system, one descriptor each (Rev 7: MCP auto-discovery deferred) | **W4.7** |
| 16  | Sectoral packs                                             | Confirmed absent | W7 |
| —   | Multi-tenant + MFA (your item 3)                           | Tenancy partially real, MFA absent (SEC-8) | **W0, W1** |

---

# PART C — The plan

Ten workstreams. **W0 is a hard prerequisite for everything** — not because of ceremony, but because staging currently authenticates nobody and isolates nothing, so no other workstream can be verified there.

Sizing is relative (S/M/L/XL), not calendar. I have deliberately not invented day counts.

---

## W0 · Security remediation & environment parity — **P0, blocking** · size L

Nothing else ships until this lands. Size raised from M to L in Revision 4: preprod parity is not a config change, it is the removal of an entire class of code.

### W0.0 · The governing principle — one codebase, one ruleset

*Your instruction: preprod must authenticate exactly as production does, as an exact replica of the prod codebase and ruleset.*

The root cause of SEC-1, SEC-2 and SEC-13 is a single conflation: **environment identity has been used as a proxy for security posture.** `ENVIRONMENT === 'preprod'` is read in nine places to mean "relax the rules", and each site invented its own OR-chain to decide what relaxing means.

The fix is to separate the two concepts permanently:

| Concept | May vary by environment? | Examples |
| ------- | ------------------------ | -------- |
| **Topology** | **Yes** — this is what environments are for | Cluster, URLs, GCP project, bucket names, Supabase instance, replica count, log level |
| **Security ruleset** | **No — never** | Authentication, tenant resolution, RBAC, idempotency, RLS enforcement, credential validation, which database client is used |

Concretely:

1. **Delete every environment-conditional security branch in the codebase.** All nine sites in SEC-13, plus the `isDevOrTest` chains in SEC-1 and the cookie clauses in SEC-2. Not re-scoped — *deleted*. `grep -rn "ENVIRONMENT === 'preprod'" apps packages services` returning zero security-relevant hits is the acceptance test.

2. **One switch, defaulting to secure.** A single `resolveAuthMode()` in `@axiom/config`:
   - `AXIOM_AUTH_MODE` ∈ `{ strict, e2e-bypass }`, **default `strict`**.
   - `e2e-bypass` is **refused at boot** unless `ENVIRONMENT ∈ {local, test}`. The process exits with a clear error rather than degrading.
   - No other code anywhere reads `ENVIRONMENT` to make a security decision. Enforced by an ESLint rule plus a CI grep gate, so the pattern cannot grow back.

3. **`preprod`, `staging`, `production` and `onprem` all run `strict`.** Identical code path, identical rules. The only thing preprod does differently is point at different infrastructure.

4. **Fail closed, everywhere.** Supabase error or unreachable ⇒ `401`/`503`. Never a founder identity (SEC-1), never a "sovereign session" (SEC-13 row 6), never a cached bypass cookie.

5. **Legitimate preprod references stay.** `apps/marketing/src/lib/url-resolver.ts` and the GCP project/bucket naming are *topology* — they route to the right host. Those are correct and untouched. The distinction is exactly the table above.

### W0.1 · Making preprod a real replica

Code parity alone is not enough — preprod currently has no database to be strict against.

- **Provision a real Supabase/Postgres for preprod** and run the full migration series against it. Remove the `admin.ts` / `server.ts` mock substitution so preprod connects to it like production does.
- **Seed representative data, not fixtures** — multiple tenants, users across every persona, so RLS and RBAC are genuinely exercised. Never client production data.
- **Real auth**: real Supabase Auth users, real JWTs, real MFA enrolment once W1 lands.
- **Idempotency enforced** — remove the auto-key generation at `idempotency.ts:34` so FR-8.3 is actually tested.
- **Parity CI lane**: the same E2E suite runs against preprod and against a production-configured stack, and **any behavioural divergence fails the build**. That is what keeps parity true after this workstream ends.
- Same treatment for **staging** and **onprem** (W10) — all four strict, differing only in topology.

### W0.2 · The remaining findings

6. **Ban the service-role client from the web app** (SEC-3) — ESLint `no-restricted-imports` blocking `createSupabaseAdmin` inside `apps/web/**` plus a CI grep gate; migrate all 17 pages to the user-scoped client in W1.
7. **Distributed kill switch** (SEC-4) — Redis-backed with short-TTL local cache; `release()` becomes scope-aware; global release restricted to `founder`.
8. **Gate `/organizations/onboard`** (SEC-5) — entitlement check, per-user tenant quota, rate limit, `randomUUID()` slug suffix.
9. **Re-assert `dry_run_expires_at` in the execute path** (SEC-6).
10. **Fix** the Temporal placeholder token (SEC-11), bound the nonce set with a TTL map (SEC-12), make the onboarding ledger write blocking (SEC-10).

### Exit criteria

- `grep -rn "ENVIRONMENT === 'preprod'\|ENVIRONMENT === 'staging'" apps packages services` returns **zero** security-relevant hits.
- An unauthenticated request returns **401 in every environment**, verified by test in each.
- Setting `axiom_e2e_bypass=true` has **no effect anywhere**.
- Preprod runs on a real database, real auth, enforced idempotency, with the parity CI lane green.
- SEC-1 … SEC-13 closed, each with a regression test (W9).

---

## W1 · Tenancy, RBAC, MFA, personas — **P0** · size L

*Your brief items 2 and 3.*

**Tenancy.** Single `requireTenantContext()` server helper returning `{ tenantId, userId, role, scopes }` from the session + active-tenant cookie. Every page and route handler goes through it. All 17 pages migrated to the user-scoped client. Add a tenant-switcher for founder/partner multi-tenant users (the `user/tenants` endpoint already exists).

**Personas.** Define them once in `packages/types` as a capability matrix, not scattered strings. Proposed set, extending the existing `user_role` enum:

| Persona | Surface | Core capability |
| --- | --- | --- |
| `founder` | Workbench, all tenants | Everything; only role that can globally kill-switch |
| `axiom_analyst` | Workbench, assigned tenants | Run agents, review outputs; cannot approve client-side |
| `owner` | Portal | Tenant admin, billing, user management, approve |
| `approver` | Portal | Approve/reject/defer within `approval_scopes` |
| `reviewer` | Portal | Review agent output, comment, cannot approve |
| `viewer` | Portal | Read-only posture, reports, evidence |
| `partner` | Partner portal | Multi-client read + branded export |
| `agent` | Service | Machine identity, token-gated |

**RBAC.** Central policy module — `can(role, action, resource, scopes)` — replacing the four inline comparisons. Enforced in three places: BFF middleware, web server components (render gating), and RLS (already partly there). `tenant_users.approval_scopes` finally read: an approver may be scoped to specific action classes, which is also what makes W6 standing policies safe later.

**MFA — TOTP + recovery delivered; email OTP and SMS deferred by accepted scope.** The implementation intentionally uses self-managed TOTP (see migration 0012's decision note), encrypted secrets, recovery codes and session attestations. Preserve that choice. Email OTP is deferred; do not implement it without a later scope decision. Tables `user_mfa_factors`, `mfa_challenges` and `mfa_session_attestations` exist in 0012–0014. SMS stays defined-but-disabled with no provider or code.

Enforcement is **step-up, not blanket**: required at login for `founder` / `owner` / `approver`, and **re-challenged at the moment of approval-token issuance**. That second challenge is the one that matters — it binds a fresh, strong authentication to the exact act of approving, which is what FR-7.3 ("approver identity, timestamp, scope recorded") actually needs to mean in front of an auditor. Recovery codes issued at enrolment, single-use, hashed at rest.

**Authenticator replacement (Revision 22).** Replacing a live factor requires an `enrolment` challenge satisfied with the current authenticator or a recovery code, and the swap is atomic: migration 0030's `activate_totp_factor` retires the replaced factor and activates the new one under one set of row locks. The one-active-TOTP unique index makes any two-statement version either impossible or unsafe — revoke-then-activate leaves a window in which an account holds no factor, and a first enrolment is not step-up gated. Recovery codes are reissued on replacement so a code spent against the old factor does not outlive it.

**Exit:** a `viewer` in tenant A cannot see tenant B, cannot reach an approve button, and cannot call the approve endpoint. Proven by test, not inspection.

---

## W2 · Data model completion — **P0** · size M

Append-only migrations, allocated from the next unused number. **0000–0033 exist** at Revision 25; **0015 analyst is committed**. Inspect the actual branch before allocating more. Regulatory baseline and MFA tables listed below already exist; do not recreate them. Remaining target tables:

```
-- Estate (W3)
estates, estate_systems, system_data_categories, estate_scans -- DELIVERED by 0029; management/workflows pending

-- Universal Connection Framework (W4) -- SCHEMA DELIVERED by 0033; runtime pending
connectors,                    -- registered target instances + targetBinding
connector_descriptors,         -- capability descriptors (versioned, hash-pinned)
connector_credentials,         -- envelope-encrypted grant config, never raw tokens
connector_grants,              -- internal scope ↔ target OAuth scope, expires_at, revoked_at
connector_health_checks,
workload_identities,           -- SPIFFE IDs per agent workload
mcp_tool_registry              -- discovered tools, read/write class, description hash

-- Execution (W5)
dry_runs, rollback_executions, execution_batches, verification_results,
plan_reconciliations

-- Monitoring & policy (W6)
monitoring_schedules, drift_events, standing_approval_policies, policy_evaluations

-- Regulatory baseline & versioning (W7.0) -- DELIVERED; all six exist. Do not recreate.
regulatory_instruments,        -- content-hashed, with amends/supersedes chain
regulatory_provisions,         -- addressable: 'Rule 7(1)', 'Third Schedule'
regulatory_baselines,          -- frozen named set: 'IN-DPDP@2026-09-20'
control_provenance,            -- control <- provision, with verified_on/by
control_change_log,            -- typed diffs driving the semver bump
regulatory_signals,            -- Nazar watch output, triaged to baseline deltas

-- Multi-regulator & sector (W7.3/7.4)
frameworks, framework_controls, control_mappings, sector_packs

-- Phase 1/2 parity (Readiness Matrix §5.2)
ropa_records, policy_drafts, playbook_entries, classification_reviews

-- Rights & consent (W8)
consent_purposes, consent_records, consent_withdrawals, evidence_packs

-- Auth (W1)
user_mfa_factors, mfa_challenges
```

Tenant-owned tables require `tenant_id`, row-bound RLS and tenant-consistent foreign keys. **Do not copy the existing 0003/0004 write-policy pattern unchanged** (R-02). Global regulatory/catalogue reference tables require controlled publication and explicit read policy; personal MFA records are user-scoped. Index real access paths and test missing/stale JWT tenant claims. Normalise existing inline dry-run/execution fields deliberately rather than creating a second source of truth. Separate batch/request keys from action keys (R-04). Retention: `consent_records` 7-year minimum per FR-4.5, with legal-hold and withdrawal semantics defined.

---

## W3 · Client estate & onboarding — **P1** · size M

*Your brief items 1, 3, 6, 7.*

Today `/organizations/onboard` takes a `systems[]` array, validates it, and throws it away (`v1.ts:794-805` → `:915`).

- **Model:** tenant → **estates** (1:N) → **systems** (1:N) → connectors (1:N). An estate is the unit an assessment binds to, so one client can run separate Axiom-Proof-bound assessments on, say, "India production" and "Singapore subsidiary" independently.
- **Engagements bind to an estate**, not just a tenant — `engagements.estate_id`, with the control-library version already pinned.
- **Onboarding wizard** (real, replacing the single endpoint): company profile → estate definition → system inventory → connector registration → scope & access grants → readiness confirmation. Resumable; each step a ledger event.
- **Sustenance:** estate drift detection, re-onboarding for new systems, periodic access-grant re-attestation.

### W3.5 · Entity Relationship Graph page — *new, your item 5*

A first-class page (`/estate/graph`) rendering the live domain as an interactive node-edge graph, not a static diagram.

**Nodes:** tenant → estates → systems → connectors → data categories, plus the control/finding/evidence/plan objects bound to them, and the **ten agents** as first-class nodes.

**Edges carry meaning, and access is the point:**

| Edge style       | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| Solid teal       | Agent holds a **read** grant on that connector/system; hover shows grant type (`client_credentials`, `token_exchange`, …) and assurance level |
| Solid indigo + lock and WRITE label | Agent holds a **write** grant — scoped, time-bound; hover shows `expires_at`; gold remains reserved for sealed evidence/attestations |
| Dashed grey      | Structural containment (estate → system)             |
| *no edge*        | The default — eight of ten agents have no client-system access at all |
| Thin indigo      | Derivation (finding → control, evidence → finding)    |

Only Karya can carry client-system write edges; it may hold more than one scoped connector grant. The graph must derive those edges from enforced permissions and show Sudhaar has none. Colour and labels must distinguish write authority from sealed evidence.

**Icons — reuse what exists, build nothing new.** `packages/ui/src/components/AgentIcon.tsx` (877 ln) already ships bespoke icons for all ten agents plus `policy`, `policy_engine`, `incident`, `dsar`, `consent` — 15 keys, with `idle | thinking | working` states and `xs|sm|md|lg` sizing already wired. The graph uses `AgentIcon` directly as the node glyph, and drives the `working` state from the live agent-run channel so the canvas animates while agents are actually running. New icons needed only for infrastructure node types (system/connector/datastore), which follow the same SVG conventions.

**Interactions:** click a node → side panel with its records, grants and recent ledger entries; filter by agent, by estate, by access type; "show me everything Karya can write to" as a one-click view; export to PNG/SVG for board packs (branded per W8).

---

## W4 · Universal Connection Framework — **P1** · size XL

*Your brief items 4 and 15, re-architected. This is the single largest gap and it gates Phase 3.*

> **Revision 3 — direction change.** Do **not** build connectors one system at a time. Implement a small number of **standards** and describe each target system declaratively. `04_Solution_Architecture.md §5.2` already calls for a "Tool/MCP Server registry" — this is that design finally built, not a new one.
>
> The unit of work stops being "an adapter" and becomes "a grant handler, a transport, and a descriptor". Adding Salesforce should be a config file and a capability test, not a sprint.

### W4.0 · The layering

Four layers, each independently testable. The bottom two are the reusable framework; the top one is per-system configuration.

```
┌─ L4 · CAPABILITY DESCRIPTORS ──────────────────────────────┐
│  Declarative per target system (YAML, not code)            │
│  salesforce · workday · snowflake · jira · github · …      │
└───────────────────────────┬────────────────────────────────┘
┌─ L3 · TRANSPORTS ─────────▼────────────────────────────────┐
│  REST/OpenAPI (primary) · SQL catalogue · GraphQL          │
│  MCP — internal registry; outbound optional per-descriptor  │
│  all implement: enumerate → sample → read → (write)        │
└───────────────────────────┬────────────────────────────────┘
┌─ L2 · CREDENTIAL BROKER ──▼────────────────────────────────┐
│  oauth2.client_credentials   (RFC 6749 §4.4 / 2.1)         │
│  oauth2.token_exchange       (RFC 8693)                    │
│  oauth2.saml2_bearer         (RFC 7522)                    │
│  oauth2.jwt_bearer           (RFC 7523)                    │
│  + legacy lane (static key / DB auth) — lower assurance    │
│  issues SHORT-LIVED, SCOPE-NARROWED tokens. Never raw creds│
└───────────────────────────┬────────────────────────────────┘
┌─ L1 · WORKLOAD IDENTITY ──▼────────────────────────────────┐
│  SPIFFE / SPIRE — X.509-SVID & JWT-SVID per agent workload │
│  INTRA-PERIMETER only. All 10 agents; Karya's ID ≠ Sudhaar's│
│  Crosses to client systems as private_key_jwt assertion     │
└────────────────────────────────────────────────────────────┘
```

### L1 · Workload identity (SPIFFE)

Each agent runtime workload receives its own SVID. Karya, Sudhaar and Drishti are **distinct cryptographic identities**, not one service account with different code paths.

The benefit is real but its boundary matters, and Revision 3 drew it too generously — see **the workload-identity correction** under the MCP posture below. Precisely:

- **Inside Axiom's perimeter**, SVIDs give per-agent identity with a single trust domain and no federation. Sudhaar's workload is structurally incapable of presenting Karya's identity to the broker, so `connector.write` cannot be acquired on its behalf. This is enforceable and it ships in W4.3.
- **Across to the client**, SPIFFE does not reach without federation the client will not run. The SVID crosses the boundary as a `private_key_jwt` **client assertion** against **one** connector identity per tenant — see *External-system authentication* below. Per-agent registration at the client's IdP is available as **optional hardening**, not the default.

It is also the enabling primitive for **M5.1 split-plane** and **W10 on-prem** — an in-perimeter data plane proves its identity without a shared secret crossing the boundary.

### The full agent roster — identity and estate access for all ten

*Your question: the plan named Karya, Sudhaar and Drishti. What about the rest?*

Every agent gets its own SVID, not just the three I used as examples. Here is the complete roster, reconciled across all three places permissions are declared (`packages/types/src/agents.ts`, `services/agent-runtime/src/axiom/agents/*.py`, and `04_Solution_Architecture.md §5.2`).

**Estate access classes:**
**D** = direct — reaches client systems through a connector ·
**I** = indirect — never touches client systems, but processes estate-derived data including personal data ·
**N** = none — Axiom-internal or external-web only, never sees client data

| Agent | Autonomy | `canMutate` | Declared scopes | Estate | Needs a connector grant? |
| ----- | -------- | ----------- | --------------- | ------ | ------------------------ |
| **Drishti** | L1 | false | `connector.read`, `inventory.write`, `evidence.write` | **D** | **Yes — read**, per estate |
| **Karya** | L2 | **true** | `connector.write`, `evidence.write`, `rollback.execute` | **D** | **Yes — write**, per estate, approval-token gated |
| **Vibhaag** | L1 | false | *(none)* | I | No |
| **Parikshan** | L1 | false | `control_library.read`, `findings.write` | I | No |
| **Sudhaar** | L1 | false | `findings.read`, `control_library.read`, `plan.propose` | I | **No — never** |
| **Saakshi** | L1 | false | `evidence.write`, `s3.write_worm` | I | No |
| **Prativedan** | L1 | false | `report.write`, `pdf.render` | I | No |
| **Lekha** | L1 | false | `ledger.append`, `ledger.read` | N | No |
| **Nazar** | L1 | false | `http.read.government_sources`, ~~`control_library.write`~~ → `regulatory_signal.write` (SEC-15) | N | No |
| **Sanket** | L1 | false | `http.read.public_sources` | N | No |

**So: only two of ten agents ever touch a client estate.** Drishti reads it; Karya writes to it. Five more handle estate-*derived* data — including personal data — without any connector access at all. Three never see client data in any form.

That concentration is the real security story, and it is a good one. It means connector grants (W4.4) only ever need to be issued to two workload identities, and the client's IdP can be configured to refuse a connector token to any of the other eight outright.

#### Discrepancies found while reconciling — all fixed in this chunk

1. **Nazar** holds `control_library.write`; the architecture says "External sources read". See **SEC-15** — downgraded to `regulatory_signal.write`.
2. **Prativedan has no read scope at all**, yet the architecture describes it as "Read all". It assembles client-facing reports containing findings, evidence and personal data — so it has the **broadest de facto data access of any agent and the thinnest declared permissions**. Its reads are currently ungoverned. Gets explicit, tenant-and-estate-scoped read scopes.
3. **`canMutate` does not mean "read-only"** and is documented nowhere. Six of ten agents with `canMutate: false` hold a `.write` scope. It actually means "mutates *client* systems". A contributor reading `canMutate: false` as "harmless" would be wrong about Drishti, Parikshan, Saakshi, Lekha, Nazar and Prativedan. Renamed `mutatesClientEstate`, with `writesAxiomState` added alongside it.
4. **Saakshi's "write-once"** (architecture) is expressed as ordinary `evidence.write` + `s3.write_worm` strings with nothing enforcing append-only. WORM must be enforced at the object store (Object Lock / MinIO compliance mode), not asserted by a scope name.
5. **Drishti and Parikshan are understated** in §5.2 — "Connectors: read-only" and "Control Library read" omit `inventory.write`/`evidence.write` and `findings.write` respectively. Architecture doc corrected to match.

#### The missing dimension: scopes have no estate

This is the gap your question exposes most sharply. Every scope today is **global to the agent**: `connector.read` means *all connectors, everywhere*, not *connector X in estate Y for tenant Z*.

Under W3's multi-estate model — one client running separate assessments on "India production" and "Singapore subsidiary" — an agent authorised for one estate must not be able to read the other. **That is currently inexpressible.** Scopes become structured rather than flat:

```
connector.read:<tenant>:<estate>:<connector>
connector.write:<tenant>:<estate>:<connector>    # Karya only, approval-token bound
findings.write:<tenant>:<engagement>
```

Resolved at token-acquisition time by the credential broker (W4.2) and mapped onto the target's own OAuth scopes by the grant model (W4.4), so narrowing is enforced by the client's authorization server rather than by our string comparison.

#### Enforcement — making SEC-14 false

Declared scopes become checked scopes, at three layers:

1. **Workload identity (L1)** — each agent's SVID carries its permitted scope set. Karya's identity is the only one that can ever be issued a `connector.write` token; Sudhaar's identity is structurally incapable of holding one, enforced by the client's IdP rather than by our code.
2. **Broker (L2)** — refuses to acquire a token for a scope the requesting SVID does not hold. Over-broad requests are rejected and logged as a security event, not silently narrowed.
3. **Runtime (agent-runtime)** — every tool invocation checks the scope before dispatch. An undeclared scope raises and is written to the ledger. This is the piece that makes `tool_scopes` load-bearing instead of decorative.

A conformance test per agent asserts its declared set matches its enforced set, so the three declaration sites cannot drift apart again — which is how discrepancies 1–5 arose.

#### The ER graph makes this legible

W3.5 renders this matrix from enforced grants: **eight agents with no client-system access, teal read edges from Drishti, indigo write edges with lock/WRITE labels from Karya.** Gold is reserved for sealed evidence and attestations.

### L2 · Credential broker — the four grants

Every handler implements one interface: `acquire(grantConfig, requestedScopes) → { token, scopes, expiresAt, binding }`. Agents never see a credential; they receive a short-lived, scope-narrowed token.

| Grant | Spec | When it is the right choice |
| ----- | ---- | --------------------------- |
| **Client Credentials** | RFC 6749 §4.4, OAuth 2.1 | Axiom Proof is a registered app in the client's tenant. The common SaaS case. Prefer **`private_key_jwt`** (RFC 7523) or **mTLS** (RFC 8705) client auth over `client_secret` |
| **Token Exchange** | RFC 8693 | Agent acts *on behalf of* the tenant with constrained scope. `subject_token` = tenant delegation, `actor_token` = agent JWT-SVID |
| **SAML 2.0 Assertion** | RFC 7522, `urn:ietf:params:oauth:grant-type:saml2-bearer` | Enterprise has a SAML IdP and no OIDC M2M path. Common in Indian BFSI and large enterprises |
| **JWT Assertion** | RFC 7523, `…:grant-type:jwt-bearer` | The OIDC-native sibling of the SAML grant. Included because it is frequently the only thing a modern IdP exposes |

**Token Exchange deserves special attention — it upgrades the audit ledger.** RFC 8693's `act` claim carries a verifiable **delegation chain**. Today a ledger entry *asserts* "Karya did this under Priya's approval". With token exchange, the access token itself carries that chain, and **the client's own IdP logs corroborate it independently of us**. That is a materially stronger answer to FR-10.5 ("ledger integrity verifiable independently") and to a DPB inquiry — the evidence no longer rests solely on Axiom Proof's own record. Ledger entries will therefore also record the token `jti` and `act` chain.

Where the target supports it, tokens are **sender-constrained** — DPoP (RFC 9449) or mTLS binding — so a leaked token is not replayable.

**Honest limits.** Not everything speaks OAuth, and pretending otherwise would be a design lie:

- **Databases** (PostgreSQL/MySQL — our W4.4 target) generally use native auth. The path there is workload identity → **cloud IAM** (RDS IAM auth, Cloud SQL IAM) → short-lived DB token. Where the client runs self-hosted Postgres with password auth, it falls to the legacy lane.
- **Legacy Indian enterprise estate** — on-prem HRMS, custom ERP, file drops — frequently has none of these. There is an explicit **legacy lane** with static credentials, marked `assurance: 'low'` in the registry, surfaced as such in the UI and the estate graph, and barred from write scopes without additional per-action human confirmation.

### L3 · Transports

Each implements the same `enumerate → sample → read → (write)` contract, so descriptors are portable across transports.

- **REST / OpenAPI** — **the primary path.** Descriptor-driven from the target's OpenAPI document. This is what most SaaS in an Indian mid-market estate actually exposes.
- **SQL catalogue** — `information_schema` and equivalents, for data stores.
- **GraphQL** — introspection-driven.
- **MCP** — **scoped to the Axiom Proof perimeter only.** See the MCP posture below.

---

### MCP posture — internal only, outbound optional, inbound dropped

*Final. Revision 8.*

Revision 3 conflated two opposite directions. Separated and settled:

| | Direction | Decision |
| --- | --------- | -------- |
| **A** | **Outbound** — Axiom's agents → a client's MCP server | **Optional transport, not the primary path.** Implemented behind the same transport interface as REST/OpenAPI, enabled per-descriptor when a client actually runs an MCP server. Not built as part of the W4 critical path |
| **B** | **Inbound** — external systems → Axiom Proof | **Dropped.** Not in scope |
| — | **Internal MCP tool registry** — Axiom's own agents and tools, inside the perimeter | **Built in W4.5.** Delivers `04_Solution_Architecture.md §5.2`'s "Tool/MCP Server registry" as specified |

**Why outbound stays flexible rather than deleted.** Your read is right — most 50–200 employee companies have nothing in front of their systems, let alone an MCP server. So MCP cannot be the primary transport. But the transport layer is an interface, and the descriptor already names its transport, so an MCP-capable client is a one-line descriptor change rather than a re-architecture. Keeping the seam costs nothing; assuming the adoption would have cost a lot.

**Why inbound is dropped rather than deferred.** Two independent reasons, either sufficient:

1. It is another read surface, and **SEC-3 means we currently leak across tenants on the read surfaces we already have.** Adding one before isolation is enforced is indefensible.
2. Writes could never be offered over it anyway. An external MCP client performing a write would have to bypass the approval console — breaking AP-1 and BR-1 — or re-implement it over MCP, which cannot work: `§3.2` requires the approver see the action, statutory citation, **dry-run diff**, blast radius, risk reasoning and rollback plan, under the rule that *"an approver must never have to trust the agent to approve safely."* **An MCP tool call cannot show a human a diff.** The approval surface is a human review surface by design, not an API.

So inbound MCP would have been read-only forever, delivering a convenience feature onto an unresolved isolation problem. Dropped.

### External-system authentication — one connector identity, not ten

*Your call, and it is the right simplification.*

Revisions 3 and 7 proposed registering a **separate OAuth client per agent** at the client's IdP, so their authorization server could refuse a write-scoped token to anything but Karya. That bought defence-in-depth at a real cost: ten client registrations per connector, ten credential rotations, ten sets of scopes for a client's IT team to validate — a large authentication surface for a mid-market client to onboard, and one more thing to get wrong.

It is also largely redundant, because the fact it was protecting is **known statically**:

> Of ten agents, exactly one — **Karya** — writes to external systems. The other nine are read-only against client estates, and five of them never touch a client system at all.

That is not a runtime property needing an external authority to adjudicate. It is a fixed property of the architecture, enforced at three points inside our own perimeter.

**Final model:**

| Layer | What it holds | Enforcement |
| ----- | ------------- | ----------- |
| **Per tenant-connector** | **One** registered OAuth client identity, with read and write scopes available | Client's IdP |
| **Read scope** | Requested by any agent holding `connector.read:<tenant>:<estate>` | Broker (W4.2), SPIFFE-authenticated |
| **Write scope** | Requested **only** when the caller's SVID is Karya's **and** a valid approval token exists | Broker + approval gate (`v1.ts:319-470`) |

One registration, one rotation, one scope set to validate. Onboarding friction drops sharply, which matters for the ICP.

**The honest trade.** Enforcement of "only Karya writes" now lives entirely **inside Axiom's perimeter** — SPIFFE workload identity plus the broker plus the approval-token gate. A total compromise of Axiom Proof could, in principle, request a write token. Previously the client's IdP would also have refused it.

Three things make that acceptable:

1. The approval-token gate is independent of identity — a write still requires a signed, scope-bound, single-use token issued against a specific plan version and action set. Compromising the workload does not produce one.
2. Write scope is time-bound and revocable per grant (W4.4), and the client can revoke from their side at any moment.
3. Every token acquisition is a ledger event with the SVID and `act` chain recorded, so an anomalous write-scope request is visible rather than silent.

**Per-agent OAuth registration remains documented as optional hardening** for security-mature clients who ask for it. The framework supports it; we do not require it. That is the right default: available for the client who wants belt-and-braces, not imposed on the client who just wants to connect a database.

### Workload identity — the corrected boundary

Revision 3 claimed a client's IdP could refuse a write-scoped token to any identity but Karya's, on the strength of SPIFFE. **That was over-claimed**, and the decision above supersedes it anyway. The accurate position:

| Boundary | Mechanism | Status |
| -------- | --------- | ------ |
| **Inside Axiom's perimeter** — agent-runtime, BFF, model-gateway, temporal-workers, agent-to-agent, internal MCP registry | **SPIFFE/SPIRE SVIDs** for all ten agents. Single trust domain, one root of trust, no federation | **Real, enforceable, ships in W4.3** |
| **Across to client systems** | **OAuth grants** (W4.2) against one connector identity. The agent's JWT-SVID is the `private_key_jwt` client assertion | Real. The client validates a JWT signed by a key it trusts, not a SPIFFE identity |

SPIFFE never reaches into a client's infrastructure without federation the client would have to run SPIRE for — which no mid-market client will. Scoping it intra-perimeter is what makes W4.3 something that actually ships rather than an aspiration.

### Safety rules — retained for the internal registry

Unchanged from Revision 3, now applying to the internal tool registry and to outbound MCP if a client ever enables it:

1. **Tool classification is mandatory and deny-by-default.** Every registered tool is classified read or write. An unclassified tool is refused, not guessed.
2. **Tool output is data, never instruction.** Descriptions are hash-pinned at registration and re-verified each session.
3. **Karya's parameters come only from the approved plan** — bound by the approval token, so no connector or tool response can redirect execution.

### Scope impact — what changed, what did not

**Unaffected:** W0 · W1 · W2 · W3 · W3.5 · W4.1 · W4.2 · W4.4 · W4.6 · **W5 entire execution loop** · W6 · W7 · W8 · W9 · W10.

| Item | Final position |
| ---- | -------------- |
| W4.3 | **Simpler** — SPIFFE intra-perimeter only; no per-agent client registration to design or document |
| W4.5 | Internal MCP tool registry only |
| W4.7 | REST/OpenAPI primary; **absorbs item 15** via OpenAPI descriptors |
| Inbound MCP server | **Dropped from scope** |
| Outbound MCP client | Optional transport behind the existing interface; enabled per-descriptor |

**Nothing is lost from the delivered feature set.** Item 15's connectors use hand-written OpenAPI descriptors instead of MCP tool discovery — work always required for any target without an MCP server, which is nearly all of them.

### L4 · Capability descriptors — config, not code

Adding a system becomes a file:

```yaml
target: salesforce
transport: mcp
auth: oauth2.client_credentials      # private_key_jwt
assurance: high
capabilities:
  enumerate: { tool: list_objects }
  sample:    { tool: query_records, mutating: false }
  read:      { tool: query_records, mutating: false }
  write:     { tool: update_record, mutating: true, requiresApprovalToken: true }
dataCategoryHints: [contact, identity, financial]
rateLimit: { rps: 5, burst: 20 }
```

`connector_grants` maps Axiom's internal scope (`connector.read`) onto the **target's own OAuth scopes**, so scope is enforced at the client's IdP rather than only by our code — and a write scope is requested *only* when a valid approval token already exists.

### W4 chunking — seven sequential chunks

Each independently mergeable, tested and staging-deployable. **W5 unblocks at W4.4**, once a grant-enforced transport contract is stable.

| Chunk | Deliverable | Gate for |
| ----- | ----------- | -------- |
| **W4.1** | Registry + contract: `ReadConnector`/`WriteConnector` (TS + Python), capability-descriptor schema and loader, `connectors` / `connector_health_checks` tables, lifecycle | — |
| **W4.2** | **Credential broker core** + `client_credentials` and `jwt_bearer` handlers; per-tenant envelope-encrypted vault; rotation; zero plaintext in Postgres | — |
| **W4.3** | **SPIFFE workload identity, intra-perimeter** — SPIRE deployment, **SVIDs for all ten agents**, scope enforcement at identity/broker/runtime (closes SEC-14), Nazar downgraded to `regulatory_signal.write` (closes SEC-15), `token_exchange` handler with `act`-chain capture | Enforced SoD + W10 |
| **W4.4** | **Grant model** — `connector_grants` with scope/`expires_at`/`revoked_at`, mapped to target OAuth scopes; enforced per invocation; portal grant/revoke UI; ledger event per change | **W5 unblocks here** |
| **W4.5** | **Internal MCP tool registry** — perimeter-scoped, hash-pinned descriptions, deny-by-default read/write classification. Delivers §5.2's "Tool/MCP Server registry" | Governed agent tooling |
| **W4.6** | **First live binding — PostgreSQL/MySQL** via SQL transport + cloud-IAM credential path, end to end against a live staging database | Real Drishti discovery |
| **W4.7** | `saml2_bearer` handler + **REST/OpenAPI (primary)** and GraphQL transports; OpenAPI descriptor pack for CRM / HRMS / DWH / ticketing / code repo | Phase 4 surface, **absorbs item 15** |

### What "simulated" now means — and why this is a better position

The previous plan said one real adapter plus simulated bespoke adapters. That distinction largely dissolves under this architecture, and in your favour.

Because transports and grants are shared, a descriptor for an unconnected system still runs the **real transport, real grant handler and real scope enforcement**. Only the endpoint is synthetic. So instead of simulated *code*, we have real code pointed at a **sandbox or reference target**.

`targetBinding: 'production' | 'sandbox' | 'reference-mock'` replaces `implementation: 'live' | 'simulated'`. The labelling rules from Revision 2 carry over unchanged and still apply to anything not `production`:

1. **Type-level** — `targetBinding` is required on every descriptor; no default; omission fails the build.
2. **Runtime** — a non-`production` binding cannot be granted a write scope. Structurally incapable of reaching W5 execution.
3. **UI** — persistent amber chip on the connector card, the estate-graph node, discovery headers, and any derived finding or evidence.
4. **Evidence & reports** — `provenance` recorded, visible watermark, **excluded from auditor packs and DPB submissions by default**.
5. **Ledger** — `connector.targetBinding` on every entry, so the trail stays honest retrospectively.
6. **Code & docs** — `TODO(W4.x)` header on every non-production descriptor; CI regenerates `docs/CONNECTOR_STATUS.md` so the live/sandbox split can never drift from the code.

Promoting a system to production becomes **changing an endpoint and a binding flag**, not rewriting an adapter — which is the whole point of the change you asked for.

---

## W5 · Phase 3 execution loop — **P1** · size XL

*Your brief items 8, 9, 10. This is "the core product" per the phase plan.*

1. **Dry-Run / Simulation Engine (M3.2).** Per action type, a simulator that produces a **structured diff** (before/after), not prose. Writes `dry_runs` with a TTL. The design rule from `04 §3.2` is load-bearing: *if the diff cannot be rendered legibly, the action is not eligible for agent execution and routes to manual handling* — so the engine must be able to refuse.
2. **Karya v1 (M3.4).** Replace the stub. Typed action catalogue → connector dispatch. Idempotent, pre/post state captured to evidence, configurable concurrency, stop-on-failure, per-action token re-validation (the gate already exists — wire the executor behind it).
3. **Rollback Engine (M3.5).** Executes the Sudhaar-generated rollback definitions. Itself dry-run-able. Auto-trigger on failure threshold within a batch.
4. **Execution-time blast-radius governor (SEC-7).** Re-check actual affected counts against the cap mid-batch; breach ⇒ halt + escalate.
5. **Post-Execution Verification Agent (M3.7).** Re-runs the specific Parikshan checks the remediation targeted; emits closure evidence.
6. **Reconciliation / maker-checker (your item 9 — currently zero implementation).** A `plan_reconciliations` record produced after every batch, comparing **approved scope** vs **executed reality**:
   - actions approved but not executed, and why
   - actions executed — parameter-level diff against the approved parameters
   - anything executed outside approved scope (must be structurally impossible; the reconciler asserts it and screams if not)
   - verification outcome per action
   - a signed reconciliation statement sealed into evidence

   This is the *checker* half of the maker-checker design. The architecture separates Sudhaar (maker) from Karya (doer); the reconciler is the independent third role that proves they agreed. It is also the artifact an auditor will actually ask for.
7. **Progress telemetry (your item 8).** Per-task lifecycle events — queued → started → progress% → completed — over the existing WebSocket channel, with pre-task and post-task records in `agent_runs`.

---

## W6 · Continuous compliance — **P1** · size L

*Your brief items 1, 13.*

- **Scheduler.** Nothing exists today. Temporal is already deployed and is the right home — durable, survives restarts, handles human-approval waits. Cron-style `monitoring_schedules` per estate driving re-discovery and re-assessment.
- **Drift detection** against the last sealed baseline; `drift_events` with severity; alerting on newly-introduced gaps.
- **Standing approval policies (M4.1).** Human-authored, scope-bounded — *"auto-remediate expired-retention deletions under 1,000 records in non-production"*. Evaluated by a policy engine that issues a **scoped approval token automatically** when an action falls inside policy, and escalates otherwise. Critically: this reuses the existing token gate rather than bypassing it, so L3 autonomy inherits the same architectural guarantee as L2.
- **Monitoring-of-the-monitoring (your specific ask).** A meta-health surface: are schedules firing, are connectors healthy, when did each estate last get assessed, which policies fired and what did they do. This is what makes "continuous" defensible rather than assumed.

---

## W7 · Control library & multi-regulator — **P0-adjacent, starts day one** · size L

*Your brief items 5, 14, 16.*

Re-scoped upward after CTL-1. This is now **P0-adjacent** — the product currently cites the wrong law in client-facing reports — and it runs from day one in parallel with W0.

### W7.0 · Regulatory baseline & library versioning — *the foundation for everything else in W7*

*Your instruction: version the library properly, with today's gazette position as the baseline, and track inclusions, changes and sources over time.*

The current model is a good skeleton that stops one level short. `control_libraries` already treats a version as an immutable **publication event**, `controls` is keyed `(id, library_version)`, each control carries `introducedInVersion` / `revisedInVersion`, and assessments pin `library_version` (FR-3.5). What is missing is the thing underneath: **the library has no recorded relationship to the law it claims to implement.** There is one free-text `change_log` string and no way to answer "which gazette text was this control verified against, by whom, when?"

That is also why CTL-1 went unnoticed for a year.

#### The baseline chain, as of today

Verified for this document:

| Instrument | Gazette | Date | Status | Effect |
| ---------- | ------- | ---- | ------ | ------ |
| DPDP Act, 2023 | Act 22 of 2023 | 11 Aug 2023 | In force (phased) | Primary |
| **DPDP Rules, 2025** | **G.S.R. 846(E)** | **13 Nov 2025** | Notified | 23 rules, 7 schedules |
| **Corrigendum** | **G.S.R. 892(E)** | **11 Dec 2025** | Notified | Amends Rule 1(3) & 1(4) — wording only, **non-substantive**; commencement dates unchanged |
| MeitY proposal — 18 months → 12 months | — | — | **Proposed, not notified** | Would move 13 May 2027 → 13 Nov 2026 |

Commencement under Rule 1 as corrected:

- **13 Nov 2025** — Rules 1, 2, 17–21 *(in force now)*
- **13 Nov 2026** — Rule 4, Consent Managers *(~2 months away)*
- **13 May 2027** — Rules 3, 5–16, 22, 23 — the core compliance set *(~8 months away)*

Baseline declared as **`IN-DPDP@2026-09-20`** = { Act 22 of 2023, G.S.R. 846(E), G.S.R. 892(E) }, with the MeitY proposal tracked as `proposed` and excluded from compliance scoring.

The corrigendum is a neat proof of why this matters: it *did* amend the Rules, and it *should not* invalidate a single assessment, because it changed grammar and not obligation. Only a model that records change **type** can tell those apart. A free-text changelog cannot.

#### Semver, with defined meaning

"Major / minor / revision" has to mean something specific or the numbers are decoration. The rule is **assessment comparability**:

| Bump | Trigger | Effect on existing assessments |
| ---- | ------- | ------------------------------- |
| **MAJOR** | Scoring model, domain taxonomy, or control-identity changes | **Not comparable.** Posture scores cannot be compared across a major. Re-assessment required |
| **MINOR** | Controls added, removed or **materially** reworded; a new instrument enters the baseline | Still comparable, with deltas shown. Re-assessment recommended, not forced |
| **PATCH** | Citation corrections, typos, clarified guidance, non-substantive corrigenda — **what is tested does not change** | Fully valid. No re-assessment |

This immediately resolves a commercial question in W7: **the CTL-1 citation fix is a PATCH.** The controls test exactly what they tested before; they now cite the right rule. Existing client assessments stay valid and do not need re-running — which would have been an awkward conversation. Adding the ~19 controls for uncited rules is a separate MINOR.

So W7 ships as a sequence, each step independently releasable:

| Version | Content | Bump rationale |
| ------- | ------- | -------------- |
| `0.1.0` → **`0.1.1`** | W7.1 citation re-map against G.S.R. 846(E) + 892(E); fix the header's factual errors | PATCH — same tests, correct law |
| `0.1.1` → **`0.2.0`** | W7.2 new controls for the 10 uncited rules and all 7 schedules; new domains `NTC`/`PWD`/`CMG`/`APL` | MINOR — ~46 → ~65 controls |
| `0.2.0` → **`1.0.0`** | Scoring recalibration, `effectiveFrom` per control, baseline formally declared, multi-framework mappings | MAJOR — scoring model changes |

#### Schema (extends `0002_control_library.sql` rather than replacing it)

```sql
regulatory_instruments     -- the law itself, as retrieved
  id, jurisdiction, short_code,          -- 'GSR-846E'
  title, gazette_ref, published_on, effective_from,
  status,                                -- notified | corrigendum | proposed | draft | repealed
  source_url, retrieved_at, content_sha256,
  amends_id, supersedes_id               -- the chain

regulatory_provisions      -- addressable units
  id, instrument_id, provision_ref,      -- 'Rule 7(1)', 'Third Schedule'
  heading, text_sha256

regulatory_baselines       -- a frozen, named instrument set
  id, code,                              -- 'IN-DPDP@2026-09-20'
  declared_on, declared_by, instrument_ids[], baseline_sha256

control_libraries          -- EXTEND existing table
  + baseline_id, semver_major, semver_minor, semver_patch,
    content_sha256, supersedes_version,
    status                               -- draft | published | deprecated

control_provenance         -- the missing link: control ← provision
  control_id, library_version, provision_id,
  mapping_type,                          -- derives_from | supports | informational
  verified_on, verified_by, verification_method, note

control_change_log         -- typed, per-control diffs between versions
  from_version, to_version, control_id,
  change_type,                           -- added | removed | reworded_material
                                         -- | citation_corrected | scoring_changed
                                         -- | severity_changed | evidence_changed
                                         -- | deprecated | superseded_by
  rationale, source_instrument_id, diff jsonb

regulatory_signals         -- Nazar's output, triaged
  id, source_url, detected_at, retrieved_sha256,
  signal_type, summary,
  status,                                -- new | triaged | accepted | rejected
  proposed_instrument_id, affected_control_ids[]
```

Two properties fall out of this:

- **Content-hashed and tamper-evident.** `content_sha256` on instruments, baselines and library versions means a published version is verifiable the same way sealed evidence is. A report can state *"assessed against control library 1.0.0, baseline `IN-DPDP@2026-09-20`, hash `abc…`"* and a third party can check it. That is the same trust model as the audit ledger, applied to the rulebook.
- **`verified_on` / `verified_by` is the CTL-1 vaccine.** A citation now carries provenance of the *source*, not just the version it appeared in. A citation never verified against a notified instrument is visible as such, and CI can fail on any control whose provenance is missing or older than its baseline.

#### Closing the loop with Nazar (M2.9)

This is what turns regulatory watch from a feed into a workflow. Nazar monitors MeitY / DPB / gazette sources; on detecting a new or amended instrument it writes a `regulatory_signals` row with the source URL and retrieved hash, maps it to affected controls through `control_provenance`, and opens a **proposed baseline delta** for human review. On approval, a new baseline and library version are cut, with the change type determining the semver bump. Nothing enters the compliance baseline without a human accepting it — consistent with BR-1.

`proposed` instruments are the other half. The MeitY 12-month proposal is live right now and clients need to plan for it, but it is not law. Proposed instruments drive a **"what-if" posture view** — *"here is your position if the deadline moves to 13 Nov 2026"* — without contaminating the compliance baseline. For a product whose whole pitch is readiness against a deadline, that view is close to a feature in its own right.

#### Also fix, while in here

The current library header (`controls.ts:6-28`) contains factual errors: it dates notification to **14 November 2025** (it was the 13th), refers to **"rules 5–24"** (there are 23), and maps children's-data controls to "Rules 9–10" and SDF to "Rules 11–12" (correctly Rule 10 and Rule 13). All corrected in `0.1.1`.

Sources: [dpdprules.org — Rule 1 commencement](https://dpdprules.org/rules/1) · [dpdp.ind.in — all 23 rules and 7 schedules](https://dpdp.ind.in/rules.php) · [Shardul Amarchand Mangaldas — notification & enforcement](https://www.amsshardul.com/insight/enforcement-of-the-dpdp-act-and-notification-of-the-dpdp-rules/)

---

**W7.1 · Citation re-map (do this first, it is a correctness fix, not a feature).** Re-map all 24 `DPDPR-2025` citations against G.S.R. 846(E). Verify the 12 `DPDPA-2023` Act-section citations in the same pass. Add a `citations.verifiedAgainst` field recording the gazette reference and verification date, so this class of drift is detectable next time rather than invisible.

**W7.2 · Close the coverage gaps (your item 4 — "all missing controls in any form, including schedules").** New controls for the 10 uncited rules and all 7 schedules:

| New control area                    | Instrument                          |
| ----------------------------------- | ----------------------------------- |
| Notice content & itemised purposes  | Rule 3                              |
| Consent Manager engagement duties   | Rule 4 + **First Schedule**         |
| State-processing standards          | Rule 5 + **Second Schedule** *(conditional — applies only to State-instrumentality tenants; gated by a tenant flag so it never fires spuriously)* |
| Reasonable security safeguards      | Rule 6 *(re-anchors `SEC-001`)*     |
| Breach intimation particulars + 72h | Rule 7                              |
| Retention, erasure & pre-erasure notice; class-based periods | Rule 8 + **Third Schedule** (e-commerce ≥2cr users, online gaming ≥50L, social media ≥2cr → 3-year erasure) |
| Published contact for processing Qs | Rule 9                              |
| **Verifiable consent — persons with disabilities** *(no control exists today, in any domain)* | Rule 11 |
| Child-data exemption classes        | Rule 12 + **Fourth Schedule**       |
| Transfer outside India, incl. foreign-state requirements | Rule 15 *(re-anchors `XBR-001`)* |
| Research / archiving / statistics exemption | Rule 16                     |
| Appeal to Appellate Tribunal        | Rule 22                             |
| Responding to a call for information | Rule 23 + **Seventh Schedule**     |
| Board-procedure awareness           | Rules 17–21 + **Fifth/Sixth Schedules** *(informational domain — these bind the Board, not the fiduciary; included as `informational: true` so they inform readiness without polluting the posture score)* |
| **Phased commencement clock**       | Rule 1 — 13 Nov 2025 / 13 Nov 2026 / **13 May 2027** |

Expected: **46 → ~65 controls**. New domains: `NTC` (notice), `PWD` (persons with disabilities), `CMG` (consent manager), `APL` (appeal/regulatory response).

**Rule 1 is more than a control.** The staggered commencement is the readiness clock the product sells against. It becomes a first-class field — every control carries `effectiveFrom`, and the posture score can answer *"compliant as of today"* versus *"compliant as of 13 May 2027"*. That distinction is the entire mid-market sales conversation.

**W7.3 · Single-source the count (QUA-3).** `CONTROL_LIBRARY_COUNT` derived from the array, not asserted against a literal. Every UI and doc reference reads from it. CI test fails the build on any hardcoded control count anywhere in the repo.

**W7.4 · Release the version sequence.** `0.1.0 → 0.1.1 → 0.2.0 → 1.0.0` per the W7.0 table, each published as an immutable, content-hashed version bound to baseline `IN-DPDP@2026-09-20`. Because the citation fix is a PATCH, engagements pinned to `0.1.0` need **no re-assessment** — they are offered a free re-issued report carrying corrected citations against the same results. Only the `1.0.0` scoring recalibration triggers a re-assessment prompt.
3. **Multi-regulator reuse (M4.2).** `frameworks` + `control_mappings` with an explicit `mapping_strength` ∈ `{equivalent, partial, indicative}` — **indicative mappings labelled as such**, per your wording. RBI, SEBI, IRDAI, CERT-In overlays. One evidence artifact satisfies N controls across M frameworks; cross-framework coverage map in the portal.
4. **Sectoral packs (M4.8).** Pack = control subset + overlay mappings + sector-specific evidence requirements + remediation patterns. Pack #1 per your choice (see Part E).

---

## W8 · Reporting, evidence, branding — **P1** · size L

*Your brief items 10, 11, 12.*

- **Branding by default (your item 11).** Today branding lives only in `reports-client.tsx`. Move it into a shared `@axiom/report-kit` — Axiom Proof lockup, "Axiom Minds Private Limited", `https://axiomminds.ai`, agent attribution and named human approver (FR-11.4) — applied to **every** generated artifact: Prativedan output, evidence packs, DSAR responses, breach notifications, the gap-scan report. Tenant/partner white-label becomes an *override* of this default, never a replacement of the Axiom Minds attribution.
- **Server-side PDF** (Readiness Matrix §5.1.3): headless Chromium in the agent-runtime image; content-hash each PDF into the evidence vault.
- **Evidence retrieval & review (your item 12).** Evidence explorer with full-text + control + agent + date filters; **evidence-pack assembly and export** (FR-4.4) for auditors/DPB; independent hash verification UI so a reviewer can check a seal without trusting the platform; evidence-to-control linkage shown both directions.
- **Report formats** (FR-11.1): board report, auditor pack, DPB-ready submission, technical remediation register. Every claim traceable to an artifact (FR-11.3).
- **Approval records** (your item 10): exportable approval history — who approved what, when, under which scope, backed by which dry-run, with the reconciliation statement attached.

---

## W9 · Test, audit and performance — **P0, runs alongside everything** · size L

Current state: BFF and web have **zero tests** behind `--passWithNoTests`.

1. **Remove `--passWithNoTests`** from `services/bff` and `apps/web` once suites exist. Add a coverage floor to CI.
2. **BFF suite — highest priority.** The execution gate, auth, tenancy, RBAC, idempotency. Including explicit adversarial cases:
   - unauthenticated request ⇒ 401 in every environment
   - tenant A token + tenant B `X-Tenant-Id` ⇒ 403
   - `axiom_e2e_bypass` cookie ⇒ no effect, on page routes **and** the BFF proxy
   - login-time service failure ⇒ 503, never a "sovereign session"
   - mutating request with no `Idempotency-Key` ⇒ 400 in every environment
   - forged / expired / replayed / scope-mismatched approval token ⇒ rejected
   - stale dry-run ⇒ execution refused
   - partial batch approval executes **exactly** the approved subset (PRD §B.10.4)
   - kill switch halts in-flight execution across replicas
3. **RLS integration tests** against a real Postgres — the policies are good and completely untested.
4. **E2E (Playwright)** for each persona: founder, owner, approver, reviewer, viewer, partner — asserting both visibility and action-level authorisation.
5. **PRD §B.10 acceptance suite** — all eight Phase 3 acceptance criteria as executable tests. That is the definition of "Phase 3 done".
6. **Performance:** fix PERF-1 (batch the per-action fetch), PERF-2 (`count: 'estimated'` + caching + ledger indexes), PERF-3 (rate limiting). Load-test discovery against NFR-7 (1M records/hour/connector) once W4 lands.
7. **Standing audits:** `pnpm audit` + secret scanning + the `no-restricted-imports` tenancy gate in CI.

**Connection-framework coverage (W4).** Each grant handler gets a conformance suite against a reference authorization server — token acquisition, scope narrowing, expiry, refusal on over-broad scope request, `act`-chain capture for RFC 8693. MCP transport gets adversarial tests: unclassified tool ⇒ refused; tool description hash changed after registration ⇒ session refused; connector output attempting to alter Karya's action parameters ⇒ no effect, because parameters are bound by the approval token.

**Scope confirmed (your item 7): comprehensive, not selective.** Every package, app and service gets a suite — including the ones that have none today (`services/bff`, `apps/web`) and every new module added by W1–W8 and W10. No new module merges without tests. `--passWithNoTests` is removed everywhere once suites exist, and a coverage floor gates CI thereafter.

---

## W10 · On-prem deployment environment — **P2** · size M

*Your brief item 3. This is the slice of Phase 5 (M5.2) you asked to pull in.*

Rather than deferring on-prem to a future packaging project, `onprem` becomes a **first-class deploy environment alongside local / staging / preprod / production**, so it is exercised continuously instead of discovered late.

- **Config.** Extend the `ENVIRONMENT` enum at `packages/config/src/index.ts:12` — currently `['development','staging','preprod','production','local']` — to include `onprem`. Per the W0.0 principle this is purely a **topology** value: like `preprod` and `staging` after W0, `onprem` runs `AXIOM_AUTH_MODE=strict` and inherits every production credential check. No environment is ever a relaxed mode.

  This also closes a latent W0 issue: the `superRefine` at `packages/config/src/index.ts:117-122` currently **skips all production credential validation** whenever `ENVIRONMENT` is `staging` or `preprod`. Same fail-open family as SEC-1 and fixed in the same pass.

- **Artifacts.** `infra/docker/docker-compose.onprem.yml` + Helm values for a self-contained stack: Postgres, MinIO (S3-compatible, Object Lock for WORM), Temporal, Redis, all four services. No dependency on Supabase Cloud, GCP or AWS.
- **Sovereignty.** No outbound egress required by default. Model Gateway configured for a self-hosted model endpoint (NFR-10, "self-hosted model support by Phase 5"); any outbound LLM call is explicit opt-in and allowlisted.
- **Licence & identity.** Offline licence token; local admin bootstrap; MFA via TOTP works fully air-gapped, which is precisely why TOTP-first (W1) is the right call — email OTP degrades gracefully where there is no mail relay.
- **Evidence.** MinIO Object Lock in compliance mode to satisfy FR-4.1 WORM semantics without AWS.
- **Verification.** An `onprem` CI lane that boots the full stack from scratch and runs the E2E suite against it — the only way this stays real.

---

## C.1 Sequencing

```
W0  Security ───────────────────────────────────────────┐ blocks everything
     │                                                  │
W2  Data model ──┬── W1 Tenancy / RBAC / MFA ───────────┤ makes staging testable
                 │                                      │
                 ├── W3 Estate ──── W3.5 ER graph ──────┤
                 │        │                             │
                 │   W4 Universal Connection Framework  │
                 │    4.1 registry+descriptors                 │
                 │    4.2 credential broker (CC, JWT-bearer)   │
                 │    4.3 SPIFFE identity + token exchange     │
                 │    4.4 grant model ─────────────────────────┐
                 │    4.5 internal MCP tool registry           │
                 │    4.6 live binding: PostgreSQL/MySQL       │
                 │    4.7 SAML grant + REST/GraphQL + packs    │
                 │                                      │      │
                 │   W5 Execution loop ◀────────────────┼──────┘ starts at W4.4
                 │    dry-run ─ Karya ─ rollback ─ verify ─ reconcile
                 │                                      │
                 ├── W6 Continuous / standing policies ─┤ Phase 4 L3
                 └── W8 Reporting / evidence / branding ┘

W7  Control library ──── starts day one, parallel to W0   (CTL-1 is a correctness fix)
W10 On-prem environment ── parallel from W0; shares the config hardening
W9  Tests & audits ────── continuous, gates every merge
```

**Current dependency:** W7 publication/runtime parity and W10 configuration hardening can proceed alongside W0. W5 implementation starts after **W4.4**, once the grant model is stable; live execution acceptance also requires the real W4.6 target and W5 rollback/verification. This corrects the earlier W4.3/W4.4 contradiction.

---

# PART D — Verification strategy

**Definition of done for each workstream:** tests written first where the behaviour is security-relevant, suite green, no `--passWithNoTests`, deployed to staging with `AXIOM_AUTH_MODE=strict`, and exercised through the UI as each persona.

**Per-merge gate:** typecheck · lint · unit · RLS integration · E2E · no-service-role-in-web grep · secret scan · control-count consistency check.

**Phase 3 sign-off** is the eight PRD §B.10 criteria as passing tests, plus a live rollback exercised in a controlled staging estate.

I will report failures with the actual output rather than summarising them, and will not call a workstream done until its suite is green.

---

# PART E — Decisions

These change the shape of the work, so I would rather ask than assume.

## E.1 Resolved — 20 Sep 2026

| # | Decision | Resolution | Lands in |
| - | -------- | ---------- | -------- |
| 1 | MFA second factor | **TOTP + email OTP. SMS deferred** — enum slot reserved, no provider, no code | W1 |
| 2 | Connector depth | **Latest decision, Rev 8:** Universal Connection Framework; SPIFFE identity, scoped credential broker, **REST/OpenAPI primary**, optional outbound MCP per descriptor, inbound MCP dropped. Real protocol bindings plus declarative capabilities; initial live PostgreSQL/MySQL target, other reference targets labelled by provenance. Phase 2's three-live-type exit remains separate | W4.1–W4.7 |
| 3 | Phase 5 on-prem | **In scope** as a dedicated `onprem` deploy environment, validated at production strictness | **W10** |
| 8 | Preprod authentication | **Exact replica of production — same codebase, same ruleset.** Environment determines topology only, never security posture. Real database, real auth, enforced idempotency, parity CI lane | **W0.0, W0.1** |
| 9 | Control library versioning | **Versioned against a declared regulatory baseline** — `IN-DPDP@2026-09-20`, content-hashed, with per-control source provenance, a typed change log, and semver defined by assessment comparability. Future revisions enter via Nazar → human review → new baseline | **W7.0** |
| 10 | Agent access rights | **All ten agents** get SVIDs and enforced, tenant/estate-scoped permissions. Only Drishti (read) and Karya (write) ever reach a client estate; Nazar loses `control_library.write` | **W4.3**, W7.0 |
| 11 | MCP scope | **Inbound dropped.** Outbound kept **flexible** — optional transport, enabled per-descriptor when a client has an MCP server. Internal tool registry in W4.5. **REST/OpenAPI is the primary transport** | **W4.5, W4.7** |
| 12 | External-system auth | **One connector identity per tenant**, not per agent. `connector.write` requestable only by Karya's SVID + valid approval token. Per-agent OAuth registration available as optional hardening | **W4.2, W4.3, W4.4** |
| 4 | Control library | **Add every missing control in any form, including all 7 Schedules** — plus the citation re-map forced by CTL-1 | W7 |
| 5 | Client estate | **Build all missing pieces**, plus a new **Entity Relationship Graph** page showing entities, relationships and agent read/write access, reusing the existing `AgentIcon` set | W3, **W3.5** |
| 6 | Maker-checker | **Build it** — Sudhaar cannot execute, Karya cannot plan, reconciliation proves they agreed | W5.6 |
| 7 | Tests | **Comprehensive across every package/app/service**, including `services/bff` and all new modules | W9 |

## E.2 Still open — not blocking, needed before the workstream that uses it

1. **Sectoral pack #1 (needed before W7's pack work).** Healthcare (ABDM/NHA retention vs DPDPA erasure conflict) or BFSI (RBI / Account Aggregator overlay)? Pick whichever is closest to your live pipeline — everything before it proceeds regardless.

2. **Mock-data line (needed before W3/W4 UI work).** You said mock may stay for demo. My proposal: permitted **only** behind an explicit `demo` tenant flag, never hardcoded in a page component (QUA-2), and subject to the same `provenance: 'simulated'` labelling as simulated connectors. Everything else reads real tables, empty states included. I will proceed on this basis unless you say otherwise.

3. **Sessions after an authenticator is replaced (Revision 22; needed before W1 acceptance).** Replacing a factor retires the old one, so it satisfies no future step-up. It does not touch `mfa_session_attestations` already issued against it, so a session that logged in with the retired authenticator stays attested until its own expiry. Where the replacement was satisfied by the *current* factor this is clearly right — the user holds the device and is standing at the keyboard. Where it was satisfied by a **recovery code** it is a genuine question: the user did not have their authenticator, which is consistent with having lost it and also with someone else holding it. Invalidating those attestations closes that case and signs out a user who was merely travelling without their phone; leaving them means a stolen device's session survives the replacement meant to shut it out. My proposal is to invalidate on the recovery-code path only, and to say so on the page before the user commits. Not implemented either way pending your call — no current behaviour depends on the answer.

---

## Appendix — evidence commands

Reproduce any claim in Parts A/B:

```bash
# Control count discrepancies
grep -rnoE "\b(4[0-9]|5[0-9])\s*controls" --include="*.ts" --include="*.tsx" --include="*.md" . | grep -v node_modules | grep -v "^./.kilo"

# Service-role pages with no tenant filter
for f in $(grep -rl createSupabaseAdmin apps/web/src); do echo "$(grep -c 'tenant_id\|tenantId' "$f")  $f"; done | sort -n

# Absent capabilities
grep -rniE "reconcil|maker.check|RBI|SEBI|IRDAI|standing.approval|TPRM|sectoral" --include="*.ts" --include="*.py" apps packages services | grep -v node_modules | wc -l

# Test baseline
pnpm test && (cd services/agent-runtime && uv run pytest -q)
```
