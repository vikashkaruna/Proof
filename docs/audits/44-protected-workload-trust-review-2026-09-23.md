# Review 44 — protected Workload API signing bundles

Reviewed registration milestone and correction at staging `0081948`. Its initial CI failure exposed an acceptance fixture still using direct service writes; the correction exercises audited registration and preserves the viewer persona. Corrective CI [35817381642](https://github.com/vikashkaruna/Proof/actions/runs/35817381642) is green: 17 applicable jobs and eight exact-revision artifacts verified. No other-model changes were found during that review.

## Findings and implementation

The verifier already had a fail-closed trust-source interface, but real worker acceptance supplied captured fixture keys. A dedicated VM controller needs current public signing bundles through a protected local endpoint. `WorkloadApiJwtTrust` now implements that interface using the standard [SPIFFE FetchJWTBundles contract](https://github.com/spiffe/spiffe/blob/main/standards/workloadapi.proto) and the required endpoint metadata described by the [Workload Endpoint specification](https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE_Workload_Endpoint.md).

The implementation opens a bounded local Unix gRPC stream per operation, consumes one complete snapshot, cancels and closes the transport, and returns only validated public signing keys. Configuration admits no remote endpoint, token-derived URL or unknown transport override. The selected domain must be configured in advance. Response size, bundle count, selected JWKS size, public key count and call duration are bounded. A domain-bound SHA-256 fingerprint identifies the snapshot; the verifier requires a second fresh read with that fingerprint and checks the initial ten-second expiry. Errors return refusal without transport details or cached fallback. This is a local-node snapshot guarantee, not proof of instantaneous server replication or atomic global key revocation.

The shared canonical domain/identity parser also rejects trailing line terminators, which JavaScript `$` anchors alone may accept. JWT audience/signature/TTL rules, live registration/task checks and default deny-all public composition remain intact.

## Validation

26 new real Unix-gRPC unit tests cover signature integration, required metadata, independent rereads, rotation/removal, unavailable socket, silent/ended/refused streams, malformed/private/oversized bundles, foreign domains, bounded maps, unsafe configuration and identity line terminators. All **908 BFF tests**, workspace tests/lint/typecheck and acceptance TypeScript pass locally.

The SPIRE acceptance harness adds a separately registered controller UID and test-only BFF image target. Its read-only, networkless, capability-free controller container retrieves real signing bundles and validates a real Parikshan SVID. An unregistered UID and a paused node are refused. The TypeScript loader initially attempted to write its cache; disabling that cache fixes test startup while preserving the read-only boundary. No private output is emitted. Three new outcomes have their own artifact; 61 identity and 54 worker outcomes remain separate. Final exact-merge CI must verify nine JSON artifacts. The populated database suite is unchanged at migration 0048.

## Remaining gates

The accepted deployment target remains a dedicated Mumbai VM runner with public APIs on Cloud Run. Protected node bootstrap/enrollment, socket ownership/mount policy, issuer health, controller/scheduler deployment and actual production composition are still open. The host-side assessment harness still uses its earlier captured test trust; the new controller integration proves the adapter separately. Do not describe it as a deployed controller or live connector execution. Remaining workers and actor chains, W4.4 grants, full W3 wizard/readiness/live graph, W4.5–7, W0/W1/W2 remainder and backup-aware key retirement remain open. No cloud apply, client mutation, signing-key retirement or WORM change occurred.
