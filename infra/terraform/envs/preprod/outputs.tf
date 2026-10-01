# ==============================================================================
# Axiom Proof — Preprod Deployment Outputs
# ==============================================================================

output "project_id" {
  description = "GCP Project ID"
  value       = var.project_id
}

output "region" {
  description = "GCP Region (Domestic Mumbai)"
  value       = var.region
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL PostgreSQL Instance Connection Name"
  value       = google_sql_database_instance.postgres.connection_name
}

output "cloud_sql_public_ip" {
  description = "Cloud SQL Public IP address"
  value       = google_sql_database_instance.postgres.public_ip_address
}

output "evidence_vault_bucket" {
  description = "Operator-provided ap-south-1 S3 Object Lock Compliance bucket"
  value       = var.evidence_bucket
}

output "evidence_s3_endpoint" {
  description = "Approved ap-south-1 S3 evidence endpoint"
  value       = var.evidence_endpoint
}

output "artifact_registry_repo" {
  description = "Google Artifact Registry Docker Repository URI"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker_repo.name}"
}

# Cloud Run URLs
output "bff_url" {
  description = "Cloud Run BFF API Service URL"
  value       = "https://axiom-bff-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
}

output "web_url" {
  description = "Cloud Run Web Application URL"
  value       = "https://axiom-web-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
}

output "agent_runtime_url" {
  description = "Cloud Run Agent Runtime Service URL"
  value       = "https://axiom-agent-runtime-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
}

output "model_gateway_url" {
  description = "Cloud Run Model Gateway Service URL"
  value       = "https://axiom-model-gateway-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
}

output "marketing_url" {
  description = "Cloud Run Marketing Container URL"
  value       = "https://axiom-marketing-${var.environment}-${data.google_project.project.number}.${var.region}.run.app"
}

# ─── Self-hosted Supabase (W0.1) ──────────────────────────────────────────────
output "supabase_url" {
  description = "The single origin SUPABASE_URL must be set to. Serves /auth/v1 and /rest/v1."
  value       = google_cloud_run_v2_service.supabase_gateway.uri
}

output "supabase_auth_url" {
  description = "GoTrue's own Cloud Run URL. Behind the gateway; not what clients use."
  value       = google_cloud_run_v2_service.supabase_auth.uri
}

output "supabase_rest_url" {
  description = "PostgREST's own Cloud Run URL. Behind the gateway; not what clients use."
  value       = google_cloud_run_v2_service.supabase_rest.uri
}
