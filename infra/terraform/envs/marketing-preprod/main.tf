locals { prefix = "axiom-proof-${var.environment}" }
resource "google_project_service" "apis" {
  for_each           = toset(["run.googleapis.com", "compute.googleapis.com", "sqladmin.googleapis.com", "servicenetworking.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com", "cloudscheduler.googleapis.com", "iam.googleapis.com"])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
resource "google_compute_network" "marketing" {
  name                    = var.network_name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}
resource "google_compute_subnetwork" "run" {
  name                     = var.subnetwork_name
  region                   = var.region
  network                  = google_compute_network.marketing.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}
resource "google_compute_global_address" "sql" {
  name          = var.sql_range_name
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.sql_range_prefix_length
  network       = google_compute_network.marketing.id
}
resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.marketing.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql.name]
}
resource "google_sql_database_instance" "marketing" {
  name                = var.cloud_sql_instance_name
  region              = var.region
  database_version    = var.cloud_sql_database_version
  deletion_protection = true
  settings {
    tier              = var.cloud_sql_tier
    availability_type = "ZONAL"
    disk_size         = var.cloud_sql_disk_size_gb
    disk_type         = "PD_SSD"
    disk_autoresize   = false
    activation_policy = "ALWAYS"
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.marketing.id
    }
    backup_configuration {
      enabled                        = var.cloud_sql_backup_enabled
      point_in_time_recovery_enabled = var.cloud_sql_pitr_enabled
      backup_retention_settings {
        retained_backups = var.cloud_sql_backup_retention
        retention_unit   = "COUNT"
      }
    }
  }
  depends_on = [google_service_networking_connection.sql]
  # A future reviewed controller owns activation, never a schedule alone.
  lifecycle { ignore_changes = [settings[0].activation_policy] }
}
resource "google_sql_database" "marketing" {
  name     = var.cloud_sql_database_name
  instance = google_sql_database_instance.marketing.name
}
resource "terraform_data" "configuration" {
  input = var.release_sha
  lifecycle {
    precondition {
      condition     = !var.deploy_services || (var.lifecycle_image != "" && startswith(var.lifecycle_image, "${var.region}-docker.pkg.dev/${var.project_id}/"))
      error_message = "Marketing backend requires its reviewed private lifecycle controller image; gate-less service deployment is refused."
    }
    precondition {
      condition     = try(var.service_settings.gateway.port == 8080, false) && alltrue([for settings in values(var.service_settings) : settings.port > 0 && settings.port < 65536 && contains(["1", "2", "4", "8"], settings.cpu) && can(regex("^[1-9][0-9]*(Mi|Gi)$", settings.memory))]) && alltrue([for account in values(var.service_account_ids) : length(account) <= 30])
      error_message = "The reviewed nginx image listens8080; require valid explicit service ports/resources and service account IDs within30 characters."
    }
    precondition {
      condition     = !var.deploy_services || alltrue(flatten([for secrets in values(var.service_secrets) : [for ref in values(secrets) : can(regex("^[1-9][0-9]*$", ref.version))]]))
      error_message = "Request service deployment needs actual materialized numeric secret versions; base provisioning may leave versions empty."
    }
    precondition {
      condition     = var.cloud_sql_tier == "db-f1-micro" && var.cloud_sql_disk_size_gb == 10 && var.cloud_sql_database_version == "POSTGRES_15" && var.cloud_sql_backup_retention == 7 && !var.cloud_sql_pitr_enabled && var.min_instance_count == 0 && var.max_instance_count == 1
      error_message = "This profile requires env-supplied micro10GB PostgreSQL15, seven backups/noPITR and request scaling0..1."
    }
    precondition {
      condition     = can(cidrnetmask(var.subnet_cidr)) && var.sql_range_prefix_length >= 16 && var.sql_range_prefix_length <= 24 && alltrue([for name in concat([var.cloud_sql_instance_name, var.network_name, var.subnetwork_name, var.sql_range_name], values(var.service_names), values(var.service_account_ids)) : can(regex("^axiom-proof-preprod-[a-z0-9-]+$", name))]) && toset(keys(var.service_settings)) == toset(keys(var.images)) && toset(keys(var.service_names)) == toset(keys(var.images)) && toset(keys(var.service_account_ids)) == toset(keys(var.images))
      error_message = "Explicit env-derived network/names/settings must match five components and axiom-proof-preprod naming."
    }
    precondition {
      condition     = try(var.service_secrets.auth.GOTRUE_JWT_SECRET == var.service_secrets.rest.PGRST_JWT_SECRET, false)
      error_message = "GoTrue and PostgREST must reference the same explicit JWT secret and version."
    }
    precondition {
      condition     = alltrue([for image in values(var.images) : startswith(image, "${var.region}-docker.pkg.dev/${var.project_id}/")])
      error_message = "Images must belong to this explicitly selected project and Mumbai registry."
    }
    precondition {
      condition     = alltrue(flatten([for service, required in { auth = ["GOTRUE_DB_DATABASE_URL", "GOTRUE_JWT_SECRET"], rest = ["PGRST_DB_URI", "PGRST_JWT_SECRET"], bff = ["SUPABASE_SERVICE_KEY"] } : [for key in required : contains(keys(lookup(var.service_secrets, service, {})), key)]]))
      error_message = "Explicit Secret Manager role connection URLs, matching JWT secrets and BFF service key are required; bootstrap SQL roles/migrations first."
    }
    precondition {
      condition     = alltrue([for service, secrets in var.service_secrets : length(setintersection(toset(keys(secrets)), toset(keys(lookup(var.service_env, service, {}))))) == 0])
      error_message = "Secret env names must not also be supplied as plaintext environment values."
    }
  }
}

resource "google_sql_user" "bootstrap" {
  name     = var.cloud_sql_admin_user
  instance = google_sql_database_instance.marketing.name
  password = var.cloud_sql_admin_password
}
# IDs and IAM only; .env-backed bootstrap materializes exact payload versions
# after SQL private IP and restricted database roles/migrations are available.
resource "google_secret_manager_secret" "runtime" {
  for_each  = toset(concat(flatten([for secrets in values(var.service_secrets) : [for ref in values(secrets) : ref.secret]]), values(var.bootstrap_secrets)))
  secret_id = each.value
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "runtime" {
  for_each     = var.service_account_ids
  account_id   = each.value
  display_name = var.service_names[each.key]
  depends_on   = [google_project_service.apis]
}
resource "google_service_account" "migration" {
  count        = var.migration_account_id != "" ? 1 : 0
  project      = var.project_id
  account_id   = var.migration_account_id
  display_name = var.migration_account_id
  depends_on   = [google_project_service.apis]
}
resource "google_secret_manager_secret_iam_member" "migration" {
  for_each   = var.migration_account_id != "" ? var.bootstrap_secrets : {}
  project    = var.project_id
  secret_id  = each.value
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${google_service_account.migration[0].email}"
  depends_on = [google_secret_manager_secret.runtime]
}

# The initial admission Job may create/read exactly one state object. It cannot
# overwrite or delete a generation, list the bucket, or mutate live services.
resource "google_project_iam_custom_role" "adoption_state" {
  count       = var.migration_account_id != "" ? 1 : 0
  project     = var.project_id
  role_id     = "${replace(var.migration_account_id, "-", "_")}_seed"
  title       = "Preprod initial state create and read"
  permissions = ["storage.objects.create", "storage.objects.get"]
}
resource "google_storage_bucket_iam_member" "adoption_state" {
  count  = var.migration_account_id != "" ? 1 : 0
  bucket = var.lifecycle_state_bucket
  role   = google_project_iam_custom_role.adoption_state[0].name
  member = "serviceAccount:${google_service_account.migration[0].email}"
  condition {
    title      = "ExactInitialLifecycleObject"
    expression = "resource.name == 'projects/_/buckets/${var.lifecycle_state_bucket}/objects/${var.lifecycle_state_object}'"
  }
}
resource "google_project_iam_custom_role" "adoption_observe" {
  count       = var.migration_account_id != "" ? 1 : 0
  project     = var.project_id
  role_id     = "${replace(var.migration_account_id, "-", "_")}_observe"
  title       = "Preprod initial admission observations"
  permissions = ["run.services.list", "run.services.getIamPolicy", "cloudscheduler.jobs.get", "resourcemanager.projects.get", "resourcemanager.projects.getIamPolicy"]
}
resource "google_project_iam_member" "adoption_observe" {
  count   = var.migration_account_id != "" ? 1 : 0
  project = var.project_id
  role    = google_project_iam_custom_role.adoption_observe[0].name
  member  = "serviceAccount:${google_service_account.migration[0].email}"
}
