# Revision 86 — W4.7 GraphQL read transport

## Scope and assumptions

This delivers the GraphQL transport named in W4.7, for Drishti discovery only. Operator input was not received. The assumptions are:

1. **No query text in descriptors.** A descriptor declares names only: the root field, the pagination arguments, the items and cursor paths, and the field selections. Axiom renders the single query document. This keeps doc 11's "no executable code" descriptor rule, and makes a mutation impossible to express.
2. **Pagination.** Only cursor pagination through variables is supported. The cursor argument and the cursor path must be declared together.
3. **Shared transport controls.** GraphQL reuses the REST transport controls: HTTPS origin, broker token, no redirects, deadline-bound timeout, and a 1 MiB JSON cap. A response containing any GraphQL `errors` is refused whole and never echoed, so a partial response is not profiled as if complete.

## Change

**`@axiom/types`:** a `graphql` block (`path` plus `resources`), validated as follows:

- names must match the GraphQL name grammar;
- selections are at most 3 levels deep, 100 in total, and unique;
- the block is required for `transport: graphql` and forbidden for every other transport.

**`GraphqlReadConnector` and `discoveryQuery`** (`services/bff/src/connectors/rest/graphql-read.ts`), which reuses the `requestJson` helper extracted from the REST connector.

## Evidence

`graphql-read.test.ts` runs against a loopback reference server:

- the exact generated query document;
- enumeration reporting observed and missing fields;
- shape-only sampling, with cursor variables across two pages and no values or token in the output;
- refusal of a GraphQL `errors` response, without leaking its message;
- refusal of prototype resource names, an injected cursor, an expired deadline and raw reads;
- schema rejection of:
  - roots or fields that inject selection or mutation text;
  - duplicate fields;
  - selections deeper than 3;
  - half-declared cursors;
  - a GraphQL descriptor without its block.

The REST suite still passes after the `requestJson` extraction.

## Not delivered

- `saml2_bearer`: RFC 7522 requires signing a SAML assertion (XML-DSig), which needs a reviewed XML signature dependency.
- Vendor-verified GraphQL descriptors.
- Endpoint configuration and invocation routes.
