---
name: cloud-resource-naming
description: Name every cloud or local deployment resource for Axiom Proof (GCP preprod, AWS prod, Docker) with the one enforced convention. Use before creating or proposing any bucket, registry, service, secret, account, role, network, budget, alert, scheduler job, database or container.
---

# Cloud Resource Naming Skill

One pattern, enforced by Terraform preconditions (`^axiom-proof-preprod-[a-z0-9-]+$`
in `infra/terraform/envs/marketing-preprod/main.tf`) and by the env-file parsers.
Names come from the environment file (`infra/docker/environments/.env.<env>`),
never hard-coded in scripts.

## Pattern

`axiom-proof-<env>-<component>[-<qualifier>]`

- `<env>`: `local`, `preprod`, `staging`, `prod` (exact `ENVIRONMENT` value).
- `<component>`: what it is (`marketing`, `bff`, `auth`, `rest`, `gateway`,
  `lifecycle`, `migrations`, `postgres`, `images`, `state`).
- `<qualifier>`: only to disambiguate (`-network`, `-egress`, `-sql-range`,
  `-db-url`, `-idle-check`, a project number for globally unique buckets).
- Lowercase letters, digits and hyphens only. Service account IDs must stay
  within 30 characters, so keep the component short.

## Where hyphens are not allowed

| Resource            | Form                                                                               | Example                             |
| ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| PostgreSQL database | `axiom_proof_<env>`                                                                | `axiom_proof_preprod`               |
| Custom IAM role ID  | `axiom_proof_<env>_<purpose>`                                                      | `axiom_proof_preprod_lifecycle_sql` |
| PostgreSQL roles    | fixed upstream names (`authenticator`, `supabase_auth_admin`) or `axiom_<purpose>` | `axiom_admin`                       |

## Reference names (preprod)

| Kind                        | Name                                                         |
| --------------------------- | ------------------------------------------------------------ |
| Artifact Registry           | `axiom-proof-preprod-images`                                 |
| Cloud SQL instance          | `axiom-proof-preprod-postgres`                               |
| State bucket                | `axiom-proof-preprod-state-<project-number>`                 |
| Cloud Run service / account | `axiom-proof-preprod-<component>`                            |
| Secret                      | `axiom-proof-preprod-<component>-<what>` (`...-auth-db-url`) |
| Scheduler job               | `axiom-proof-preprod-idle-check`                             |
| Billing budget              | `axiom-proof-preprod-budget`                                 |
| Registry cleanup policy     | `axiom-proof-preprod-keep-recent`                            |

Prod (AWS `ap-south-1`) uses the same pattern with `prod`; S3 bucket names add the
account ID like the GCS state bucket adds the project number.

## Local Docker

- Long-lived local stacks: `axiom-<purpose>` Supabase project IDs
  (`axiom-proof`, `axiom-owner-test`); compose containers `axiom-<service>`.
- Disposable rehearsal/trial objects: `axiom-<purpose>-<yyyymmdd>` or
  `axiom-<purpose>-<random12hex>`, labelled, and removed by whoever created them.
- Never name anything in another project's namespace, and never reuse a
  long-lived stack's name or port prefix for a disposable object.

## Before proposing a resource

1. Derive the name from the pattern; check it against the precondition regex.
2. Add the name as an env key in `.env.<env>.example` (and the real env file
   after the commit), not as a literal in code.
3. List the exact names in the phase plan the user approves.
