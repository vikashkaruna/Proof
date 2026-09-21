# Integrated review — estate foundation and browser acceptance

Reviewed staging `a73dad7` and retained MFA key-ring handling, real browser approval flows, Helm semantic/render gates and Terraform validation. The upstream CI was green; this review independently reran the affected service, crypto, browser and database suites rather than treating the handoff as completion evidence.

## Fixed findings

- **Browser harness privilege separation:** `commonEnv` carried the real local Supabase service key into both Next applications. The key is now supplied only to the BFF. Persona provisioning still runs separately with administrative fixture authority.
- **Approval-page hydration:** the inline agent badge rendered a div inside PageHeader's paragraph. Browser logs reported hydration failure while all 47 test assertions passed. The icon now renders a span and rich descriptions use a div. Approval journeys reject uncaught browser errors; reverting those markup changes causes the successful-token journey to fail the new assertion.

## W2 implementation acceptance

0029 creates estates, systems, declared/observed data-category metadata and scan lifecycle records. Tenant-consistent composite references protect all parent links and engagement estate scope. RLS grants membership reads, including assigned analysts, with no direct browser writes and no dependency on JWT tenant claims. Service policies are explicit; positive database tests run with BYPASSRLS removed. Archival preserves referenced scope; deletion is restricted.

The new SQL suite proves positive reads/writes, cross-tenant reference failures, client write denial, stale and missing tenant claims, revoked membership, scan-state validity, slug uniqueness within a tenant and independent reuse across tenants. A separate populated-database upgrade preserves an existing 0028 engagement with no inferred estate. The real Auth lane exercises all four tables over PostgREST for every strict environment label. Engagement creation accepts the optional scope through the existing capability-gated API.

## Remaining work

This is a schema and assessment-linkage milestone, not estate discovery. Management APIs, audited onboarding normalization, graph, connectors and scan jobs remain pending. The four-label test uses the same local stack under different configurations and is not four cloud deployments. Browser positive enrollment/recovery/replacement coverage is not implied by seeded-factor approval coverage. In particular, the current Replace authenticator button never obtains the required enrollment-purpose challenge; the BFF correctly rejects it. No approval policy is weakened to make that UI work.

The unresolved production EKS endpoint range, live retention proof, MFA key retirement against deployed instances and named regulatory sign-off remain deployment/acceptance work. No cloud apply was attempted.
