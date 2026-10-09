variable "project_id" {
  type = string
}
variable "environment" {
  type    = string
  default = "preprod"
  validation {
    condition     = var.environment == "preprod"
    error_message = "This isolated marketing profile is preprod only."
  }
}
variable "region" {
  type    = string
  default = "asia-south1"
  validation {
    condition     = var.region == "asia-south1"
    error_message = "Marketing preprod data must remain in Mumbai."
  }
}
variable "release_sha" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.release_sha))
    error_message = "Supply the exact reviewed release SHA."
  }
}
variable "images" {
  description = "Only marketing,bff,auth,rest,gateway; immutable reviewed registry digests."
  type        = map(string)
  validation {
    condition     = toset(keys(var.images)) == toset(["marketing", "bff", "auth", "rest", "gateway"]) && alltrue([for image in values(var.images) : can(regex("^asia-south1-docker\\.pkg\\.dev/[^/]+/[^/]+/[^@]+@sha256:[a-f0-9]{64}$", image))])
    error_message = "Exactly five immutable Mumbai registry image digests are required."
  }
}
variable "firebase_origin" {
  description = "Actual Firebase Hosting HTTPS origin, configured by the separate hosting deployment."
  type        = string
  validation {
    condition     = can(regex("^https://[a-z0-9.-]+$", var.firebase_origin))
    error_message = "Supply the actual HTTPS Hosting origin without a path or trailing slash."
  }
}
variable "service_env" {
  description = "Explicit nonsecret app configuration; profile-owned network/origin/identity keys take precedence."
  type        = map(map(string))
  default     = {}
  validation {
    condition     = alltrue([for key in keys(var.service_env) : contains(["marketing", "bff", "auth", "rest", "gateway"], key)])
    error_message = "Only the five marketing service components may be configured."
  }
}
variable "service_secrets" {
  description = "Existing env-specific Secret Manager secret IDs and exact versions by service/env key. Bootstrap DB role URLs after private SQL is provisioned; never put secret values in env."
  type        = map(map(object({ secret = string, version = string })))
  validation {
    condition     = alltrue([for key in keys(var.service_secrets) : contains(["marketing", "bff", "auth", "rest", "gateway"], key)]) && alltrue(flatten([for secrets in values(var.service_secrets) : [for ref in values(secrets) : length(ref.secret) > 0]]))
    error_message = "Use explicit secret IDs/versions for the five services."
  }
}

variable "cloud_sql_instance_name" {
  type = string
}

variable "cloud_sql_database_name" {
  type = string
}

variable "cloud_sql_tier" {
  type = string
}

variable "cloud_sql_disk_size_gb" {
  type = number
}

variable "cloud_sql_database_version" {
  type = string
}

variable "subnet_cidr" {
  type = string
}

variable "sql_range_prefix_length" {
  type = number
}

variable "cloud_sql_backup_enabled" {
  type = bool
}

variable "cloud_sql_backup_retention" {
  type = number
}

variable "cloud_sql_pitr_enabled" {
  type = bool
}

variable "cloud_sql_admin_user" {
  type = string
}

variable "network_name" {
  type = string
}

variable "subnetwork_name" {
  type = string
}

variable "sql_range_name" {
  type = string
}

variable "min_instance_count" {
  type = number
}

variable "max_instance_count" {
  type = number
}

variable "service_names" {
  type = map(string)
}

variable "service_account_ids" {
  type = map(string)
}

variable "service_settings" {
  type = map(object({ cpu = string, memory = string, port = number }))
}

variable "cloud_sql_admin_password" {
  type      = string
  sensitive = true
  validation {
    condition     = length(var.cloud_sql_admin_password) >= 32
    error_message = "An env-sourced protected database bootstrap password of at least32 characters is required."
  }
}

variable "deploy_services" {
  description = "Env-derived phase switch: false provisions SQL, accounts and secret IDs only; true requires bootstrapped roles/migrations and exact materialized secret versions."
  type        = bool
}
variable "migration_account_id" {
  type    = string
  default = ""
  validation {
    condition     = var.migration_account_id == "" || (length(var.migration_account_id) <= 30 && can(regex("^axiom-proof-preprod-[a-z0-9-]+$", var.migration_account_id)))
    error_message = "Dedicated migration identity must follow the preprod convention within30 characters."
  }
}
variable "bootstrap_secrets" {
  type    = map(string)
  default = {}
  validation {
    condition     = length(var.bootstrap_secrets) == 0 || (toset(keys(var.bootstrap_secrets)) == toset(["admin_db_url", "auth_password", "rest_password"]) && length(toset(values(var.bootstrap_secrets))) == 3 && alltrue([for secret in values(var.bootstrap_secrets) : can(regex("^axiom-proof-preprod-[a-z0-9-]+$", secret))]))
    error_message = "Three distinct exact preprod bootstrap secret IDs required."
  }
}

# Optional lifecycle resources are separate from the five core image map.
variable "lifecycle_image" {
  type    = string
  default = ""
  validation {
    condition     = var.lifecycle_image == "" || can(regex("^asia-south1-docker\\.pkg\\.dev/[a-z0-9-]+/[a-z0-9-]+/[a-z0-9-]+@sha256:[a-f0-9]{64}$", var.lifecycle_image))
    error_message = "Lifecycle image must be empty or an immutable Mumbai Artifact Registry digest."
  }
}
variable "lifecycle_service_name" {
  type    = string
  default = ""
}
variable "lifecycle_controller_account_id" {
  type    = string
  default = ""
}
variable "lifecycle_scheduler_account_id" {
  type    = string
  default = ""
}
variable "lifecycle_scheduler_name" {
  type    = string
  default = ""
}
variable "lifecycle_sql_role_id" {
  type    = string
  default = ""
}
variable "lifecycle_state_role_id" {
  type    = string
  default = ""
}
variable "lifecycle_state_bucket" {
  type    = string
  default = ""
}
variable "lifecycle_state_object" {
  type    = string
  default = ""
}
variable "lifecycle_target_manifest_sha256" {
  type    = string
  default = ""
}
variable "lifecycle_state_initialized" {
  type    = bool
  default = false
}
variable "lifecycle_seed_generation" {
  type    = string
  default = ""
}
variable "lifecycle_seed_target_sha256" {
  type    = string
  default = ""
}
variable "lifecycle_request_seconds" {
  type    = number
  default = 25
}
variable "lifecycle_lease_seconds" {
  type    = number
  default = 120
}
variable "lifecycle_idle_seconds" {
  type    = number
  default = 900
}
variable "lifecycle_scheduler_schedule" {
  type    = string
  default = "*/5 * * * *"
}
variable "lifecycle_scheduler_time_zone" {
  type    = string
  default = "UTC"
}
variable "lifecycle_scheduler_paused" {
  type    = bool
  default = true
}
# Driver consumes a protected local proof; its path is never placed in Run env.
variable "lifecycle_acceptance_manifest_path" {
  type    = string
  default = ""
}
variable "lifecycle_acceptance_manifest_sha256" {
  type    = string
  default = ""
}
variable "lifecycle_settings" {
  type    = object({ cpu = string, memory = string, port = number, concurrency = number })
  default = { cpu = "1", memory = "256Mi", port = 8080, concurrency = 8 }
  validation {
    condition     = var.lifecycle_settings.cpu == "1" && var.lifecycle_settings.memory == "256Mi" && var.lifecycle_settings.port == 8080 && var.lifecycle_settings.concurrency >= 1 && var.lifecycle_settings.concurrency <= 8 && floor(var.lifecycle_settings.concurrency) == var.lifecycle_settings.concurrency
    error_message = "Lifecycle requires the approved1 CPU/256Mi/8080 budget and1..8 integer concurrency."
  }
}
