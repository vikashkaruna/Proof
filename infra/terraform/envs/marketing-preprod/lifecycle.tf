# State is initialized once by the guarded driver with ifGenerationMatch=0.
# Terraform deliberately does not own an object that contains live leases.
locals {
  lifecycle_enabled    = var.deploy_services && var.lifecycle_image != ""
  lifecycle_acceptance = try(jsondecode(file(var.lifecycle_acceptance_manifest_path)), {})
  lifecycle_target     = { environment = var.environment, project = var.project_id, instance = var.cloud_sql_instance_name, bucket = var.lifecycle_state_bucket, object = var.lifecycle_state_object }
}
resource "google_project_service" "lifecycle" {
  for_each           = local.lifecycle_enabled ? toset(["cloudscheduler.googleapis.com", "storage.googleapis.com", "iam.googleapis.com"]) : toset([])
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}
resource "google_service_account" "lifecycle" {
  count      = local.lifecycle_enabled ? 1 : 0
  project    = var.project_id
  account_id = var.lifecycle_controller_account_id
}
resource "google_service_account" "lifecycle_scheduler" {
  count      = local.lifecycle_enabled ? 1 : 0
  project    = var.project_id
  account_id = var.lifecycle_scheduler_account_id
}
resource "google_project_iam_custom_role" "lifecycle_sql" {
  count       = local.lifecycle_enabled ? 1 : 0
  project     = var.project_id
  role_id     = var.lifecycle_sql_role_id
  title       = "Preprod lifecycle exact SQL instance"
  permissions = ["cloudsql.instances.get", "cloudsql.instances.update"]
}
resource "google_project_iam_member" "lifecycle_sql" {
  count   = local.lifecycle_enabled ? 1 : 0
  project = var.project_id
  role    = google_project_iam_custom_role.lifecycle_sql[0].name
  member  = "serviceAccount:${google_service_account.lifecycle[0].email}"
  condition {
    title      = "ExactPreprodInstance"
    expression = "resource.type == 'sqladmin.googleapis.com/Instance' && resource.name == 'projects/${var.project_id}/instances/${var.cloud_sql_instance_name}'"
  }
}
resource "google_project_iam_custom_role" "lifecycle_state" {
  count   = local.lifecycle_enabled ? 1 : 0
  project = var.project_id
  role_id = var.lifecycle_state_role_id
  title   = "Preprod lifecycle one CAS object"
  # Overwriting a generation requires create and delete; no bucket/list access.
  permissions = ["storage.objects.get", "storage.objects.create", "storage.objects.delete"]
}
resource "google_storage_bucket_iam_member" "lifecycle_state" {
  count  = local.lifecycle_enabled ? 1 : 0
  bucket = var.lifecycle_state_bucket
  role   = google_project_iam_custom_role.lifecycle_state[0].name
  member = "serviceAccount:${google_service_account.lifecycle[0].email}"
  condition {
    title      = "ExactLifecycleStateObject"
    expression = "resource.name == 'projects/_/buckets/${var.lifecycle_state_bucket}/objects/${var.lifecycle_state_object}'"
  }
}
resource "google_cloud_run_v2_service" "lifecycle" {
  count    = local.lifecycle_enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = var.lifecycle_service_name
  # Authentication is IAM-only. Public clients receive no invoker grant.
  ingress = "INGRESS_TRAFFIC_ALL"
  template {
    service_account                  = google_service_account.lifecycle[0].email
    timeout                          = "${var.lifecycle_request_seconds}s"
    max_instance_request_concurrency = var.lifecycle_settings.concurrency
    scaling {
      min_instance_count = var.min_instance_count
      max_instance_count = var.max_instance_count
    }
    containers {
      image = var.lifecycle_image
      ports { container_port = var.lifecycle_settings.port }
      resources {
        limits   = { cpu = var.lifecycle_settings.cpu, memory = var.lifecycle_settings.memory }
        cpu_idle = true
      }
      dynamic "env" {
        for_each = {
          ENVIRONMENT                       = var.environment
          GCP_PROJECT_ID                    = var.project_id
          CLOUD_SQL_INSTANCE_NAME           = var.cloud_sql_instance_name
          AXIOM_IDLE_STATE_BUCKET           = var.lifecycle_state_bucket
          AXIOM_IDLE_STATE_OBJECT           = var.lifecycle_state_object
          AXIOM_IDLE_TARGET_MANIFEST        = "/app/approved-target.json"
          AXIOM_IDLE_TARGET_MANIFEST_SHA256 = var.lifecycle_target_manifest_sha256
          AXIOM_IDLE_REQUEST_MAX_SECONDS    = tostring(var.lifecycle_request_seconds)
          AXIOM_IDLE_LEASE_SECONDS          = tostring(var.lifecycle_lease_seconds)
          AXIOM_IDLE_INTERVAL_SECONDS       = tostring(var.lifecycle_idle_seconds)
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = var.environment == "preprod" && var.region == "asia-south1" && startswith(var.lifecycle_image, "asia-south1-docker.pkg.dev/${var.project_id}/") && startswith(var.cloud_sql_instance_name, "${var.project_id}-preprod-") && startswith(var.lifecycle_state_bucket, "${var.project_id}-preprod-state-") && var.lifecycle_state_object == "marketing-preprod/lifecycle/state.json" && alltrue([for n in [var.lifecycle_service_name, var.lifecycle_controller_account_id, var.lifecycle_scheduler_account_id, var.lifecycle_scheduler_name] : startswith(n, "${var.project_id}-preprod-")]) && can(regex("^[a-f0-9]{64}$", var.lifecycle_target_manifest_sha256))
      error_message = "Lifecycle requires the exact approved Mumbai preprod target and immutable image manifest."
    }
    precondition {
      condition     = var.lifecycle_state_initialized && can(regex("^[1-9][0-9]*$", var.lifecycle_seed_generation)) && var.lifecycle_seed_target_sha256 == var.lifecycle_target_manifest_sha256
      error_message = "A guarded create-only state seed proof is required before controller readiness."
    }
    precondition {
      condition     = var.lifecycle_request_seconds >= 1 && var.lifecycle_request_seconds <= 25 && floor(var.lifecycle_request_seconds) == var.lifecycle_request_seconds && var.lifecycle_lease_seconds >= var.lifecycle_request_seconds + 30 && var.lifecycle_lease_seconds <= 300 && floor(var.lifecycle_lease_seconds) == var.lifecycle_lease_seconds && var.lifecycle_idle_seconds >= var.lifecycle_lease_seconds && var.lifecycle_idle_seconds <= 86400 && floor(var.lifecycle_idle_seconds) == var.lifecycle_idle_seconds
      error_message = "Request, lease and idle bounds must match the fail-closed controller contract."
    }
  }
  depends_on = [google_project_service.lifecycle, google_project_iam_member.lifecycle_sql, google_storage_bucket_iam_member.lifecycle_state]
}
resource "google_cloud_run_v2_service_iam_member" "lifecycle" {
  for_each = local.lifecycle_enabled ? { bff = google_service_account.runtime["bff"].email, scheduler = google_service_account.lifecycle_scheduler[0].email } : {}
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.lifecycle[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}
resource "terraform_data" "lifecycle_release" {
  count = local.lifecycle_enabled ? 1 : 0
  lifecycle {
    precondition {
      condition     = var.lifecycle_scheduler_paused || (try(filesha256(var.lifecycle_acceptance_manifest_path), "") == var.lifecycle_acceptance_manifest_sha256 && can(regex("^[a-f0-9]{64}$", var.lifecycle_acceptance_manifest_sha256)) && try(local.lifecycle_acceptance.target, {}) == local.lifecycle_target && try(local.lifecycle_acceptance.target_manifest_sha256, "") == var.lifecycle_target_manifest_sha256 && try(local.lifecycle_acceptance.image, "") == var.lifecycle_image && try(local.lifecycle_acceptance.release_sha, "") == var.release_sha && try(local.lifecycle_acceptance.controller_uri, "") == google_cloud_run_v2_service.lifecycle[0].uri && try(local.lifecycle_acceptance.bff_uri, "") == module.bff[0].uri && try(local.lifecycle_acceptance.exclusive_gate_verified, false) == true && try(local.lifecycle_acceptance.inflight_stop_refused, false) == true && try(local.lifecycle_acceptance.real_wake_verified, false) == true && try(local.lifecycle_acceptance.human_approval_recorded, false) == true)
      error_message = "Scheduler remains paused until exact target/image/release/URI-bound live gate, race, wake and human approval proof is verified."
    }
  }
}
resource "google_cloud_scheduler_job" "lifecycle" {
  count            = local.lifecycle_enabled ? 1 : 0
  project          = var.project_id
  region           = var.region
  name             = var.lifecycle_scheduler_name
  schedule         = var.lifecycle_scheduler_schedule
  time_zone        = var.lifecycle_scheduler_time_zone
  paused           = var.lifecycle_scheduler_paused
  attempt_deadline = "30s"
  retry_config { retry_count = 0 }
  http_target {
    uri         = "${google_cloud_run_v2_service.lifecycle[0].uri}/idle/check"
    http_method = "POST"
    body        = base64encode("{}")
    headers     = { "Content-Type" = "application/json" }
    oidc_token {
      service_account_email = google_service_account.lifecycle_scheduler[0].email
      audience              = google_cloud_run_v2_service.lifecycle[0].uri
    }
  }
  depends_on = [terraform_data.lifecycle_release, google_cloud_run_v2_service_iam_member.lifecycle]
}
