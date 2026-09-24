# Revision 82 — W4.4 connector grant issuance and per-invocation enforcement

## Scope and assumptions

W4.4 requires that live grants be enforced before any connector execution. Operator input was not received; the recommended options are recorded as assumptions:

1. **Who issues grants.** Grants are issued by tenant owners, admins or founders (connector managers) through an audited RPC. The accepted matrix is unchanged: Drishti may only read, Karya may only write, and every other agent (Sudhaar included) is refused. Write grants require a `production` binding; reference and sandbox connectors can never carry write authority. Grants last at most 90 days. A duplicate active grant is refused.
2. **What issuance does.** Issuing a grant obtains no credential and contacts no target.
3. **Per-invocation enforcement.** Every call goes through `GrantBrokerAuthority`, which implements the broker's existing `BrokerAuthority` contract:
   - it verifies the workload's JWT-SVID (the W4.3 `JwtSvidVerifier`);
   - it resolves a live grant with `resolve_broker_grant`, which re-reads every input in one snapshot: the grant, the workload registration, connector/system/estate lifecycle, the current credential envelope, the descriptor pin and the global/tenant kill switch;
   - `stillCurrent` repeats both steps, so revocation, expiry, disablement or the kill switch take effect between the broker's checkpoints.
4. **Writes.** A write also needs a verified signed action approval (`WriteApprovalVerifier`). No verifier is configured yet (W5), so writes are refused, which is fail-closed. Read requests carrying approval material are refused.
5. **Not exposed.** The broker is still not exposed on any HTTP route, and the production default authority remains deny-all until a deployment wires the SVID trust source. This revision delivers the enforcement component and its contract, not a live connector.

## Change

- **Migration 0056:** ledger action `connector.grant.issued`, plus the functions `issue_connector_grant` and `resolve_broker_grant`. Both are callable only by the backend.
- **`services/bff/src/connectors/broker/grant-authority.ts`:** `GrantBrokerAuthority`. Its lease deadline is the earliest of SVID expiry, grant expiry and approval expiry.
- **BFF:** `POST /v1/connector-grants` requires connector management and a strict body.
- **Web:** an "Issue agent access" form on `/estate/setup`. Issued grants then appear in the C-W3-6 review queue.
- The client `LedgerActionType` declares the new action.

## Verification

| Check                                                                                                                                                                                                                                                                                   | Result                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `connector-grant-issuance.test.sql` on a fresh apply with `service_role nobypassrls`. It covers role, matrix, write-needs-production, TTL, duplicates, audit, and resolution refused for a disabled workload, the kill switch, a revoked credential, a revoked grant or a wrong estate. | pass. A deliberately broken assertion fails, confirming the assertions execute. |
| `grant-authority.test.ts` (8 tests: identity refusal, identity mismatch, malformed row, read with approval, write without or with a mismatched approval, deadline minimum, re-resolution)                                                                                               | 8/8                                                                             |
| BFF issuance routes                                                                                                                                                                                                                                                                     | 2 new tests                                                                     |
| Playwright: issue through the page, refuse a duplicate and a Drishti write, then keep and revoke                                                                                                                                                                                        | runs in CI's persona job                                                        |

## Limits

- The SVID trust source and approval verifier are not wired to a deployment.
- No route exposes token acquisition.
- Workload registration remains W4.3 operator infrastructure.
- The live read/write connector bindings remain W4.6 and W4.7.
