# ==============================================================================
# Axiom Proof — Cloud SQL for PostgreSQL (asia-south1 Mumbai)
# ==============================================================================

resource "random_id" "db_suffix" {
  byte_length = 4
  keepers = {
    version = var.cloud_sql_instance_version
  }
}

resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "postgres" {
  name             = "axiom-proof-${var.environment}-pg-${random_id.db_suffix.hex}"
  database_version = "POSTGRES_15"
  region           = var.region
  depends_on       = [google_service_networking_connection.private_vpc_connection]

  settings {
    tier              = var.cloud_sql_tier
    availability_type = "ZONAL" # Single zone in preprod; REGIONAL for HA in prod
    disk_size         = var.cloud_sql_disk_size_gb
    disk_type         = "PD_SSD"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled                                  = length(var.cloud_sql_authorized_networks) > 0
      private_network                               = google_compute_network.vpc.id
      enable_private_path_for_google_cloud_services = true

      dynamic "authorized_networks" {
        for_each = var.cloud_sql_authorized_networks
        content {
          name  = authorized_networks.key
          value = authorized_networks.value
        }
      }
    }

    database_flags {
      name  = "cloudsql.enable_pgaudit"
      value = "on"
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = true
      record_client_address   = true
    }
  }

  deletion_protection = false # preprod environment
}

resource "google_sql_database" "axiom_db" {
  name     = "axiom_proof_${var.environment}"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "axiom_user" {
  name     = "axiom_admin"
  instance = google_sql_database_instance.postgres.name
  password = random_password.db_password.result
}
