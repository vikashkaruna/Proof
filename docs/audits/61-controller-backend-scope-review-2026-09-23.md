# Revision 72 — controller backend authority

The previous controller file contained a broad service-role credential. Tenant checks inside the process did not constrain a compromised credential. This revision moves that tenant boundary into PostgreSQL and switches the actual controller entrypoint and composed integration to scoped credentials.

## Database boundary

Migration 0049 creates `axiom_assessment_controller` with no login, inheritance, superuser, role/database creation, replication or RLS bypass. Only PostgREST's authenticator receives membership. A private, unexposed schema holds credential subject → tenant bindings, expiry and revocation. Neither the ordinary backend nor the controller can read or administer it.

Three existing tables have explicit column grants and tenant RLS. Ciphertext/proof is unavailable through raw selects. Seven public controller RPCs retain their signatures and defaults; their original implementations move to the protected schema. Wrappers check the requested tenant before entering that existing implementation. Null tenant scheduling is refused for controllers. Existing backend callers retain their prior rights. Delegation, enqueue, approval, policy publication, registration management and retention are not controller grants. `has_tenant_role` remains a public read helper; its existing subject-bound behavior adds no write privilege.

The current effective SQL role, signed JWT role/subject/tenant, integer issue/expiry times, registered binding and live registry expiry/revocation must agree. Tokens last at most one hour; registry leases at most 24 hours. PostgREST verifies the cryptographic signature. SQL enforces the tenant and live registration on subsequent statements, including when callers bypass application checks. Revocation cannot undo an already authorized in-flight SQL statement; existing receipt reconciliation still applies.

## Protected credential delivery

`backend.key` now contains JSON with `schemaVersion: 1`, `apiKey` (anonymous gateway JWT) and `accessToken` (signed controller JWT). The latter has role `axiom_assessment_controller`, a unique registered UUID `sub`, exact `tenant_id`, integer `iat` and `exp`. Raw service-role keys and broad gateway keys are refused. File ownership/mode, minimal environment and no-secret-in-argv/metadata rules remain unchanged.

Before constructing the listening controller, the entrypoint makes a ten-second bounded, read-only `current_assessment_controller_tenant` call and compares the result to the reviewed configuration. Local JWT decoding only rejects unsuitable shape; it is not signature verification. There is no provisioning, credential refresh, broad-key fallback or activation on startup.

For eventual authorized deployment, a trusted issuer outside the runner must register a fresh subject/tenant with a reviewed expiration, sign the scoped JWT using the backend's trusted signing authority, and deliver the credential through the protected generation workflow. Never grant the runner the signing key or ordinary service-role key. Expiry/revocation closes subsequent database access. Renewal, new file-generation review and explicit controlled restart remain operational integration work; this source does not supply an unattended credential issuer.

## Evidence and limits

SQL tests cover tenant RLS, column restrictions, every scoped RPC's foreign-tenant refusal, null scheduling, registry protection, direct-write denial, exhaustive public SECURITY DEFINER ACLs, revocation and retained backend behavior. Existing transaction, concurrency and upgrade tests run against real PostgreSQL. The real Auth/PostgREST acceptance verifies signatures, foreign reads, forbidden calls, tampering and revocation; the actual controller composition and entrypoint use scoped credentials.

Exact source/staging results are pending at this checkpoint and must be attached to closure. The schema has 50 migrations through 0049, 55 public tables and one private registry table. W2 remains 19/40 named targets. Resource-level secret/KMS grants, inherited effective IAM review, issuance/renewal integration, private TLS/DNS, opaque scheduler, real GCP identity/KMS and Mumbai restore remain open. No cloud provisioning or application approval rule changed.
