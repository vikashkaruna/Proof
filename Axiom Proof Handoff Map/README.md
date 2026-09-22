# Axiom Proof — Handoff Map

The bridge document between the design prototypes and the real build. Read this
when changing screens in `../apps/web/` or `../apps/marketing/` and cross-check
the prototype references in this folder before wiring real data.

**Implementation review — 20 September 2026:** This folder describes target
designs, not verified completion. For completed source changes, unfinished W1
analyst work and pending implementation, start with
[the implementation handoff](../docs/12_Implementation_Handoff.md),
[roadmap traceability](../docs/13_Roadmap_Traceability.md), and
[the independent review](../docs/audits/04-roadmap-review-2026-09-20.md).
The current plan is [Doc 11](../docs/11_Phase0-5_Gap_Closure_Plan.md).
Current implementation progress is in [Doc 14](../docs/14_Implementation_Progress.md), with [review 36](../docs/audits/36-opaque-assessment-scheduling-review-2026-09-22.md) and the [saved handoff](../docs/15_Session_Handoff.md) recording the latest checkpoint. W0/W1/W2/W3/W4 remain partial; this diagram is a target map, not release evidence.

Route aliases in the prototype require reconciliation: `/remediation` maps to
`/plans`, `/dsar` to `/dsars`, and `/breach` to `/breaches`. MFA now adds
`/settings/security` and `/verify`; `/estate` manages inventory and `/estate/onboarding` reviews staff proposals; `/connectors` now manages real registrations (W4.1), without granting connectivity or execution; `/estate/graph` remains planned. See the
traceability document before introducing new routes or data entities.

## What's here

- `Axiom Proof Handoff Map.dc.html` — open in a browser (self-contained with `support.js`). Contains:
  - **Route map** — all 21 app routes, each screen's owning agent, its build phase, and the data entities it reads/writes.
  - **Core data model** — every entity (Tenant, Engagement, Control, Finding, Plan, Action, DryRun, Approval, ApprovalToken, Execution, Evidence, LedgerEntry, DsarRequest, ConsentRecord, Incident, Connector) with its field shape and which store owns it.
  - **Execution safety chain** — Finding → Plan → Action → DryRun → Approval(+token) → Execution(pre/post state) → Verification → Evidence(closure), all sharing one `correlation_id`.
  - **Cross-screen wiring** — how the prototype's flows connect (dashboard → approval console, assessment run pipeline, ledger drill-down, tenant switcher, kill switch, etc.).
  - **Target stack** — the real technology each layer maps to.
  - **The six non-negotiable safety rules**, restated from Doc 04, that must be enforced architecturally in the real build.

## Why this exists separately

The prototype is UI-only with mock data. This map turns "a screen that looks
right" into "a screen wired to the right route, agent, and entities". The real
web/marketing apps and backend now exist alongside these references, so update
the route map when a production surface changes to prevent drift from
[`../docs/04_Solution_Architecture.md`](../docs/04_Solution_Architecture.md).

Revision 36 implements per-service Cloud Run IAM and tests its secret allowlists offline. Deployed IAM denial checks and per-agent runtime isolation remain pending; see Doc 16 and review 25.

Revision 37 adds the private W4.3 task delegation component (0041); it is not wired into runtime/tool routes yet. Service IAM engineering passed exact staging CI 35678105419. Next: isolated workers, task handoff and every-tool scope/data enforcement, then W4.4, full W3 wizard/graph and W4.5/6/7.

Revision 38 requires a validated runtime result and confirmed run persistence before reporting success. Unconfirmed completion returns a run ID for reconciliation; worker/task integration and connector execution remain pending.

Revision 39 removes UI default-success and timer-driven assessment improvements. Assessment source-data fallbacks remain a separate C-W0-7 gap; current scores/cards are not end-to-end readiness evidence. See review 28 before continuing worker and W3/W4 integration.

Revision 40 verifies Revision 39 CI and replaces the browser bridge demo mapping with user-scoped dynamic tenant routing. Real custom-tenant read/write and revocation acceptance is covered. Assessment provenance and full W3/W4 remain pending; see review 29 and the session handoff.

Revision 41 replaces Assessment demonstration posture with a BFF projection of one owned assessment/library and real evidence references. Missing/error states are explicit and zero values preserved. Full worker persistence, requested-library execution, W3 wizard/graph and W4 grants remain open; see review 30.

Revision 42 delivers a real local isolated Parikshan worker and task-authorized, transactional library/findings tools (0042). Normal UI dispatch, production orchestration/finalization/reconciliation, trust lifecycle and the other worker paths remain open; this is not full W4.3 or connector activation. See review 31 and Doc 16 for acceptance and recovery.

Revision 43 confirms already committed assessment runs from actual ledger receipts and recovers lost worker responses without duplicate completion. Production dispatch/launch/automated recovery and the remaining W3/W4 scope stay open. Revision 42 passed exact CI 35687544717; see review 32 and Doc 16 for the successor acceptance gate.

Revision 46 connects bounded private worker launch to independent controller reconciliation. Real Linux process tests cover detached descendants, timeout, parent death and launch refusal; existing claims are never relaunched. Production scheduling/private transport, per-job isolation and key/trust setup remain pending alongside other workers, W4.4 grants and the full W3 wizard/graph. See review 35 and Doc 16.

Revision 47 adds a separate opaque Temporal workflow with stable scheduling and confirmation-only recovery, tested through the private local socket and real isolated worker/Postgres path. Durable outbox pickup, separate-service cloud transport, deployed identity/namespace/key lifecycle and remaining workers remain open before W4.4/full W3 integration. The local Unix transport does not change cloud IAM separation.
