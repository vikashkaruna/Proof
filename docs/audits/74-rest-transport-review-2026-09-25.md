# Revision 85 — W4.7 REST/OpenAPI read transport and reference descriptor pack

## Scope and assumptions

Doc 11 defines W4.7 as:

- the `saml2_bearer` handler;
- REST/OpenAPI as the primary transport, plus GraphQL;
- an OpenAPI descriptor pack for CRM, HRMS, data warehouse, ticketing and code repository, which absorbs item 15.

Operator input was not received. The assumptions are:

1. **Reference provenance.** The plan allows targets other than the live PostgreSQL target to be "labelled by provenance". No vendor tenant is available in this session, and a vendor API shape written from memory cannot be verified. The five-system pack therefore ships as `reference` descriptors bound to `reference-mock`, and runs against Axiom's reference service. A `vendor-verified` descriptor replaces each one when it is proven against a real client tenant.
2. **Read side only.** This is Drishti discovery. REST writes wait for W5 approved-action execution.
3. **Declarative only.** A descriptor declares literal GET paths, a JSON pointer to the items, a page-size parameter and an optional cursor. It carries no templating, query text or code.
4. **Same token path.** Tokens come from the W4.2/W4.4 broker as an `AcquiredToken`. The connector's `token` callback is `broker.acquire(...)` under a live grant.

## Change

**Manifest schema** (`@axiom/types`):

- an optional `provenance` field, either `reference` or `vendor-verified`;
- a `rest.resources` block, allowed only when `transport` is `rest`, and required then;
- REST paths must be absolute and literal: `.` and `..` segments, templates, queries and `//` are rejected;
- JSON pointers are bounded.

**`RestReadConnector`** (`services/bff/src/connectors/rest/rest-read.ts`):

- The endpoint is an HTTPS origin only: no path, no userinfo, no query, no fragment.
- It calls only declared resources, using an own-property lookup.
- Requests carry the broker's bearer token through `withValue`, and the token is destroyed after each call.
- `redirect: 'error'`, with a timeout bound to the invocation deadline.
- Responses must be `200` and JSON, capped at 1 MiB for both the declared length and the streamed bytes.
- Response bodies, values and tokens never enter errors.
- `enumerate` returns the field paths observed in one small page of each declared resource.
- `sample` (at most 100 items, cursor-paged) returns per-field value-shape counts only. `read` is refused.

**Shared profiler** (`connectors/profile.ts`): the name hints and value detectors are now shared by the SQL and REST adapters.

**Reference pack:** `crm`, `hrms`, `data-warehouse`, `ticketing` and `code-repository` descriptors, all using `oauth2.client_credentials` with high assurance and no write capability. They are registered in the reviewed catalogue and copied into the build by the existing descriptor copy step.

## Evidence

`rest-read.test.ts` runs every call as a real HTTP round-trip to a loopback reference server. The validated HTTPS URL is forwarded unchanged, and the test asserts that forwarding. It covers:

- **Pack:** all five descriptors are present, reference-bound, and have no writes.
- **Enumeration:** returns field paths and sends the broker bearer token.
- **Sampling and paging:** sampling returns counts only, cursor paging works, and none of the seeded values or the token appear in the output.
- **Refusals:**
  - undeclared and prototype resources, an oversized limit, an injected cursor and an expired deadline;
  - a redirect, a non-JSON response, a body over 1 MiB, a 404 and a 401;
  - raw reads.
- **Rejected at load:**
  - unsafe paths: traversal, `//`, query, relative and templated;
  - a REST block on a SQL descriptor, and a REST descriptor without one;
  - non-HTTPS, userinfo, path-bearing and query-bearing endpoints.

Results: the BFF suite passes (1081 tests plus 5 live SQL tests that are skipped locally and run in CI), types 45, and repo typecheck, lint and format are clean.

## Not delivered (remaining W4.7 scope)

- The GraphQL transport and the `saml2_bearer` grant handler.
- Vendor-verified descriptors, which need real client tenants.
- A reviewed `endpointRef → RestEndpoint` configuration store and an invocation route. The same gap exists for W4.6 SQL.
