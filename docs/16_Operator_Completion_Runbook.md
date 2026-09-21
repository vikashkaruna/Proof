# Axiom Proof — Operator completion runbook: W0 → W3

Acceptance fixture correction: the three analyst journeys now provision separate enrolled accounts. Shared TOTP counters caused parallel tests to spend each other’s codes; replay protection and retry limits are unchanged. The exact merge CI remains the completion gate.

### Axiom Minds Private Limited · https://axiomminds.ai

**Document:** 16 · Companion to the [workstream status register](11_Phase0-5_Gap_Closure_Plan.md#workstream-status-register--as-at-revision-22-21-sep-2026) · **As at** Revision 30, 22 Sep 2026

The register says what is delivered. This says **who does what next**, for W0
through W3 only, and — the part that is usually missing — **exactly what
evidence flips a status**, so that "done" is something you can hand over rather
than something either of us asserts.

## How to read this

Every item names one owner:

- **OPERATOR** — you. Anything that provisions, bills, deploys, or is
  irreversible. Anything needing a credential I must never see. Anything that
  is a business or posture decision rather than an engineering one.
- **ENGINEERING** — the implementing model/team. Code, migrations, tests, gates, docs.

Each operator step ends with **Evidence to return**. Each workstream ends with
**How I mark it Closed** — the checks I run against your evidence before I
change a status. I do not flip a status on a report alone; where a claim is
checkable from the repository or from a URL you give me, I check it.

---

## 0. The standing constraint, restated so it is not a surprise

I do not create, modify or bill any cloud resource. `terraform validate` and
read-only checks are my ceiling. No `terraform apply`, no Supabase project
creation, no Secret Manager writes, no Cloud Run deploy.

Two of these are not caution, they are one-way doors:

- **The first real deploy is reserved to you.** That was your instruction and I
  have kept to it.
- **Evidence-bucket Object Lock is COMPLIANCE mode.** Once set, nobody —
  including the project owner, including Google — can shorten or delete it. A
  test bucket locked for the statutory 2555 days is gone for seven years. Do
  not set retention on a bucket you are experimenting with. W8 depends on this
  and it is deliberately the last thing anyone should turn on.

**Never send me:** a service-role key, a JWT secret, an `APPROVAL_SIGNING_KEY`,
the contents of any `.env*`, or `.axiom-runtime/personas/state.json`. Everything
below is written so you never have to. Where I need to know a secret _exists_, I
ask for the Secret Manager resource name or a SHA-256 of the value, never the
value.

---

# W0 · Security remediation & environment parity

**Current status: Partial** — deployed-target harness delivered and locally rehearsed; higher-environment deployment acceptance remains open.

## What is already done, so you do not redo it

W0.0 and W0.2 are closed and held by a CI gate on every push. Re-verified at
this head:

| Exit criterion                                     | State                                                                                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Zero environment-conditional security branches     | **Met.** The only two matches are a marketing URL resolver the plan explicitly classes as topology, and a comment recording the removed defect |
| `axiom_e2e_bypass` has no effect anywhere          | **Met.** No reader exists in any package                                                                                                       |
| Service-role client banned from `apps/web` (SEC-3) | **Met.** Zero calls across 22 files; the baseline file is empty and now acts as a ratchet                                                      |
| SEC-4/5/6/10/11/12/13 closed with regression tests | **Met**                                                                                                                                        |
| Mock Supabase substitution removed                 | **Met.** Reachable only under `e2e-bypass`, which is refused at boot outside `local`/`test`                                                    |
| Idempotency auto-key generation removed (FR-8.3)   | **Met.** No environment relaxes it, including `e2e-bypass`                                                                                     |

**W0 is not wholly operator-owned.** Provisioning is reserved to the operator. The deployed parity and persona-seeding harness are delivered in Revision 28; their final verification still needs isolated higher-environment targets. Local Docker evidence is not remote acceptance.

## OPERATOR steps, in order

The detail for each lives in
[Doc 08](08_DEPLOYMENT_GUIDE.md), the
[GCP preprod guide](GCP_PREPROD_DEPLOYMENT_GUIDE.md) and the
[env config checklist](GCP_PREPROD_ENV_CONFIG_CHECKLIST.md). This is the
ordered spine and the evidence, not a replacement for those.

### W0-1 · Decide and record the target

Project, region, billing account, and the intended placement of the self-hosted Supabase services. The accepted direction is local Docker Supabase and dynamically deployed self-hosted Supabase in higher environments; Cloud SQL may provide PostgreSQL underneath that stack. Do not substitute a managed Supabase project or reopen this accepted choice.

**Evidence to return:** project id, region, and which topology. No credentials.

### W0-2 · Scaffold and mint configuration

```bash
./scripts/sync-env.sh scaffold
```

Appends only missing keys to `.env.preprod`; values you already set are kept.

```bash
./scripts/sync-env.sh mint
```

This one matters more than it looks. It generates the Supabase JWT secret and
the anon/service keys **from one minting**. Those two keys are JWTs signed with
that secret, so mixing values from separate runs leaves GoTrue issuing tokens
PostgREST rejects — a failure that presents as "login works, every API call
401s" and wastes an afternoon.

**Evidence to return:** `./scripts/sync-env.sh verify` output. It reports
presence and shape, not values.

### W0-3 · Pre-flight

```bash
./scripts/deploy-preprod-gcp.sh --dry-run
```

Review the script before using this flag: the default phase selection also includes preparation/verification. It is not a blanket guarantee that no GCP API enablement or other setup runs. Use an already-initialized Terraform configuration with `terraform plan` for a plan-only review. Read the plan before the next step —
this is the last point at which nothing has been created.

**Evidence to return:** the plan summary line (`Plan: N to add, …`) and any
resource in it you did not expect.

### W0-4 · Provision base and database

```bash
./scripts/deploy-preprod-gcp.sh --phase base
./scripts/deploy-preprod-gcp.sh --phase db
```

Phase 2 is VPC, subnet, peering, connector, GCS vault, Artifact Registry, IAM.
Phase 3 is Cloud SQL and Secret Manager. **Billing starts here.**

**Evidence to return:** the Cloud SQL instance name and the Secret Manager
_resource names_ created. Never the secret values.

### W0-5 · Run the migration series against the real database

```bash
./scripts/deploy-preprod-gcp.sh --phase migrate
```

or directly, if you are driving it yourself:

```bash
./scripts/migrate-cloudsql.sh <DATABASE_URL>
```

The runner enforces TLS, records checksums, refuses edited history, and exits
non-zero on a failing migration. Expect **39 migrations, 0000 → 0038**.

**Evidence to return:** the runner's final summary — the count applied, and the
last migration name. If it refuses on a checksum, send that line verbatim and
stop; a checksum refusal means applied history differs from the repository and
is not something to force past.

### W0-6 · Seed representative identities

```bash
./scripts/deploy-preprod-gcp.sh --phase migrate --seed-identities
```

W0.1 asks for _representative_ data, not fixtures: multiple tenants and users
across every persona, so RLS and RBAC are genuinely exercised rather than
asserted. **Never client production data.**

**Evidence to return:** tenant count, and the persona roles seeded. No emails,
no passwords.

### W0-7 · Deploy services and verify

```bash
./scripts/deploy-preprod-gcp.sh --phase services
./scripts/deploy-preprod-gcp.sh --phase verify
```

**Evidence to return:** the health matrix from `--phase verify`, and the public
URL of the web app and the BFF.

### W0-8 · Prove strictness against the deployed environment

This is the step that actually closes W0.1, and the one most likely to be
skipped because the previous step printed green.

Use the [deployed acceptance guide](17_Deployed_Acceptance.md) and its private target JSON. `PLAYWRIGHT_BASE_URL` alone is refused: it cannot safely select the correct Auth stack, persona credentials or marketing origin.

Run the same API/browser suites against isolated preprod and production-configured acceptance deployments at one exact revision. `run-deployed-acceptance.sh` checks BFF/SSR identity, seeds synthetic multi-tenant personas, enrols MFA through the BFF and drives the browser journeys. External contact-form email must be disabled. The manual CI workflow compares both environments and fails on behavioral divergence.

**Evidence to return:** the exact revision, CI run URL and sanitized `api-results.json`/`browser-results.json` for each target. Do not share persona state, target JSON, private logs or browser reports. A local Docker rehearsal does not close this step. The workflow needs promotion to the default branch before GitHub manual dispatch is available.

### W0-9 · The prod EKS decision

`infra/terraform/envs/prod` carries
`cluster_endpoint_public_access_cidrs = ["0.0.0.0/0"]` with a "restrict via WAF
/ OIDC in production" comment above it that has never been actioned. The
Terraform gate validates that this configuration _loads_; it has never claimed
the value is one you want. Prod validating is what made this exposure visible
rather than hidden behind a configuration that could not load.

This is your decision, not a defect I can fix by guessing a CIDR.

**Evidence to return:** the CIDR list you want, or a decision to defer with a
date. I make the change and the gate re-validates.

## ENGINEERING steps for W0

| #      | Work                                        | Current status                                                                                                                                                                          |
| ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-W0-1 | Deployed API parity lane and comparison     | Delivered: real HTTP targets, exact identity/revision checks, separate automatic Docker and manual remote CI lanes. Remote acceptance still pending.                                    |
| C-W0-2 | Target-aware browser and persona harness    | Delivered: deployment-bound private state, real MFA enrollment, scoped SSR credentials and sanitized reports. Same browser suite; local Docker rehearsal is distinct from remote proof. |
| C-W0-3 | Apply the EKS CIDR decision and re-validate | Awaits W0-9 operator policy.                                                                                                                                                            |

### Additional engineering findings from Revision 28

- **C-W0-4 delivered in Revision 30:** BFF-owned durable gap-scan snapshots, opaque hashed ownership for reads/resends, no memory fallback, explicit email delivery configuration. Migration 0037 preserves legacy cookies/snapshots. Browser and real process-restart acceptance cover persistence and foreign denial; exact committed evidence is in the session checkpoint.
- **C-W0-5:** isolate Cloud Run service identities and secret permissions. Environment injection now separates scoped SSR keys from BFF keys, but the existing shared Cloud Run service account still needs least-privilege IAM review.

The managed Supabase credentials now reach the correct Cloud Run processes; `check-cloudrun-auth-wiring.py` refuses placeholder/missing/cross-role bindings. No infrastructure was applied. Remote acceptance remains pending. C-W0-5 and the following findings remain engineering responsibilities:

- **C-W0-6:** contact inquiries still use process memory and SSR-owned mail; disabled delivery can claim success. Move this separate workflow behind BFF and test durable persistence/accurate dispatch outcomes.
- **C-W0-7:** reconcile q7/q11/q12 question/control scoring semantics and benchmark provenance. The current readiness benchmarks/percentiles are heuristics, not measured peer evidence. Stored historic reports remain immutable snapshots.

For report rollout, apply 0037 and deploy BFF/marketing together; seed the published control library through the normal seed workflow. Keep `AXIOM_REPORT_EMAIL_MODE=disabled` during acceptance. Production mail requires an explicit BFF mode of `delivery` and its managed `RESEND_API_KEY`; marketing does not own the report mail credential. Contact mail still has a separate legacy credential path until C-W0-6. Real provider delivery was not exercised. Follow Doc 17 for the restart probe; emailed links do not carry bearer proof and work only in the owning browser. There is no cross-device recovery/share flow yet.

## How I mark W0 Closed

I flip **W0 → Closed** when the remaining C-W0-5/6/7 findings are resolved with tests and all of these hold, and not before:

1. Your W0-5 evidence shows **39 migrations applied** against a real deployed
   database, with the runner's own checksum summary.
2. Your W0-8 curl shows **401** from the deployed BFF for an unauthenticated
   request.
3. The deployed parity lane (C-W0-1) exists, is in CI, and is **green on a
   commit I can name**, comparing both remote API and browser suites — not green once by hand or only against local containers.
4. `pnpm gate:security` and the W0.0 CI job are still green on that same
   commit, so nothing regressed while the environment was being built.

If 1 and 2 hold but 3 does not, I move W0 to **Partial — deployment proven,
parity lane outstanding** and say so plainly. I will not call W0 Closed on a
successful deploy alone: a deploy proves the thing runs, and W0 is about it
running under identical rules everywhere, which only the divergence lane tests.

---

# W1 · Tenancy, RBAC, MFA, personas

**Current status: Partial.** The suite now has 61 browser journeys (including W3 inventory/proposal coverage) under `AXIOM_AUTH_MODE=strict`. C-W1-1 and C-W1-2 are delivered locally; deployment and invitation delivery remain open; C-W1-4 is implemented by 0036. Atomic recovery-code refresh is delivered by 0032 (review 13). Deploy that migration with the new BFF; the old activation RPC is intentionally no longer available to the service role.

## OPERATOR steps

### W1-1 · Deploy the accepted session-attestation posture

Accepted policy, recorded as
[Doc 11 E.2 item 3](11_Phase0-5_Gap_Closure_Plan.md#e2-still-open--not-blocking-needed-before-the-workstream-that-uses-it).

**Resolved by the user, 21 Sep 2026:** replacement authorized by a recovery code must invalidate MFA attestations issued against the retired authenticator, requiring those sessions to verify MFA again. Replacement authorized by the current authenticator preserves existing attestations. The GoTrue login itself need not end.

**C-W1-4 implemented in Revision 29 / 0036.** The consumed challenge records its verified method; pending replacements retain factor/challenge provenance. Recovery activation atomically ends all existing MFA attestations for that account, including assurance retained from earlier TOTP replacements. Current-factor replacement preserves assurance. The UI explains the effect before confirmation. SQL rollback/concurrency and two-session browser coverage accompany this change; exact merge CI is in the checkpoint. Do not ask for this policy decision again.

Apply through 0036 and deploy BFF/web together. Existing active credentials are unchanged during upgrade. Pending replacements without recorded provenance return `replacement_authorization_changed` (409): restart enrollment and prove the current factor again. Do not populate method fields by guessing how a historic challenge was verified. Verify that both existing sessions lose protected access on recovery activation, then regain it independently after fresh MFA. No password-session logout is required.

### W1-2 · Provide an email provider for invitations

The invitation/email flow is listed under W0 acceptance and is genuinely W1
work. It cannot be built against nothing: it needs a transactional email
provider, a sending domain, and SPF/DKIM on that domain.

Note that **email OTP remains deferred by accepted scope** — this is invitations
only, not a second authentication factor. Do not let a provider's "magic link"
feature quietly become an auth path.

**Evidence to return:** provider name, sending domain, and confirmation that
SPF/DKIM verify. Put the API key in Secret Manager and send me the resource
name, never the key.

### W1-3 · Enrol a real second factor on the deployed environment

Once W0-7 lands, enrol MFA as a real user on preprod: a real authenticator app,
a real TOTP code, and then a replacement using a recovery code. This exercises
the key ring against a deployed instance — a mis-set `AXIOM_MFA_ENCRYPTION_KEY`
presents as `secret_unreadable` (503), which is a deliberately distinct signal
and not a user error.

**Evidence to return:** whether enrolment, approval step-up, and replacement
each succeeded, and the exact error code if any did not.

## ENGINEERING steps for W1

| #      | What                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-W1-1 | **Delivered, Rev 23.** Purpose-bound revocation UI, atomic credential/session retirement (0031), negative/API/browser/SQL/concurrency tests                   |
| C-W1-2 | **Delivered, Rev 23.** Quarantined founder enrollment, recovery-code save and explicit verification continuation; API remains denied until login MFA succeeds |
| C-W1-3 | Invitation flow. Provider/domain evidence gates real delivery, not implementation of the internal workflow and adapter contract                               |
| C-W1-4 | **Delivered, Rev 29.** Atomic recovery session policy (0036), provenance guards, UI notice, SQL fault/race tests and two-session browser journey              |

## How I mark W1 Closed

1. C-W1-1 … C-W1-4 delivered, each mutation-tested.
2. Browser journeys cover revocation and quarantined enrolment, and I have
   confirmed they fail when the fix is reverted.
3. Your W1-3 evidence shows enrolment, step-up and replacement working against
   a **deployed** environment — the local parity stack has never been proof of
   the deployed key ring.
4. The W1 exit criterion still holds: a `viewer` in tenant A cannot see tenant
   B, cannot reach an approve button, and cannot call the approve endpoint,
   proven by test rather than inspection.

---

# W2 · Data model completion

**Current status: Partial.** This one is almost entirely mine, and I want to be
precise about the size so it is not mistaken for a small gap.

**21 of the 40 named target tables do not exist.** Delivered: estate (4), regulatory baseline (6), auth (2), and connector foundation (7, via 0033): 19 delivered. Absent: 5 execution-detail, 4 monitoring/policy, 4 multi-regulator, 4 Phase 1/2 parity and 4 rights/consent tables. The seven connector tables are metadata; W4 runtime and live authorization remain pending.

## OPERATOR steps

### W2-1 · Legacy assignment policy

0029 deliberately left existing engagements **unassigned** rather than inventing
an estate for them. Backfilling a guess would put fabricated scope into a
compliance record, which is worse than a null.

Decide: assign existing engagements to an estate by hand, or leave them
unassigned until someone reviews each one?

**Evidence to return:** the policy. If "assign by hand", I build the UI for a
human to do it; I will not write an inference.

### W2-2 · Re-run migrations after each batch I land

Each new migration batch needs applying to your deployed environment. Same
command as W0-5. The runner refuses edited history, so the order is: I commit,
you apply, never the reverse.

**Evidence to return:** the applied count and last migration name, per batch.

## ENGINEERING steps for W2

Connector schema batch **delivered in Revision 25**, with composite FKs, RLS without BYPASSRLS, private credential envelopes, constrained agent grants, SQL and real-Auth tests, and a populated upgrade test. Remaining 21 tables follow their dependent workstreams; execution normalization must wait for the W4 grant model/runtime, avoiding a second source of truth alongside existing execution fields. W3 inventory management and initial proposal review are delivered through 0035; the dependent wizard remains open. Every subsequent batch keeps the same security and upgrade evidence contract.

### Applying the connector schema batch (0033)

Apply the migration runner as W0-5 describes. It creates seven empty tables; it does not infer connectors, import credentials or grant agents access. Return the migration summary through 0033. Do not insert real credentials or mark a connector production to make a demo look live: the W4 broker and transports are not implemented. Descriptor manifests/tool descriptions must contain only non-secret metadata; encrypted envelopes are broker-private and never browser-readable.

## How I mark W2 Closed

1. All 40 named tables exist, verified **against a migrated database**, not by
   grep — a pattern search already gave me a false negative on
   `regulatory_instruments` once.
2. Every new table has RLS proven positively and negatively with
   `service_role nobypassrls`, in the disposable-container suite.
3. A populated upgrade test proves no existing row is altered or invented.
4. Your W2-2 evidence shows the same count applied on the deployed database.

---

# W3 · Client estate & onboarding

**Current status: Partial.** Migration 0034 delivers C-W3-1 and C-W3-2: audited, idempotent estate/system lifecycle APIs and `/estate`, with explicit assignment of unstarted legacy intakes. 0035 delivers C-W3-3 and proposal browser coverage under C-W3-4. The full connector/grant/readiness wizard and sustenance remain pending.

## OPERATOR steps

### W3-1 · Estate taxonomy

What is an "estate" for your actual clients — a legal entity, a business unit,
an environment (prod/staging), or a geography? The schema does not care; the UI,
the defaults and every report do. Getting this wrong is expensive to undo once
clients have data in it.

**Evidence to return:** the definition, and two or three real examples from a
client you have.

### W3-2 · System kinds

0029 ships `database`, `application`, `storage`, `identity`, `saas`, `other`.
Tell me if your real engagements need kinds that list does not cover.

**Evidence to return:** any missing kinds, or confirmation the list is enough.

### W3-3 · Onboarding proposal review

**Decision recorded from the user:** client `owner` **and tenant `admin`** may approve proposals prepared by Axiom staff. `axiom_analyst` prepares; it must not acquire direct estate mutation authority. No further role confirmation is needed for this implementation. The normalization/review workflow is delivered in 0035 and `/estate/onboarding`.

### W3-4 · Verify the inventory milestone

Apply through 0034 and deploy its BFF/web together. With an owner/admin seat, open `/estate`, create an estate with an explicit slug, add a system and declared category keys, edit it, and archive/restore it. Check that each successful mutation has one ledger event. A viewer/analyst can read but cannot manage. Do not put credentials or raw personal data into inventory descriptions/references.

To assign a legacy assessment, choose its intended estate and confirm the scope. The server accepts only an unassigned intake with no recorded findings, plans, runs, evidence or reports. Started history stays unassigned until a separate reviewed migration policy exists. Do not bypass the guard with direct SQL.

If a response is lost, keep the form open and use **Retry same request**. It retains the same body/path/key. For a persisted unknown or expired claim, inspect the request claim and ledger before reconciliation; do not generate a fresh key to force a duplicate. Archival preserves history and refuses active connectors. Future W4 activation must also serialize with estate/system lifecycle checks.

### W3-5 · Review an onboarding proposal

Apply through 0035 and deploy its BFF/web together. An assigned analyst opens `/estate/onboarding`, chooses an active estate, reviews every original intake entry, and submits its normalized name, kind, description and category keys. Submitting creates a pending proposal, not live systems. It remains available after navigation or a new session; unsent form drafts do not autosave.

A different client owner or **admin** opens the proposal, compares original and proposed fields, chooses approve/reject and records a reason. Approval adds all systems atomically and records source-index links. Rejection preserves the proposal and allows staff to submit a revision. If the estate changed since preparation, reject/reprepare rather than bypassing the content guard. An approved initial intake cannot be imported again. This is inventory review, not authority to connect to or mutate client systems.

The initial intake is a single complete batch. Per-item exclusion and later onboarding batches are future work. Region and personal-data declarations remain visible in the original snapshot, without asserting they were discovered or verified. For a client with no submitted systems, owners/admins can declare inventory directly in `/estate`.

## ENGINEERING steps for W3

| #      | What                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| C-W3-1 | Estate management API — create, update, archive — capability-gated, audited, idempotent, tenant-consistent |
| C-W3-2 | Estate management UI, plus explicit human assignment of legacy engagements per W2-1                        |
| C-W3-3 | Onboarding proposal normalization with the W3-3 review role                                                |
| C-W3-4 | Browser journeys for inventory and proposal review — delivered under strict auth                           |
| C-W3-5 | Complete resumable company → estate → inventory → connector/grant → readiness wizard — pending             |
| C-W3-6 | Re-onboarding/sustenance and access re-attestation — pending with W4/W6 dependencies                       |

## How I mark W3 Closed

1. C-W3-1 … C-W3-6 delivered and mutation-tested. C-W3-1 through C-W3-4 alone close the inventory/proposal milestone, not the full W3 roadmap.
2. Every mutation requires a capability, appends to the ledger, and is
   idempotent — proven by test, including a cross-tenant refusal.
3. No estate or scope is ever inferred. A legacy engagement becomes assigned
   only through a recorded human action.
4. Browser journeys cover a full estate lifecycle under strict auth.

---

# W4 · Connector registry and execution

## W4-1 · Register and manage a connector (engineering delivered by 0038)

Apply through **0038**, then deploy BFF/web together. Open `/connectors` as a tenant owner/admin (or assigned founder). Choose an active estate system and a reviewed descriptor; enter a name and a non-secret endpoint identifier such as `primary_crm`. Do not paste connection URLs, tokens or passwords. The registration starts in draft and is durably audited. Catalogue entries are published immutably on first registration; a conflicting published version is refused rather than overwritten.

“Enable registration” changes lifecycle only. It does not obtain credentials, probe a system, grant access or run discovery. A descriptor's assurance value is its authentication policy, not verified connectivity. Health shows a dated recorded check or “Not checked.” Reference/sandbox bindings remain explicitly non-production and cannot declare writes.

Disable before editing an enabled registration or archiving its estate/system. Disable revokes all existing grants; re-enable does not restore them. Archive additionally revokes stored credential envelopes and is terminal. A legacy descriptor missing from the reviewed catalogue may still be disabled/archived, but enabling it requires a reviewed new registration. If a form reports an unknown outcome, keep it open and use “Retry same request”; do not invent a second intent.

**Evidence:** sanitized registration/lifecycle audit IDs, exact commit and green container/CI results. Do not supply target credentials at this stage. Both archive/enable race orderings and populated migration upgrade are tested locally. No client target was contacted.

## Remaining W4 / W3 dependency gates

W4.2 vault/rotation and OAuth client-credentials/JWT-bearer broker → W4.3 workload identity → W4.4 live grants must be enforced before execution or graph access edges can be called live. Then complete the resumable onboarding wizard/readiness and graph; proceed to W4.5 internal tool registry, W4.6 first real SQL binding and W4.7 REST/GraphQL. Existing tables and registration status do not satisfy these gates. Phase 2's three-live-connector-type exit remains separate from a first SQL binding.

---

# Sending evidence back

One markdown block or a file, per batch of steps. For each step: the step id
(`W0-5`), what you ran, and the output — trimmed to the summary lines, not the
whole log.

**Redact before sending.** Never include:

- any service-role key, `SUPABASE_SERVICE_KEY`, JWT secret, or
  `APPROVAL_SIGNING_KEY`
- the contents of any `.env*`
- `.axiom-runtime/personas/state.json` — it holds working test credentials
- client data of any kind

Secret Manager **resource names** are fine and are what I actually need. If I
ever need to confirm a value matches across two places, I will ask you for a
SHA-256 of it, never the value.

If a step fails, send the failure rather than working around it. A checksum
refusal from the migration runner, or a `401` that is a `302`, is more useful
to me than a green run that took a detour.

# What changes when evidence arrives

| Workstream | Now                           | Flips to                       | On                                                                                                           |
| ---------- | ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **W0**     | Partial (harness delivered)   | **Closed**                     | 36 migrations on a deployed DB + `401` from the deployed BFF + the parity lane green in CI on a named commit |
| **W0**     | —                             | **Partial, deployment proven** | The first two above, if the parity lane is still outstanding                                                 |
| **W1**     | Partial                       | **Closed**                     | C-W1-1…4 delivered + deployed MFA evidence (W1-3) + the E.2.3 decision implemented                           |
| **W2**     | Partial                       | **Closed**                     | 34/34 tables verified against a migrated database + RLS and upgrade tests + your applied-count evidence      |
| **W3**     | Inventory/proposals delivered | **Partial**                    | Verified APIs/UI, atomic audit, idempotency and client owner/admin review                                    |
| **W3**     | —                             | **Closed**                     | Full wizard and sustenance, browser journeys, reviewed proposals and recorded human legacy assignment        |

I update [Doc 11's register](11_Phase0-5_Gap_Closure_Plan.md#workstream-status-register--as-at-revision-22-21-sep-2026),
[Doc 14](14_Implementation_Progress.md) with the evidence and what it does
_not_ prove, and [Doc 15](15_Session_Handoff.md) so the next session resumes
from the new baseline — the same chain every checkpoint uses.

**W4 onward:** continue in the existing plan order after available W1–W3 work; no new permission conversation is required for authorized engineering. The W2 connector schema batch precedes W5 execution details, and live execution still depends on W4.4 grants and controlled target validation.
