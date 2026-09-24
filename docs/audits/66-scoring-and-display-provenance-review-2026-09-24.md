# Revision 77 — C-W0-7 scoring semantics and display provenance

## Scope

C-W0-7 was recorded in audits 19 and 30 with four open parts:

1. Public gap-scan questions q7, q11 and q12 did not ask what their scored controls require.
2. Readiness benchmarks and percentiles were hard-coded heuristics presented as peer data.
3. The client portal substituted demo figures.
4. The Workbench displayed static health labels.

The Assessment page's own display defect was already closed in Revision 41. This revision closes the remaining four parts in code. Operator input was not available; the choices below follow the recommendation recorded in audit 65.

## Findings and changes

### 1. Question/control semantics

- **q7** asked about MFA. The form said it mapped to `DPDPA-SEC-001`, while scoring actually used `DPDPA-SEC-002` (least-privilege access).
- **q11** asked "Do you transfer any personal data outside India?", so answering _yes_ scored full compliance with the cross-border restriction control.
- **q12** asked about a DPIA "in the past 12 months"; the control requires a DPIA _before_ new high-risk processing.

**Fix.** A single versioned question set `GAP_SCAN_QUESTIONS` (`GAP_SCAN_QUESTION_SET_VERSION = '2026-09-24'`) in `@axiom/control-library` is now used by both the marketing form and BFF scoring, so the prompt and the scored control cannot drift apart. Every prompt is phrased so that "yes" means the control objective is met:

- q7 asks about least-privilege access with periodic review;
- q11 asks whether all transfers (if any) are mapped and limited to countries that are not restricted;
- q12 asks whether a DPIA is completed before new high-risk processing.

The q7 and q12 wording matches the controls' own assessment questions. Scoring now throws on an unknown control instead of silently skipping it. Each new report records `questionSetVersion`. Stored snapshots are never rescored, and older snapshots without the field still parse.

### 2. Benchmark provenance

`computeQuarterlyReadinessIndex` still uses editorial sector estimates, but every index now carries `benchmarkBasis: 'editorial_estimate'`. The report page, email and CTAs present these figures as "Indicative" and state that they are Axiom editorial estimates, not measured data from peer organisations. "Peer Standing" and "Peer Percentile" labels are removed. The schema field is optional, so earlier snapshots (all heuristic) still parse.

### 3. Client portal

The portal previously:

- fell back to a hard-coded "Demo Client (Acme Fintech Pvt Ltd)" tenant;
- aliased the `meridian` and `demo-client` slugs;
- invented posture scores, exposure and passing-control counts per tenant slug;
- defaulted to 43 controls, and 74/32/184000000 in the client;
- showed an invented "▲ +6 vs baseline" delta;
- claimed "WORM lock active", "0 Active Breaches" and "tabletop readiness validated" regardless of data;
- hard-coded "1 nearing SLA";
- read `remediation_actions` without a tenant filter.

The portal now:

- uses the verified tenant from `requireTenantContext(requestedSlug)`;
- reads assessment figures from the same BFF saved-results projection as the Assessment page, via a new shared `loadAssessmentSnapshot`;
- reads `posture_score` only from the persisted engagement;
- shows "—", "Not yet assessed", "Not recorded" or an explicit unavailable state when data is missing;
- counts DSARs nearing their due date and open breaches from real rows;
- scopes actions to the tenant's listed plans;
- shows an alert when any query fails, instead of silently rendering empty or substituted data.

### 4. Workbench

The Workbench loader selected ledger columns that do not exist (`seq`, `actor`, `action`, `timestamp`) and filtered plans by the non-existent `plan_status` value `awaiting_approval`. Both queries therefore always failed, and the page always showed its invented fallbacks: 214 runs today and 8 awaiting review. The card also hard-coded:

- "10 / 10 Online";
- "Env: Production";
- prompt registry "v25.11.2" with "64" prompts;
- "0 untracked" prompt drift;
- a control library "v25.11.2" in an agent description.

The loader now uses the real columns (`sequence_no`, `actor_id`, `action_type`, `occurred_at`) and valid statuses, and exact counts are shown or reported as "Unavailable". The fleet card says health is not monitored here. The prompt registry card says the registry is not implemented. The environment comes from configuration.

## Verification (isolated Docker parity stack in this session)

| Check                                                   | Result                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control library tests                                   | 83 (including 2 new question-set cases)                                                                                                                                                                                                       |
| BFF tests                                               | **1,022** (6 new scoring/provenance cases)                                                                                                                                                                                                    |
| Workspace typecheck, lint, test                         | pass                                                                                                                                                                                                                                          |
| Playwright on the real Supabase/BFF/web/marketing stack | **68/68**; the new `portal-provenance` journey covers an empty tenant, then seeded persisted results, asserting no invented figures. Workbench assertions now require real counts, and failed on the invalid-status query until it was fixed. |

**Test robustness correction.** The existing `recovery replacement` MFA journey failed 1 in 3 local repeats. The cause was the 5-second URL wait after `/verify` under `next dev` cold compilation; the page showed the submitted code and no error. The spec already uses 20-second waits elsewhere for the same reason. Applying one here passed 4/4 repeats and the full suite. No MFA behaviour changed.

## Limits

- The benchmarks remain editorial estimates, now labelled as such. Measured peer benchmarking needs real, consented aggregate data, which does not exist yet.
- Portal pass/partial/fail bands are presentation bands from saved findings, not legal determinations.
- Real agent-fleet health and a prompt/model registry remain unimplemented (W4/W6); the Workbench now says so instead of implying them.
