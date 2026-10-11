terraform {
  required_providers { google = { source = "hashicorp/google" } }
}
variable "name" { type = string }
variable "project_id" { type = string }
variable "region" { type = string }
variable "image" { type = string }
variable "port" { type = number }
variable "network" { type = string }
variable "subnetwork" { type = string }
variable "env" { type = map(string) }
variable "secrets" { type = map(object({ secret = string, version = string })) }
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = toset([for ref in values(var.secrets) : ref.secret])
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.service_account_email}"
}
resource "google_cloud_run_v2_service" "request" {
  name     = var.name
  location = var.region
  ingress  = var.ingress
  template {
    service_account       = var.service_account_email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    timeout               = "300s"
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
    vpc_access {
      network_interfaces {
        network    = var.network
        subnetwork = var.subnetwork
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
    containers {
      image = var.image
      ports { container_port = var.port }
      resources {
        cpu_idle          = true
        startup_cpu_boost = true
        limits            = { cpu = var.cpu, memory = var.memory }
      }
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.secrets
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret
              version = env.value.version
            }
          }
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = length(setintersection(toset(keys(var.env)), toset(keys(var.secrets)))) == 0
      error_message = "A managed plaintext environment key cannot be overridden through a secret entry."
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.runtime]
}
# Explicit callers only. The marketing gateway retains Supabase JWT/RLS
# and supplies separate Cloud Run identity tokens to its private REST upstream.
resource "google_cloud_run_v2_service_iam_member" "invoke" {
  for_each = var.invokers
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.request.name
  role     = "roles/run.invoker"
  member   = each.value
}
output "uri" { value = google_cloud_run_v2_service.request.uri }
output "name" { value = google_cloud_run_v2_service.request.name }
output "request_contract" {
  value = {
    name            = google_cloud_run_v2_service.request.name
    ingress         = google_cloud_run_v2_service.request.ingress
    invokers        = var.invokers
    min_instances   = google_cloud_run_v2_service.request.template[0].scaling[0].min_instance_count
    max_instances   = google_cloud_run_v2_service.request.template[0].scaling[0].max_instance_count
    request_billing = google_cloud_run_v2_service.request.template[0].containers[0].resources[0].cpu_idle
    egress          = google_cloud_run_v2_service.request.template[0].vpc_access[0].egress
    env             = tomap({ for entry in google_cloud_run_v2_service.request.template[0].containers[0].env : entry.name => entry.value if entry.value != null })
  }
}

variable "service_account_email" { type = string }
variable "cpu" { type = string }
variable "memory" { type = string }
variable "min_instances" { type = number }
variable "max_instances" { type = number }
variable "invokers" { type = map(string) }

variable "ingress" {
  type    = string
  default = "INGRESS_TRAFFIC_ALL"
  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_ONLY"], var.ingress)
    error_message = "Reviewed request ingress must be ALL or bootstrap INTERNAL_ONLY."
  }
}
