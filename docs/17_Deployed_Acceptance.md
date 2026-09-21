# Deployed acceptance: API and browser parity

This runner creates synthetic tenants, accounts, MFA factors, assessments, estate inventory, connector registrations, proposals and approval fixtures. Use an **isolated acceptance deployment**, never a client production database. A production-configured acceptance stack uses production security rules with synthetic data. It does not execute connector actions. Fixture rows and append-only ledger events remain after the run; reset/dispose of the isolated database through its normal operator lifecycle. Do not delete audit history to clean up a shared deployment.

## Prepare the target

1. Deploy BFF, web and marketing from the same clean Git revision. Supply `--build-arg AXIOM_RELEASE_SHA=<40-character SHA>` to each Docker build. The image retains that revision; do not override it with an unrelated runtime value. The preprod image builder supplies it for clean checkouts. A dirty build has no trustworthy release identity.
2. Use `ENVIRONMENT=preprod`, `production` or `onprem` and `AXIOM_AUTH_MODE=strict`. Apply all migrations (currently 0000–0040). Keep external contact email disabled and BFF `AXIOM_REPORT_EMAIL_MODE=disabled`; preflight refuses enabled report delivery or a contact delivery key. The fixture setup seeds the published control library if absent and refuses a conflicting count; it never overwrites existing control rows. Ensure all endpoints are reachable from the runner.
3. Populate a private JSON file using [ACCEPTANCE_TARGET.example.json](ACCEPTANCE_TARGET.example.json). Obtain credentials through the environment's secret store, not chat or shell history. `anonKey` is the JWT anon key; `publishableKey` is the API gateway key (or the same anon key for legacy self-hosted deployments); `serviceKey` is the service-role JWT used only by fixture setup. The BFF's MFA encryption/signing keys are never supplied to the runner. SSR requires only the scoped public Supabase connection, not the service-role, signing or MFA encryption keys.
4. Store the file under ignored `.axiom-runtime`, with mode `0600`. Set `topology=remote` for HTTPS deployments; loopback HTTP is permitted only with `topology=local-docker`. `syntheticFixtures=true` explicitly confirms the target's fixture purpose. Use a different `deploymentId` per deployment. Set `expectedRevision` to the deployed source SHA.

## Run and compare

```bash
chmod 600 .axiom-runtime/preprod-target.json
./scripts/run-deployed-acceptance.sh .axiom-runtime/preprod-target.json
./scripts/run-deployed-acceptance.sh .axiom-runtime/production-target.json
pnpm exec tsx scripts/compare-deployed-parity.ts \
  .axiom-runtime/acceptance/<preprod-id>/api-results.json \
  .axiom-runtime/acceptance/<production-id>/api-results.json
pnpm exec tsx scripts/compare-deployed-parity.ts \
  .axiom-runtime/acceptance/<preprod-id>/browser-results.json \
  .axiom-runtime/acceptance/<production-id>/browser-results.json
```

The runner verifies strict BFF identity and unauthenticated refusal before seeding. Browser setup also checks web/marketing revision and security configuration. It enrols fixture MFA through the actual BFF, then drives the same Playwright journeys as local CI. Target-bound persona state prevents accidentally mixing local credentials and deployed URLs. `PLAYWRIGHT_BASE_URL` alone is refused.

Only `api-results.json` and `browser-results.json` are suitable for CI artifacts. They contain allowlisted scenario names/outcomes and deployment metadata, no credentials or response bodies. Raw browser JSON/logs and persona state are private; deployed traces, screenshots and video are disabled. Failed/flaky/skipped browser runs cannot produce successful comparison evidence. Compare artifacts from the same CI run and revision; timestamps are recorded for traceability, not an assertion of indefinite validity.

## CI and Docker rehearsal

`.github/workflows/deployed-acceptance.yml` manually runs preprod against either production-configured or on-prem acceptance. Configure GitHub environments `preprod-acceptance` and the selected comparison environment, each with the secret `AXIOM_ACCEPTANCE_TARGET_JSON`. Both deployments must run the requested revision. The final job compares both successful API and browser suites and refuses divergence, repeated endpoints, mismatched revisions or local/remote substitution. Use trusted reviewed revisions only: the workflow receives fixture-administration credentials. GitHub manual dispatch requires this workflow to be present on the default branch; pushing it to staging alone does not run or provision it.

Automatic staging CI runs `scripts/test-deployed-http.sh --browser`: two separate sets of production-mode BFF/web/marketing containers, configured preprod/production, sharing the isolated local Docker Auth/Postgres stack. It verifies the HTTP runner without claiming cloud deployment. For the full local production-container rehearsal:

```bash
# Install Playwright Chromium first, or use AXIOM_E2E_BROWSER_CHANNEL=chrome locally.
./scripts/test-deployed-http.sh --browser
```

Run it from a clean committed checkout; it refuses to stamp uncommitted source with a release SHA. This adds web and marketing containers on separate ports for each configuration, without backend credentials in SSR. SSR→BFF uses private Docker DNS; browser/test ports stay bound to host loopback on both Linux and Docker Desktop. It compares the API results and the complete browser journeys. Only its own application containers are removed afterward; the isolated Supabase project remains for inspection. Local Docker evidence cannot close remote W0 acceptance. No cloud resources are created by either test runner.

## Durable gap-scan restart probe

The local container runner automatically submits a synthetic report, restarts both BFF and marketing processes, waits for health, and checks that the owning browser capability still reads the report while anonymous retrieval and resend fail. Successful checks add three boolean outcomes to the same sanitized API result file. The private capability remains in `gap-scan-private.json` and must never be uploaded.

For an isolated remote deployment, run the ordinary API/browser acceptance first, then:

```bash
export AXIOM_ACCEPTANCE_TARGET="$PWD/.axiom-runtime/preprod-target.json"
pnpm exec tsx scripts/verify-gap-scan-durability.ts prepare
# Operator: restart all BFF/marketing replicas without replacing the database.
# Retain deployment restart evidence; the probe cannot prove an operator restarted them.
pnpm exec tsx scripts/verify-gap-scan-durability.ts verify
```

Repeat for the comparison target before comparing API artifacts. The manual workflow runs API/browser checks but does not restart remote services; remote durability closure needs this separate operator evidence. The capability is bound to the target URL and source revision. No real email is sent; disabled dispatch returns unavailable, not simulated success. This checks persistence/ownership, not questionnaire scoring accuracy or contact inquiry durability.

Vault and OAuth broker core acceptance is covered by SQL/crypto/adapter tests and isolated HTTP/TLS authorization-server fixtures. The existing browser/API parity suite does not acquire client tokens or exercise cloud KMS/SPIRE. Deployed workload/grant authority, real KMS and client execution require separate evidence (Doc 16 W4-2); the broker defaults to deny-all.

## Isolated workload identity acceptance (W4.3)

`python3 scripts/test-workload-identity.py` runs real SPIRE issuance and the BFF identity verifier in a fresh local Docker fixture. CI publishes only `workload-identity-acceptance/results.json` (61 allowlisted outcomes, source revision and dirty status). It is separate from the 63-browser/89-API application parity suite. A passing identity fixture does not prove deployed workload isolation, live task/grant authority or connector execution. See Doc 16 W4-3 before enabling any acquisition route.

## Runtime audit acceptance (W4.3)

After local parity-stack startup, run `uv run python ../../scripts/verify-runtime-audit.py` from `services/agent-runtime`. Five real-Postgres outcomes check durable strict-mode appends, numeric receipts, redacted metadata, digests and the actual ledger chain. CI includes this in the strict Auth/PostgREST lane and publishes only `runtime-audit-acceptance/results.json`. Synthetic tenant/audit records remain; never delete audit rows as cleanup. This probe does not replace workload/task/grant enforcement or demonstrate client execution. Unit fault injection separately covers start/completion failures and secret-bearing exceptions.
