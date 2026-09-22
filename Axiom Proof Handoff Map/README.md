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
Current implementation progress is in [Doc 14](../docs/14_Implementation_Progress.md), with [review 26](../docs/audits/26-workload-task-review-2026-09-22.md) and the [saved handoff](../docs/15_Session_Handoff.md) recording the latest checkpoint. W0/W1/W2/W3/W4 remain partial; this diagram is a target map, not release evidence.

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
