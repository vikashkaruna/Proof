# ==============================================================================
# Axiom Proof — self-hosted Supabase for preprod (W0.1)
# ==============================================================================
# The founder's decision: higher environments self-host Supabase Auth and
# PostgREST against their own Cloud SQL rather than using Supabase Cloud, so
# preprod is a real replica of production and no third-party processor sits in
# the data path of a DPDP compliance product.
#
# Before this, `cloudrun.tf` hard-coded
#     supabase_preprod_url = "https://preprod-supabase.axiomproof.ai"
# and nothing in the Terraform provisioned anything to answer at that name.
# The .env template meanwhile pointed at `<project-ref>.supabase.co`, and
# SUPABASE_DB_URL pointed at a Cloud SQL address — three different answers to
# "where does preprod's Supabase come from", none of which existed.
#
# The topology is the same one docker-compose.supabase.yml already runs
# locally, which is what makes local a fair rehearsal for it:
#
#     gateway (nginx)  ──/auth/v1/──▶ GoTrue
#                      ──/rest/v1/──▶ PostgREST
#                                         │
#                                     Cloud SQL
#
# supabase-js is given ONE origin and appends those paths itself, so the
# gateway is not decoration — it is what makes a self-hosted deployment look
# like Supabase to the client libraries.
#
# The migration series is applied to Cloud SQL BEFORE these services start.
# Migration 0000 creates the `auth` schema and Supabase's roles itself, and
# GoTrue then runs its own migrations over that schema. That ordering is
# proved in tests/deployment/selfhosted-supabase.sh, which builds this exact
# shape locally against an empty database.
# ==============================================================================

locals {
  supabase_auth_url    = "https://axiom-supabase-auth-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
  supabase_rest_url    = "https://axiom-supabase-rest-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
  supabase_gateway_url = "https://axiom-supabase-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"

  # Mirrored into Artifact Registry by scripts/build-preprod-images.sh: Cloud
  # Run cannot pull from Docker Hub directly. Versions match
  # docker-compose.supabase.yml so local and preprod run the same builds.
  supabase_auth_image    = "${local.image_prefix}/gotrue:v2.169.0"
  supabase_rest_image    = "${local.image_prefix}/postgrest:v12.2.8"
  supabase_gateway_image = "${local.image_prefix}/axiom-supabase-gateway:${var.environment}"
}

# ─── GoTrue (Supabase Auth) ───────────────────────────────────────────────────
resource "google_cloud_run_v2_service" "supabase_auth" {
  name     = "axiom-supabase-auth-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.cloudrun_sa.email

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    scaling {
      min_instance_count = 1
      max_instance_count = 2
    }

    containers {
      image = local.supabase_auth_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      ports {
        container_port = 9999
      }

      env {
        name  = "GOTRUE_API_HOST"
        value = "0.0.0.0"
      }
      env {
        name  = "GOTRUE_API_PORT"
        value = "9999"
      }
      env {
        name  = "GOTRUE_DB_DRIVER"
        value = "postgres"
      }
      # Carries `search_path=auth`; see the note in secrets.tf.
      env {
        name = "GOTRUE_DB_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gotrue_db_url"].secret_id
            version = "latest"
          }
        }
      }
      # One secret signs here and validates in PostgREST below. They were two
      # different hardcoded values in the compose file once, which meant every
      # token GoTrue issued was rejected — invisible only because
      # authentication was bypassed everywhere at the time.
      env {
        name = "GOTRUE_JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["supabase_jwt_secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "GOTRUE_JWT_AUD"
        value = "authenticated"
      }
      env {
        name  = "GOTRUE_JWT_EXP"
        value = "3600"
      }
      # GoTrue writes the `role` claim from its default group. Unset, it emits an
      # empty string, PostgREST runs `set local role ""` and every authenticated
      # request fails with `role "" does not exist` — a 400 that looks like a
      # malformed query rather than a misconfigured claim.
      env {
        name  = "GOTRUE_JWT_DEFAULT_GROUP_NAME"
        value = "authenticated"
      }
      env {
        name  = "API_EXTERNAL_URL"
        value = local.supabase_gateway_url
      }
      env {
        name  = "GOTRUE_SITE_URL"
        value = local.web_service_url
      }
      env {
        name  = "GOTRUE_URI_ALLOW_LIST"
        value = "${local.web_service_url},${local.marketing_url}"
      }
      env {
        name  = "GOTRUE_EXTERNAL_EMAIL_ENABLED"
        value = "true"
      }
      # Preprod has no outbound mailer wired, so a signup that waited for a
      # confirmation link could never complete. This is deliberately NOT how
      # production should be configured.
      env {
        name  = "GOTRUE_MAILER_AUTOCONFIRM"
        value = "true"
      }
      env {
        name  = "GOTRUE_DISABLE_SIGNUP"
        value = "false"
      }
    }
  }

  depends_on = [google_project_service.apis]
}

# ─── PostgREST (Supabase REST) ────────────────────────────────────────────────
resource "google_cloud_run_v2_service" "supabase_rest" {
  name     = "axiom-supabase-rest-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.cloudrun_sa.email

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    scaling {
      min_instance_count = 1
      max_instance_count = 3
    }

    containers {
      image = local.supabase_rest_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      ports {
        container_port = 3000
      }

      env {
        name = "PGRST_DB_URI"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["db_url"].secret_id
            version = "latest"
          }
        }
      }
      # Only `public`. The BFF reaches operational schemas with the service
      # role over its own connection; exposing them here would put them behind
      # nothing but RLS.
      env {
        name  = "PGRST_DB_SCHEMAS"
        value = "public"
      }
      # An unauthenticated request is `anon`, which migration 0016 left able to
      # read nothing. That is the boundary, and it is the same boundary
      # Supabase Cloud applies.
      env {
        name  = "PGRST_DB_ANON_ROLE"
        value = "anon"
      }
      env {
        name = "PGRST_JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["supabase_jwt_secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "PGRST_JWT_AUD"
        value = "authenticated"
      }
      env {
        name  = "PGRST_DB_USE_LEGACY_GUCS"
        value = "false"
      }
    }
  }

  depends_on = [google_project_service.apis]
}

# ─── The single origin ────────────────────────────────────────────────────────
resource "google_cloud_run_v2_service" "supabase_gateway" {
  name     = "axiom-supabase-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.cloudrun_sa.email

    scaling {
      min_instance_count = 1
      max_instance_count = 2
    }

    containers {
      image = local.supabase_gateway_image

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "PORT"
        value = "8080"
      }
      env {
        name  = "SUPABASE_AUTH_UPSTREAM"
        value = local.supabase_auth_url
      }
      env {
        name  = "SUPABASE_REST_UPSTREAM"
        value = local.supabase_rest_url
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_cloud_run_v2_service.supabase_auth,
    google_cloud_run_v2_service.supabase_rest,
  ]
}

# ─── Reachability ─────────────────────────────────────────────────────────────
# All three are public, which is what Supabase Cloud also is: GoTrue is a
# public sign-in API and PostgREST is guarded by the JWT it validates and by
# RLS, not by network position. Making them private would require the gateway
# to mint identity tokens per request and would move the security boundary to
# somewhere weaker than the one already proved by the database tests.
resource "google_cloud_run_v2_service_iam_member" "supabase_auth_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.supabase_auth.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "supabase_rest_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.supabase_rest.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "supabase_gateway_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.supabase_gateway.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
