# Per-service runtime identities. This closes shared Cloud Run IAM access;
# splitting the ten agents inside agent_runtime remains mandatory W4.3 work.
# The allowlist is independent of env bindings so either side drifting fails CI.
locals {
  runtime_services = {
    bff = {
      suffix  = "bff"
      secrets = ["agent_runtime_internal_token", "approval_signing_key", "evidence_s3_access_key", "evidence_s3_secret_key", "mfa_encryption_key", "model_gateway_api_key", "resend_api_key", "supabase_anon_key", "supabase_service_key", "supabase_statutory_proof_writer_key", "supabase_archive_writer_key", "supabase_human_action_writer_key", "supabase_evidence_ingestion_writer_key", "supabase_agent_ledger_writer_key"]
    }
    web = {
      suffix  = "web"
      secrets = ["supabase_anon_key"]
    }
    agent_runtime = {
      suffix  = "runtime"
      secrets = ["agent_runtime_internal_token", "approval_signing_key", "evidence_s3_access_key", "evidence_s3_secret_key", "model_gateway_api_key", "supabase_anon_key", "supabase_agent_ledger_writer_key", "supabase_service_key"]
    }
    model_gateway = {
      suffix  = "model"
      secrets = ["anthropic_api_key", "gemini_api_key", "model_gateway_api_key", "openai_api_key", "upstash_redis_url"]
    }
    temporal_worker = {
      suffix  = "temporal"
      secrets = ["temporal_api_key", "agent_runtime_internal_token"]
    }
    marketing = {
      suffix  = "marketing"
      secrets = ["supabase_anon_key"]
    }
    supabase_auth = {
      suffix  = "auth"
      secrets = ["gotrue_db_url", "supabase_jwt_secret"]
    }
    supabase_rest = {
      suffix  = "rest"
      secrets = ["db_url", "supabase_jwt_secret"]
    }
    supabase_gateway = {
      suffix  = "gateway"
      secrets = []
    }
  }
  runtime_secret_access = merge([
    for service, configuration in local.runtime_services : {
      for secret in configuration.secrets : "${service}:${secret}" => {
        service = service
        secret  = secret
      }
    }
  ]...)
}

resource "google_service_account" "runtime" {
  for_each     = local.runtime_services
  account_id   = "axiom-${var.environment}-${each.value.suffix}"
  display_name = "Axiom Proof ${var.environment} ${each.key}"
  depends_on   = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "runtime_access" {
  for_each  = local.runtime_secret_access
  project   = var.project_id
  secret_id = google_secret_manager_secret.secret[each.value.secret].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.service].email}"
}

resource "google_secret_manager_secret_iam_member" "mfa_previous_access" {
  count     = length(google_secret_manager_secret.mfa_previous_keys)
  project   = var.project_id
  secret_id = google_secret_manager_secret.mfa_previous_keys[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime["bff"].email}"
}

# Runtime services do not pull deployment images: the deployer/Cloud Run service
# agent handles image import. Current DB URLs use password-authenticated TCP,
# not the Cloud SQL Auth Proxy or IAM DB authentication. Do not copy the old
# project-wide artifactregistry.reader / cloudsql.client roles onto each worker.
# A future IAM connector must add narrowly scoped permissions for its own path.

# Allow public invocations on Web App and Marketing services
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "marketing_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.marketing.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "bff_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.bff.name
  role     = "roles/run.invoker"
  member   = "allUsers" # Public for API endpoints & CORS
}

resource "google_cloud_run_v2_service_iam_member" "agent_runtime_public" {
  count    = var.internal_services_private ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.agent_runtime.name
  role     = "roles/run.invoker"
  member   = "allUsers" # Only when internal_services_private = false; protected by X-Internal-Token
}

resource "google_cloud_run_v2_service_iam_member" "model_gateway_public" {
  count    = var.internal_services_private ? 0 : 1
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.model_gateway.name
  role     = "roles/run.invoker"
  member   = "allUsers" # Only when internal_services_private = false; protected by bearer token
}

# ─── Internal services: only the named callers may invoke ─────────────────────
# With internal_services_private (default) agent-runtime and model-gateway take
# traffic only from inside the VPC and only from these runtime identities. The
# shared token headers stay as a second check. Callers add a Google ID token in
# X-Serverless-Authorization (see the service-auth helpers in each service).
locals {
  internal_invokers = {
    agent_runtime = ["bff", "temporal_worker"]
    model_gateway = ["agent_runtime"]
  }
}

resource "google_cloud_run_v2_service_iam_member" "agent_runtime_invoker" {
  for_each = var.internal_services_private ? toset(local.internal_invokers.agent_runtime) : toset([])
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.agent_runtime.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

resource "google_cloud_run_v2_service_iam_member" "model_gateway_invoker" {
  for_each = var.internal_services_private ? toset(local.internal_invokers.model_gateway) : toset([])
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.model_gateway.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.runtime[each.key].email}"
}
