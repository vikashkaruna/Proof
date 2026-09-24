# Tenant routing review — 22 September 2026

## Revision 40 — dynamic tenant routing

Revision 39 is complete and green at staging `180ae52`, CI [35681594813](https://github.com/vikashkaruna/Proof/actions/runs/35681594813): 17 applicable jobs passed, with six exact-merge artifacts verifying 65 browser/89 API outcomes per configuration, 61 identity and five durable-audit outcomes. No intervening other-model staging changes were present.

Review found the browser BFF bridge translated only three demo slugs and otherwise targeted Meridian. Arbitrary customer slugs could therefore fail, or act in the wrong tenant when the caller belonged to both. The bridge now verifies the signed-in user and resolves its cookie through that user's RLS-scoped memberships. Unknown, stale and revoked selections return 403 without forwarding; lookup failure returns a sanitized 503. With no cookie it selects the first actual membership by stable tenant ID, matching the shared page context and app shell. Slug and UUID preferences both work. Explicit headers remain independently membership/MFA checked by the BFF. Only exact onboarding and tenant-discovery method/path pairs remain tenantless, with any incoming tenant header removed.

Validation: **76 web unit tests**, including 17 route regressions, and one new **real Auth/PostgREST/BFF browser journey** covering custom-tenant reads and writes, slug/UUID SSR agreement, invalid-cookie mutation refusal, foreign-header denial and membership revocation. Workspace tests, lint, typecheck, format and security gates passed. This is real tenant-routing acceptance, not an injected BFF response. Expected full browser acceptance is now **66 journeys per configuration**; exact merge CI is recorded separately in the saved session checkpoint. No schema change: 0041 / 42 migrations / 52 public tables; W2 targets 19/40.

**Remaining:** assessment source-data provenance, W4.3 isolated workers/private task tools/trust lifecycle/actor chains, W4.4 live grants/approval, full W3 wizard/readiness and graph, then W4.5/6/7. The overall goal remains active. SSR may still display a permitted fallback page for an invalid cookie, but implicit bridge operations refuse until the user selects a valid tenant. Portal's separate legacy selection/fallback logic should be consolidated during provenance review.

## Review boundaries

No admin/service credential was introduced into Next.js. The bridge performs a user-scoped routing lookup; the BFF remains the business authority and rechecks current membership/MFA on every forwarded call. There is a race between the bridge lookup and forwarding; removal in that interval is still refused by the BFF. Reads and writes share the same resolver. Explicit headers are intentionally not overridden by the cookie.

The exact tenantless allowlist preserves first-time onboarding and tenant discovery without conferring tenant ownership. Other paths, including suffix lookalikes, remain scoped. No database schema, workload authority, connector grants or approval constraints changed. Browser regression fixtures are unique local test tenants and use harness credentials only for setup/revocation; application requests use real signed-in cookies.
