# ==============================================================================
# Axiom Proof — Cloud Run v2 Microservices Deployments (asia-south1)
# ==============================================================================

locals {
  image_prefix      = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker_repo.name}"
  bff_service_url   = "https://axiom-bff-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
  web_service_url   = "https://axiom-web-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
  agent_runtime_url = "https://axiom-agent-runtime-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
  model_gateway_url = "https://axiom-model-gateway-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
  marketing_url     = "https://axiom-marketing-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
  # Was a hard-coded hostname that nothing in this Terraform provisioned. It
  # now points at the gateway in supabase.tf, which is a resource that exists.
  supabase_preprod_url = local.supabase_gateway_url
}

# ─── 1. BFF (API Gateway & Execution Gate) ───────────────────────────────────
resource "google_cloud_run_v2_service" "bff" {
  name     = "axiom-bff-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime["bff"].email

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    scaling {
      min_instance_count = 1
      max_instance_count = 2
    }

    containers {
      image = "${local.image_prefix}/axiom-bff:${var.environment}"

      resources {
        limits = {
          cpu    = "1"   # "2"
          memory = "1Gi" # "2Gi"
        }
      }

      ports {
        container_port = 4000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "AXIOM_REGION"
        value = var.region
      }
      env {
        name  = "AWS_REGION"
        value = var.region
      }
      env {
        name  = "BFF_PORT"
        value = "4000"
      }
      env {
        name  = "AGENT_RUNTIME_URL"
        value = local.agent_runtime_url
      }
      env {
        name  = "MODEL_GATEWAY_URL"
        value = local.model_gateway_url
      }
      env {
        name  = "AXIOM_ASSESSMENT_DISPATCH_RETENTION_DAYS"
        value = tostring(var.assessment_dispatch_retention_days)
      }
      env {
        name  = "BFF_CORS_ORIGINS"
        value = "${local.marketing_url},${local.web_service_url},https://axiomproof.ai,https://app.axiomproof.ai,https://preprod.axiomproof.ai,https://preprod-app.axiomproof.ai,http://localhost:3000,http://localhost:3001"
      }
      env {
        name  = "AXIOM_EVIDENCE_BUCKET"
        value = google_storage_bucket.evidence_vault.name
      }
      env {
        name  = "AXIOM_STORAGE_ENDPOINT"
        value = "https://storage.googleapis.com"
      }
      env {
        name  = "AWS_S3_EVIDENCE_BUCKET"
        value = google_storage_bucket.evidence_vault.name
      }
      env {
        name  = "AWS_S3_ENDPOINT"
        value = "https://storage.googleapis.com"
      }
      env {
        name  = "SUPABASE_URL"
        value = local.supabase_preprod_url
      }
      env {
        name = "SUPABASE_ANON_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["supabase_anon_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SUPABASE_SERVICE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["supabase_service_key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "AXIOM_MFA_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["mfa_encryption_key"].secret_id
            version = "latest"
          }
        }
      }

      # The retiring half of the ring, present only while a rotation is in
      # flight. A `dynamic` block is what makes absence expressible: a plain
      # `env` pointing at a secret with no versions would fail the deploy in
      # the ordinary case, which is no rotation at all. Iterating the resource
      # itself means the condition lives in one place — secrets.tf — instead of
      # being restated here and drifting.
      dynamic "env" {
        for_each = google_secret_manager_secret.mfa_previous_keys
        content {
          name = "AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS"
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = "latest"
            }
          }
        }
      }
      # Secrets
      env {
        name = "APPROVAL_SIGNING_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["approval_signing_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AGENT_RUNTIME_INTERNAL_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["agent_runtime_internal_token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MODEL_GATEWAY_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["model_gateway_api_key"].secret_id
            version = "latest"
          }
        }
      }


      env {
        name = "AXIOM_STORAGE_ACCESS_KEY_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gcs_hmac_access_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AXIOM_STORAGE_SECRET_ACCESS_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gcs_hmac_secret_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AWS_ACCESS_KEY_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gcs_hmac_access_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AWS_SECRET_ACCESS_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gcs_hmac_secret_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "AXIOM_REPORT_EMAIL_MODE"
        value = var.report_email_mode
      }
      env {
        name = "RESEND_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["resend_api_key"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 4000
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 3
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.version,
    google_secret_manager_secret_version.mfa_previous_keys,
    google_secret_manager_secret_iam_member.runtime_access,
    google_secret_manager_secret_iam_member.mfa_previous_access,
  ]
}

# ─── 2. Web App (Compliance Workbench & Approval Console) ───────────────────
resource "google_cloud_run_v2_service" "web" {
  name     = "axiom-web-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime["web"].email

    scaling {
      min_instance_count = 1
      max_instance_count = 2
    }

    containers {
      image = "${local.image_prefix}/axiom-web:${var.environment}"

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
      }

      ports {
        container_port = 3001
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "NEXT_TELEMETRY_DISABLED"
        value = "1"
      }
      env {
        name  = "BFF_PUBLIC_URL"
        value = local.bff_service_url
      }
      env {
        name  = "NEXT_PUBLIC_BFF_URL"
        value = local.bff_service_url
      }
      env {
        name  = "NEXT_PUBLIC_SUPABASE_URL"
        value = local.supabase_preprod_url
      }
      env {
        name = "NEXT_PUBLIC_SUPABASE_ANON_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["supabase_anon_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "SUPABASE_URL"
        value = local.supabase_preprod_url
      }
      env {
        name = "SUPABASE_ANON_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["supabase_anon_key"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/api/health"
          port = 3001
        }
        initial_delay_seconds = 15
        period_seconds        = 10
        failure_threshold     = 3
      }
    }
  }

  depends_on = [
    google_cloud_run_v2_service.bff,
    google_secret_manager_secret_iam_member.runtime_access,
    google_secret_manager_secret_iam_member.mfa_previous_access,
    google_secret_manager_secret_version.version,
    google_secret_manager_secret_version.mfa_previous_keys,
  ]
}

# ─── 3. Agent Runtime (10 Compliance Agents Fleet) ──────────────────────────
resource "google_cloud_run_v2_service" "agent_runtime" {
  name     = "axiom-agent-runtime-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL" # Invoked by BFF

  template {
    service_account = google_service_account.runtime["agent_runtime"].email

    scaling {
      min_instance_count = 1
      max_instance_count = 2
    }

    containers {
      image = "${local.image_prefix}/axiom-agent-runtime:${var.environment}"

      resources {
        limits = {
          cpu    = "1"   # "2"
          memory = "2Gi" # "4Gi"
        }
      }

      ports {
        container_port = 8000
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "AXIOM_REGION"
        value = var.region
      }
      env {
        name  = "AWS_REGION"
        value = var.region
      }
      env {
        name  = "MODEL_GATEWAY_URL"
        value = local.model_gateway_url
      }
      env {
        name  = "AXIOM_EVIDENCE_BUCKET"
        value = google_storage_bucket.evidence_vault.name
      }
      env {
        name  = "AXIOM_STORAGE_ENDPOINT"
        value = "https://storage.googleapis.com"
      }
      env {
        name  = "S3_EVIDENCE_BUCKET"
        value = google_storage_bucket.evidence_vault.name
      }
      env {
        name  = "S3_ENDPOINT"
        value = "https://storage.googleapis.com"
      }

      env {
        name  = "SUPABASE_URL"
        value = local.supabase_preprod_url
      }
      env {
        name = "SUPABASE_SERVICE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["supabase_service_key"].secret_id
            version = "latest"
          }
        }
      }

      # Secrets
      env {
        name = "AGENT_RUNTIME_INTERNAL_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["agent_runtime_internal_token"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "APPROVAL_SIGNING_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["approval_signing_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "MODEL_GATEWAY_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["model_gateway_api_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AXIOM_STORAGE_ACCESS_KEY_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gcs_hmac_access_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AXIOM_STORAGE_SECRET_ACCESS_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gcs_hmac_secret_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AWS_ACCESS_KEY_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gcs_hmac_access_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AWS_SECRET_ACCESS_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gcs_hmac_secret_key"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8000
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 3
      }
    }
  }

  depends_on = [
    google_cloud_run_v2_service.model_gateway,
    google_secret_manager_secret_iam_member.runtime_access,
    google_secret_manager_secret_iam_member.mfa_previous_access,
    google_secret_manager_secret_version.version,
    google_secret_manager_secret_version.mfa_previous_keys,
  ]
}

# ─── 4. Model Gateway (PII Redactor & Multi-Model Fallback Chain) ───────────
resource "google_cloud_run_v2_service" "model_gateway" {
  name     = "axiom-model-gateway-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime["model_gateway"].email

    scaling {
      min_instance_count = 0 # 1
      max_instance_count = 2 # 5
    }

    containers {
      image = "${local.image_prefix}/axiom-model-gateway:${var.environment}"

      resources {
        limits = {
          cpu    = "1"   # "2"
          memory = "2Gi" # "4Gi"
        }
      }

      ports {
        container_port = 8001
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "AXIOM_REGION"
        value = var.region
      }
      env {
        name  = "AWS_REGION"
        value = var.region
      }
      env {
        name  = "PII_REDACTION_ENABLED"
        value = "true"
      }

      # Secrets for Multi-Model Fallback Chain:
      env {
        name = "API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["model_gateway_api_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "ANTHROPIC_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["anthropic_api_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["openai_api_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["gemini_api_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "REDIS_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["upstash_redis_url"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8001
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 3
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.version,
    google_secret_manager_secret_iam_member.runtime_access,
    google_secret_manager_secret_iam_member.mfa_previous_access,
    google_secret_manager_secret_version.mfa_previous_keys,
  ]
}

# ─── 5. Temporal Worker (Durable Orchestration on GCP) ──────────────────────
resource "google_cloud_run_v2_service" "temporal_worker" {
  name     = "axiom-temporal-worker-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.runtime["temporal_worker"].email

    scaling {
      min_instance_count = 0 # 1
      max_instance_count = 2 # 3
    }

    containers {
      image = "${local.image_prefix}/axiom-temporal-worker:${var.environment}"

      resources {
        limits = {
          cpu    = "1"   # "1"
          memory = "1Gi" # "2Gi"
        }
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }
      env {
        name = "AGENT_RUNTIME_INTERNAL_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["agent_runtime_internal_token"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "TEMPORAL_ADDRESS"
        value = var.temporal_address
      }
      env {
        name  = "TEMPORAL_NAMESPACE"
        value = var.temporal_namespace
      }
      env {
        name  = "TEMPORAL_TLS"
        value = "true"
      }
      env {
        name  = "AGENT_RUNTIME_URL"
        value = local.agent_runtime_url
      }

      env {
        name = "TEMPORAL_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["temporal_api_key"].secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 3
      }
    }
  }

  depends_on = [
    google_cloud_run_v2_service.agent_runtime,
    google_secret_manager_secret_iam_member.runtime_access,
    google_secret_manager_secret_iam_member.mfa_previous_access,
    google_secret_manager_secret_version.version,
    google_secret_manager_secret_version.mfa_previous_keys,
  ]
}

# ─── 6. Marketing Container (Cloud Run deployment option) ───────────────────
resource "google_cloud_run_v2_service" "marketing" {
  name     = "axiom-marketing-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime["marketing"].email

    scaling {
      min_instance_count = 0 # 1
      max_instance_count = 2 # 5
    }

    containers {
      image = "${local.image_prefix}/axiom-marketing:${var.environment}"

      resources {
        limits = {
          cpu    = "1"     # "1"
          memory = "512Mi" # "1Gi"      
        }
      }

      ports {
        container_port = 3000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "NEXT_TELEMETRY_DISABLED"
        value = "1"
      }
      env {
        name  = "BFF_PUBLIC_URL"
        value = local.bff_service_url
      }
      env {
        name  = "NEXT_PUBLIC_BFF_URL"
        value = local.bff_service_url
      }
      env {
        name  = "NEXT_PUBLIC_APP_URL"
        value = local.web_service_url
      }
      env {
        name  = "APP_URL"
        value = local.web_service_url
      }
      env {
        name  = "NEXT_PUBLIC_SUPABASE_URL"
        value = local.supabase_preprod_url
      }
      env {
        name = "NEXT_PUBLIC_SUPABASE_ANON_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["supabase_anon_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "SUPABASE_URL"
        value = local.supabase_preprod_url
      }
      env {
        name = "SUPABASE_ANON_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["supabase_anon_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "RESEND_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret["resend_api_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "CONTACT_RECIPIENT_EMAIL"
        value = var.contact_recipient_email
      }
      env {
        name  = "AXIOM_FROM_EMAIL"
        value = var.axiom_from_email
      }
      env {
        name  = "RESEND_FROM_EMAIL"
        value = var.axiom_from_email
      }
      env {
        name  = "AXIOM_SALES_EMAIL"
        value = var.axiom_sales_email
      }
      env {
        name  = "AXIOM_FOUNDER_EMAIL"
        value = var.axiom_founder_email
      }

      startup_probe {
        http_get {
          path = "/api/health"
          port = 3000
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 3
      }
    }
  }

  depends_on = [
    google_cloud_run_v2_service.bff,
    google_cloud_run_v2_service.web,
    google_secret_manager_secret_iam_member.runtime_access,
    google_secret_manager_secret_iam_member.mfa_previous_access,
    google_secret_manager_secret_version.version,
    google_secret_manager_secret_version.mfa_previous_keys,
  ]
}
