# ==============================================================================
# Axiom Proof — Google Secret Manager (Preprod Secrets)
# ==============================================================================

# Stable random defaults replace the formerly committed signing/runtime keys.
# Keep Terraform state encrypted and access-controlled; these keys are durable.
resource "random_password" "internal_service_key" {
  for_each = toset(["approval_signing_key", "agent_runtime_internal_token", "model_gateway_api_key", "mfa_encryption_key"])
  length   = 64
  special  = false
}

locals {
  managed_secrets = {
    db_password = random_password.db_password.result
    db_url      = "postgresql://${google_sql_user.axiom_user.name}:${random_password.db_password.result}@${google_sql_database_instance.postgres.public_ip_address}:5432/${google_sql_database.axiom_db.name}?sslmode=require"
    # GoTrue needs the same database with `search_path=auth`, because its MFA
    # migration creates the `factor_type` and `factor_status` enums
    # UNQUALIFIED. Without it they are created in `public` and a later
    # migration dies on `type "auth.factor_type" does not exist`, having
    # already created sixteen tables — a failure that reads like a schema
    # conflict rather than a search_path one. Proved against real GoTrue in
    # tests/deployment/selfhosted-supabase.sh.
    gotrue_db_url                = "postgresql://${google_sql_user.axiom_user.name}:${random_password.db_password.result}@${google_sql_database_instance.postgres.public_ip_address}:5432/${google_sql_database.axiom_db.name}?search_path=auth&sslmode=require"
    upstash_redis_url            = var.upstash_redis_url != "" ? var.upstash_redis_url : "redis://default:placeholder@mock-upstash:6379"
    anthropic_api_key            = var.anthropic_api_key != "" ? var.anthropic_api_key : "placeholder-anthropic-key"
    openai_api_key               = var.openai_api_key != "" ? var.openai_api_key : "placeholder-openai-key"
    gemini_api_key               = var.gemini_api_key != "" ? var.gemini_api_key : "placeholder-gemini-key"
    approval_signing_key         = var.approval_signing_key != "" ? var.approval_signing_key : random_password.internal_service_key["approval_signing_key"].result
    agent_runtime_internal_token = var.agent_runtime_internal_token != "" ? var.agent_runtime_internal_token : random_password.internal_service_key["agent_runtime_internal_token"].result
    model_gateway_api_key        = var.model_gateway_api_key != "" ? var.model_gateway_api_key : random_password.internal_service_key["model_gateway_api_key"].result
    mfa_encryption_key           = var.mfa_encryption_key != "" ? var.mfa_encryption_key : random_password.internal_service_key["mfa_encryption_key"].result
    temporal_api_key             = var.temporal_api_key != "" ? var.temporal_api_key : "placeholder-temporal-key"
    resend_api_key               = var.resend_api_key != "" ? var.resend_api_key : "re_placeholder_resend_api_key"
    # No random fallback: a generated JWT secret would not be the one the
    # anon/service keys were signed with, so GoTrue would issue tokens
    # PostgREST rejects. An empty value here is a configuration error that
    # sync-env.sh's verify gate stops before Terraform runs.
    supabase_jwt_secret  = var.supabase_jwt_secret
    supabase_anon_key    = var.supabase_anon_key
    supabase_service_key = var.supabase_service_key
    gcs_hmac_access_key  = google_storage_hmac_key.s3_compat_key.access_id
    gcs_hmac_secret_key  = google_storage_hmac_key.s3_compat_key.secret
  }
}

resource "google_secret_manager_secret" "secret" {
  for_each  = nonsensitive(toset(keys(local.managed_secrets)))
  secret_id = "axiom-${var.environment}-${replace(each.key, "_", "-")}"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "version" {
  for_each    = nonsensitive(toset(keys(local.managed_secrets)))
  secret      = google_secret_manager_secret.secret[each.key].id
  secret_data = local.managed_secrets[each.key]
}

# ─── MFA key rotation — the retiring key ring ────────────────────────────────
# `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS` is empty except while a rotation is in
# flight, and an empty payload is not something Secret Manager will store: a
# version must have bytes. So this secret is conditional rather than a
# permanently-empty member of `local.managed_secrets`, which would fail every
# apply that is not a rotation.
#
# The conditionality is the design, not a workaround. Absent means "no retiring
# keys", which is exactly how the BFF's key ring reads an unset variable. When
# the rotation finishes and every enrolled factor has been rewrapped under the
# primary key, clearing the variable destroys the secret — so the retiring key
# stops existing here at the same moment it stops being needed, rather than
# lingering as a live decryption key nobody is watching.
resource "google_secret_manager_secret" "mfa_previous_keys" {
  count     = nonsensitive(var.mfa_encryption_keys_previous != "") ? 1 : 0
  secret_id = "axiom-${var.environment}-mfa-encryption-keys-previous"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "mfa_previous_keys" {
  count       = nonsensitive(var.mfa_encryption_keys_previous != "") ? 1 : 0
  secret      = google_secret_manager_secret.mfa_previous_keys[0].id
  secret_data = var.mfa_encryption_keys_previous
}
