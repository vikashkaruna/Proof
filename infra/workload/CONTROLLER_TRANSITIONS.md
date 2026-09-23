# Reviewed controller generation transitions

`controller_transition.py` is a manual root operator helper delivered in the reviewed runner bundle. It changes only an exact disabled, inactive tenant controller unit after checking protected immutable profiles, generations and stopped container ownership. It records publication and loaded-unit confirmation separately. It never stops, reloads, enables or starts services, issues/revokes credentials, changes tasks/claims or removes files/containers.

This is infrastructure administration. The external change record and request hash do not authenticate a human and never substitute for signed scope-bound application approval, completed dry-run and validated rollback. Root, the system manager and daemon administration remain trusted. Repeated observations do not create a transactional systemd/daemon lock.

## Inputs and prerequisites

Use the newly reviewed runner bundle containing this helper and the corresponding runtime admission guard. Host installation refuses changed existing helper bytes; this procedure does not silently upgrade an older bundle. A separately reviewed host deployment/upgrade is required before using it on an existing host. No such cloud deployment is performed by repository acceptance.

Prepare the new credential with the separate [issuer procedure](../credential-issuer/README.md), then a fresh immutable controller file generation with `controller_files.py --install SOURCE SHA`. Prepare a new protected placement profile and runtime profile referring to that generation. Preserve the previous profiles, placement inputs, generations and all container attempt journals. Both generations must pass static file admission during transition; a damaged predecessor is an investigation/recovery case, not permission to bypass checks.

Copy `controller-transition.example.json` into canonical root-owned protected ancestry, mode0600. Replace every placeholder and independently review its exact bytes and SHA-256:

- `schemaVersion`: integer 1.
- `tenantId`: canonical nonzero UUID matching both profiles/generations.
- `approvalReference`: canonical nonzero external change-record UUID.
- `previousTransitionSha256`: `null` for the first transition; otherwise the exact hash of the latest confirmed transition request. Review a single immutable chain, including reverse transitions.
- `previousProfileSha256`: current installed immutable runtime profile.
- `nextProfileFile`, `nextProfileSha256`: canonical absolute protected source and its hash. The profile binds its own placement source/hash.
- `previousGenerationSha256`, `nextGenerationSha256`: exact immutable controller manifest hashes. Both the profile and generation must change.

The examples contain no deployable credentials. Hashes bind the request; they are not approval signatures. No ambient environment/configuration override is supported. No new application API or role grant is added.

## Ordered operator procedure

1. Record the reviewed change and rollback decision outside the host. Check the new credential lifetime leaves sufficient time for actual startup and readiness. Preserve the old credential until the separate retirement decision; expiration/revocation still applies to any proposed reverse transition.
2. Explicitly stop the tenant controller using its installed unit, and disable it if necessary. Wait for shutdown/stop-post recovery. The existing runtime stops only its journal-owned exact ID, with application 85 / Docker 90 / systemd 180-second budgets. Never hold the tenant lifetime lock while requesting its stop. Unknown create/start/stop outcomes require existing explicit recovery, not a fabricated stopped receipt or deletion.
3. Run `/usr/bin/python3 -I -B /opt/axiom/spire/1.15.3/controller_transition.py --publish /protected/transition.json REVIEWED_SHA256`. The helper takes the same per-tenant lifetime lock, then the enrollment lock. It requires an exact loaded disabled inactive/failed unit with no job, process, drop-ins, alternate fragment, transient configuration or pending reload. It reinspects **every** retained exact-ID container, checking name/image/labels and stopped state; a saved receipt does not hide a restarted or missing container. It writes complete preparation before atomic unit replacement and a published receipt afterward. No activation occurs.
4. Explicitly run `systemctl daemon-reload`. This is a system-wide operator action; the helper never performs it. Run the same helper with `--confirm` and the identical request/hash. It checks the current reviewed unit is loaded with no pending reload and all stopped-state/input bindings still hold, then writes confirmation last. The receipt establishes an observed loaded state, not proof of who invoked reload or application readiness.
5. Explicitly start the canonical `axiom-controller-TENANT.service`. Runtime admission refuses incomplete transition histories and retired profiles, checks exact latest unit bytes, and reinspects old stopped containers. Existing start admission repeats real VM placement, installed identity, protected files, image/environment and private binding checks. The actual application separately validates TLS, live credential scope/expiry/revocation and backend access. Verify real application readiness and a bounded tenant-scoped functional check; Docker running alone is insufficient. Leave automatic restart disabled.
6. Only after the reviewed readiness decision, separately retire the predecessor using the issuer's reviewed revocation operation. The host helper cannot revoke it. Preserve all immutable generations and journals; a statement already running can finish after retirement. Do not reset uncertain work.

Actual cloud secrets, effective inherited IAM, private DNS/TLS, GCP/caller/KMS and Mumbai recovery evidence remain external deployment gates. Completing this local/native engineering workflow does not close them.

## Interrupted publication and return to an earlier generation

The journal is `/var/lib/axiom-controller-transitions/TENANT/REQUEST_SHA/`, with 0700 directories and 0600 files: `request.json`, `previous.unit`, `next.unit`, `prepared.json`, `published.json`, `confirmed.json`. It contains hashes/metadata and unit bytes, never credential values. Every runtime attempt remains in its original separate journal.

If publication is uncertain, preserve everything and inspect the recorded change. Only explicit `--resume` with the identical complete preparation can reconcile the old/new exact unit or finish an already completed rename. Resume never reloads or starts; run the separate confirmation step afterward. A failure before complete preparation, unknown/extra files, changed inputs, conflicting unit, unsafe permissions/links, changed stopped snapshot or disconnected/branched history is preserved and refused. Investigate it; do not remove the journal to bypass admission. Confirmation can be retried identically while the unit remains idle and the snapshot unchanged. It is not a reusable readiness certificate. After a new runtime attempt, the old request is no longer a current-state confirmation.

Preparation snapshots are bounded to 1 MiB and refused before journal creation if larger. No garbage collection is supplied: all historical container IDs must remain inspectable. A separately designed and reviewed retention/recovery protocol is needed before deleting retained containers or histories.

Returning to an earlier generation requires a **new** request with a new change reference, the latest predecessor transition hash and reversed profile/generation bindings. Stop, publish, reload, confirm and start through the same steps. This never resurrects an expired/revoked credential; application startup must still reject it. Reissuing an old transition or claiming an older predecessor cannot fork the chain. There is no mutable `current` symlink or automatic rollback.

## Evidence boundaries

Unit tests exercise private files and failure windows with systemd/Docker observations injected. Hosted native acceptance uses real root filesystem protection, systemd and Docker, including interrupted publication, exact-ID stop checks, new protected read-only mounts and a separately reviewed reverse transition. Its controller process and local placement are deliberately synthetic. The separate Docker assessment suite exercises the actual issuer, scoped backend and application entrypoint. Neither component fixture alone proves a production live credential cutover.
