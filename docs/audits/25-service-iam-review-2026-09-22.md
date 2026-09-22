# C-W0-5 service IAM review — 22 September 2026

The shared Cloud Run identity could read every project secret, including backend credentials from an SSR container. Removing environment variables did not remove that authority. This change gives the nine GCP services separate runtime identities and 29 explicit secret-level access grants. The conditional retiring MFA key ring adds one BFF-only grant during rotation. The gateway has no secret grant.

| Service          | Managed secrets it can access                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| BFF              | Supabase anon/service keys, approval key, MFA primary key, agent transport token, model gateway key, evidence HMAC pair, report mail key |
| Web SSR          | Supabase anon key only                                                                                                                   |
| Marketing SSR    | Supabase anon key and the existing contact mail key                                                                                      |
| Agent runtime    | Supabase service key, approval verification key, agent transport token, model gateway key and evidence HMAC pair                         |
| Model gateway    | Its API key, three configured model provider keys and Redis URL                                                                          |
| Temporal worker  | Temporal API key and agent transport token                                                                                               |
| Supabase Auth    | GoTrue database URL and JWT signing key                                                                                                  |
| PostgREST        | Database URL and JWT validation key                                                                                                      |
| Supabase gateway | None                                                                                                                                     |

The runtime's permissions still belong to its shared ten-agent process. This is service-level isolation, not completion of W4.3 agent isolation. The approval HMAC key and storage/backend credentials must move out of credential-less workers as the scoped execution services are implemented. Marketing's contact mail remains the explicit C-W0-6 exception; report mail already belongs to BFF. These exceptions are visible in the reviewed allowlist rather than hidden behind project-wide access.

Unused BFF database-password and Redis bindings are removed. Cloud SQL Client and Artifact Registry Reader are not copied onto the new runtime identities: current database connections use password-authenticated TCP, and image import belongs to the deployment/Cloud Run service agent. Changing the database path to the Auth Proxy or IAM authentication requires its own permission review. This change does not tighten the existing SQL network allowlist, split PostgreSQL roles, or change internal HTTP ingress/token policy.

Review also corrected missing `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` bindings in the agent runtime, and missing `ENVIRONMENT`/`AGENT_RUNTIME_INTERNAL_TOKEN` in Temporal. Without those, the runtime used its local defaults and Temporal did not activate its deployed-environment credential validation. Runtime token injection uses the canonical variable now supported by Python.

Every service waits for IAM grants and secret versions before rollout. Optional MFA resource counts declassify only the boolean presence of a retiring key, keeping the key sensitive; using a sensitive expression directly as `count` was invalid during planning. The base deployment phase creates identities; the database/secrets phase provisions scoped grants, including rotation. Teardown targets include those resources and the previously omitted Supabase services. Old shared-account/project-role resources are removed by a full Terraform services-phase plan/apply, not by a state edit or an automatic cloud action in this session.

Validation: nine-service binding/policy checker; ten mutation/target-coverage tests; four evaluated Terraform runs with all providers mocked (identity/grant mapping, production account names, rotation on/off, invalid environment); `terraform validate`, formatting and shell syntax. The mocks prove configuration relationships, not actual cloud IAM denial. The existing strict Docker, real Postgres/SPIRE and browser gates remain required on the exact staging merge.

Deployment acceptance still needs an operator-reviewed full plan, current revision identities, removal of old project-wide bindings and effective-policy checks that web/marketing cannot read backend keys or impersonate privileged identities. Account/project/folder/organization grants outside this Terraform are not inspected by the offline tests. Roll back by redeploying a reviewed image with the new service identity and allowlist; an old revision referencing the retired shared account is not a safe rollback target.

Primary references: [Cloud Run secret access](https://docs.cloud.google.com/run/docs/configuring/services/secrets), [service identities](https://docs.cloud.google.com/run/docs/configuring/services/service-identity), [image deployment permissions](https://docs.cloud.google.com/run/docs/deploying), [direct PostgreSQL connections](https://docs.cloud.google.com/sql/docs/postgres/connect-instance-cloud-run).
