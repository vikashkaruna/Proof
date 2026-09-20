# MFA operator policy — implemented behavior

TOTP and single-use recovery codes are supported. Email OTP and SMS are deferred. Never transmit a user's TOTP secret, recovery codes, token or encrypted factor material into a ticket, chat, logs or this document.

| Control            | Current behavior                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff login        | Founder and axiom_analyst always require MFA, regardless of tenant settings                                                                                                             |
| Tenant login       | `tenants.mfa_required_roles` defaults to owner and approver; additional roles can be required through an authorized administrative change                                               |
| Quarantine         | No factor: 403 `mfa_enrolment_required`; enrolled but unattested session: 401 `mfa_verification_required`; MFA endpoints remain reachable                                               |
| Session            | Attestation bound to the real Auth session id; default 12 hours via `AXIOM_MFA_SESSION_TTL_HOURS`; a new session must authenticate again                                                |
| Approval           | Every approval needs its own fresh, single-use step-up; login attestation never substitutes for approval authentication                                                                 |
| Binding            | Tenant/user ownership, plan/action set, mode, plan version and server-read action-content digest; changing content requires another challenge                                           |
| Challenge lifetime | Approval 5 minutes; other purposes 10 minutes; per-challenge attempts plus shared budgets                                                                                               |
| Shared budgets     | Issue and verify independently: account 20/hour, session 10/hour, trusted address 200/hour; failures return 429 with Retry-After                                                        |
| Proxy trust        | `AXIOM_TRUSTED_PROXY_HOPS=0` disables address budgets by default. Enable only after proving every ingress path traverses the declared proxy chain; never trust arbitrary caller headers |
| Roles              | Approval capability and execution capability are separate. A valid approval token does not grant a viewer/analyst/approver permission to execute                                        |

First enrollment proves TOTP possession and returns recovery codes once. Replacing or revoking a live factor requires a bound challenge satisfied with the existing factor or a recovery code. Recovery codes are hashed at rest and cannot be retrieved; each works once. If all factors/recovery codes are lost, there is no shipped operator reset workflow: do not clear MFA rows or lower role policy as an improvised bypass. Design an audited recovery workflow with identity verification before offering resets.

Set the MFA encryption key through the documented deployment secret flow and keep it distinct from approval/service keys. Changing it without re-encrypting persisted factors will lock users out. Rotation/key-version support remains pending; retain protected backup and restore procedures and do not rotate by merely overwriting an environment value.

Tenant policy configuration is privileged; no public endpoint is shipped for arbitrary role-policy edits. Record the approving operator and reason through the approved administrative process. Policy read failure requires MFA. Expired attestations do not disable factors and do not authorize direct browser database writes.

Real API enrollment/login/recovery/approval and content/session isolation pass in the strict local parity suite. Browser usability/persona journeys, key rotation and deployed secret/ingress verification remain acceptance work. Approval issuance still needs a single database transaction to close concurrent read/write races; this document does not claim otherwise.
