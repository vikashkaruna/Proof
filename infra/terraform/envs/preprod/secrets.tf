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
    db_password                  = random_password.db_password.result
    db_url                       = "postgresql://${google_sql_user.axiom_user.name}:${random_password.db_password.result}@${google_sql_database_instance.postgres.public_ip_address}:5432/${google_sql_database.axiom_db.name}"
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
    gcs_hmac_access_key          = google_storage_hmac_key.s3_compat_key.access_id
    gcs_hmac_secret_key          = google_storage_hmac_key.s3_compat_key.secret
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
