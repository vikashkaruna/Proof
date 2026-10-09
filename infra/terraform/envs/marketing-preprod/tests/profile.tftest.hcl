mock_provider "google" {
  mock_resource "google_compute_network" { defaults = { id = "projects/axiom-proof/global/networks/axiom-proof-preprod-marketing-network" } }
  mock_resource "google_compute_subnetwork" { defaults = { id = "projects/axiom-proof/regions/asia-south1/subnetworks/axiom-proof-preprod-marketing-egress" } }
  mock_resource "google_service_account" { defaults = { email = "fixture@axiom-proof.iam.gserviceaccount.com" } }
  mock_resource "google_cloud_run_v2_service" { defaults = { uri = "https://actual-provider-fixture.run.app" } }
}
variables {
  lifecycle_settings               = { cpu = "1", memory = "256Mi", port = 8080, concurrency = 8 }
  lifecycle_image                  = "asia-south1-docker.pkg.dev/axiom-proof/marketing/lifecycle@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  lifecycle_service_name           = "axiom-proof-preprod-lifecycle"
  lifecycle_controller_account_id  = "axiom-proof-preprod-lifecycle"
  lifecycle_scheduler_account_id   = "axiom-proof-preprod-idle-cron"
  lifecycle_scheduler_name         = "axiom-proof-preprod-idle-check"
  lifecycle_sql_role_id            = "preprodLifecycleSql"
  lifecycle_state_role_id          = "preprodLifecycleState"
  lifecycle_state_bucket           = "axiom-proof-preprod-state-188516662106"
  lifecycle_state_object           = "marketing-preprod/lifecycle/state.json"
  lifecycle_target_manifest_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  lifecycle_state_initialized      = true
  lifecycle_seed_generation        = "1"
  lifecycle_seed_target_sha256     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  deploy_services                  = true
  cloud_sql_instance_name          = "axiom-proof-preprod-postgres"
  cloud_sql_database_name          = "axiom_proof_preprod"
  cloud_sql_tier                   = "db-f1-micro"
  cloud_sql_disk_size_gb           = 10
  cloud_sql_database_version       = "POSTGRES_15"
  subnet_cidr                      = "10.73.0.0/24"
  sql_range_prefix_length          = 24
  cloud_sql_backup_enabled         = true
  cloud_sql_backup_retention       = 7
  cloud_sql_pitr_enabled           = false
  cloud_sql_admin_user             = "axiom_admin"
  cloud_sql_admin_password         = "synthetic-password-only-for-offline-tests"
  network_name                     = "axiom-proof-preprod-marketing-network"
  subnetwork_name                  = "axiom-proof-preprod-marketing-egress"
  sql_range_name                   = "axiom-proof-preprod-marketing-sql-range"
  min_instance_count               = 0
  max_instance_count               = 1
  service_names                    = { marketing = "axiom-proof-preprod-marketing", bff = "axiom-proof-preprod-bff", auth = "axiom-proof-preprod-auth", rest = "axiom-proof-preprod-rest", gateway = "axiom-proof-preprod-gateway" }
  service_account_ids              = { marketing = "axiom-proof-preprod-marketing", bff = "axiom-proof-preprod-bff", auth = "axiom-proof-preprod-auth", rest = "axiom-proof-preprod-rest", gateway = "axiom-proof-preprod-gateway" }
  service_settings                 = { marketing = { cpu = "1", memory = "512Mi", port = 3000 }, bff = { cpu = "1", memory = "512Mi", port = 4000 }, auth = { cpu = "1", memory = "512Mi", port = 9999 }, rest = { cpu = "1", memory = "512Mi", port = 3000 }, gateway = { cpu = "1", memory = "256Mi", port = 8080 } }
  project_id                       = "axiom-proof"
  release_sha                      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  firebase_origin                  = "https://actual-fixture.web.app"
  images                           = { marketing = "asia-south1-docker.pkg.dev/axiom-proof/marketing/marketing@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", bff = "asia-south1-docker.pkg.dev/axiom-proof/marketing/bff@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", auth = "asia-south1-docker.pkg.dev/axiom-proof/marketing/auth@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", rest = "asia-south1-docker.pkg.dev/axiom-proof/marketing/rest@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", gateway = "asia-south1-docker.pkg.dev/axiom-proof/marketing/gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  service_secrets = {
    auth = { GOTRUE_DB_DATABASE_URL = { secret = "axiom-proof-preprod-auth-db", version = "1" }, GOTRUE_JWT_SECRET = { secret = "axiom-proof-preprod-jwt", version = "1" } }
    rest = { PGRST_DB_URI = { secret = "axiom-proof-preprod-rest-db", version = "1" }, PGRST_JWT_SECRET = { secret = "axiom-proof-preprod-jwt", version = "1" } }
    bff  = { SUPABASE_SERVICE_KEY = { secret = "axiom-proof-preprod-service-key", version = "1" } }
  }
}
run "minimum_private_database" {
  command = plan
  assert {
    condition     = google_sql_database_instance.marketing.settings[0].tier == "db-f1-micro" && google_sql_database_instance.marketing.settings[0].disk_size == 10 && !google_sql_database_instance.marketing.settings[0].ip_configuration[0].ipv4_enabled && google_sql_database_instance.marketing.region == "asia-south1"
    error_message = "Dedicated Mumbai DB must be minimum10GB micro and private only."
  }
  assert {
    condition     = google_sql_database_instance.marketing.name == "axiom-proof-preprod-postgres" && google_sql_database_instance.marketing.settings[0].activation_policy == "ALWAYS" && output.idle_automation_enabled == false
    error_message = "Stable naming and no unsafe auto-stop."
  }
}
run "request_scaled_services_and_real_uri_wiring" {
  command = apply
  assert {
    condition     = alltrue([for k, c in output.request_contracts : c.name == "axiom-proof-preprod-${k}" && c.min_instances == 0 && c.max_instances == 1 && c.request_billing && c.egress == "PRIVATE_RANGES_ONLY"])
    error_message = "Every request service must scale0..1 with requestbilling/privateSQLegress."
  }
  assert {
    condition     = output.request_contracts.marketing.env.BFF_URL == module.bff[0].uri && output.request_contracts.bff.env.SUPABASE_URL == module.gateway[0].uri && output.request_contracts.gateway.env.SUPABASE_AUTH_UPSTREAM == module.auth[0].uri && output.request_contracts.gateway.env.SUPABASE_REST_UPSTREAM == module.rest[0].uri
    error_message = "Downstream URLs must derive from real provider resources."
  }
}
run "production_refused" {
  command = plan
  variables { environment = "production" }
  expect_failures = [var.environment]
}
run "other_region_refused" {
  command = plan
  variables { region = "us-central1" }
  expect_failures = [var.region]
}
run "mutable_images_refused" {
  command = plan
  variables { images = { marketing = "unreviewed:latest" } }
  expect_failures = [var.images]
}

run "missing_credentials_refused" {
  command = plan
  variables { service_secrets = {} }
  expect_failures = [terraform_data.configuration]
}
run "plaintext_secret_collision_refused" {
  command = plan
  variables { service_env = { bff = { SUPABASE_SERVICE_KEY = "unsafe-plaintext" } } }
  expect_failures = [terraform_data.configuration]
}

run "jwt_mismatch_refused" {
  command = plan
  variables {
    service_secrets = {
      auth = { GOTRUE_DB_DATABASE_URL = { secret = "axiom-proof-preprod-auth-db", version = "1" }, GOTRUE_JWT_SECRET = { secret = "axiom-proof-preprod-jwt", version = "1" } }
      rest = { PGRST_DB_URI = { secret = "axiom-proof-preprod-rest-db", version = "1" }, PGRST_JWT_SECRET = { secret = "axiom-proof-preprod-other-jwt", version = "1" } }
      bff  = { SUPABASE_SERVICE_KEY = { secret = "axiom-proof-preprod-service-key", version = "1" } }
    }
  }
  expect_failures = [terraform_data.configuration]
}

run "base_phase_without_materialized_payloads" {
  command = apply
  variables {
    deploy_services = false
    service_secrets = {
      auth = { GOTRUE_DB_DATABASE_URL = { secret = "axiom-proof-preprod-auth-db", version = "" }, GOTRUE_JWT_SECRET = { secret = "axiom-proof-preprod-jwt", version = "" } }
      rest = { PGRST_DB_URI = { secret = "axiom-proof-preprod-rest-db", version = "" }, PGRST_JWT_SECRET = { secret = "axiom-proof-preprod-jwt", version = "" } }
      bff  = { SUPABASE_SERVICE_KEY = { secret = "axiom-proof-preprod-service-key", version = "" } }
    }
  }
  assert {
    condition     = length(output.cloud_run_uris) == 0 && length(output.request_contracts) == 0 && length(output.runtime_service_accounts) == 5 && length(output.secret_ids) == 4
    error_message = "Base phase must create SQL/accounts/secretIDs with zero requestservices before bootstrap."
  }
}
run "unmaterialized_versions_refused_when_enabled" {
  command = plan
  variables {
    deploy_services = true
    service_secrets = {
      auth = { GOTRUE_DB_DATABASE_URL = { secret = "axiom-proof-preprod-auth-db", version = "" }, GOTRUE_JWT_SECRET = { secret = "axiom-proof-preprod-jwt", version = "" } }
      rest = { PGRST_DB_URI = { secret = "axiom-proof-preprod-rest-db", version = "" }, PGRST_JWT_SECRET = { secret = "axiom-proof-preprod-jwt", version = "" } }
      bff  = { SUPABASE_SERVICE_KEY = { secret = "axiom-proof-preprod-service-key", version = "" } }
    }
  }
  expect_failures = [terraform_data.configuration]
}
run "larger_cost_profile_refused" {
  command = plan
  variables { cloud_sql_tier = "db-custom-2-7680" }
  expect_failures = [terraform_data.configuration]
}

run "lifecycle_private_paused_request_scaled" {
  command = apply
  assert {
    condition     = google_cloud_run_v2_service.lifecycle[0].template[0].scaling[0].min_instance_count == 0 && google_cloud_run_v2_service.lifecycle[0].template[0].scaling[0].max_instance_count == 1 && google_cloud_run_v2_service.lifecycle[0].template[0].containers[0].resources[0].cpu_idle
    error_message = "Lifecycle must remain request billed and scale0..1."
  }
  assert {
    condition     = toset(keys(google_cloud_run_v2_service_iam_member.lifecycle)) == toset(["bff", "scheduler"]) && alltrue([for grant in google_cloud_run_v2_service_iam_member.lifecycle : startswith(grant.member, "serviceAccount:") && grant.role == "roles/run.invoker"])
    error_message = "Only BFF and scheduler identities may invoke the controller."
  }
  assert {
    condition     = google_cloud_scheduler_job.lifecycle[0].paused && !output.idle_automation_enabled && google_cloud_scheduler_job.lifecycle[0].http_target[0].oidc_token[0].audience == google_cloud_run_v2_service.lifecycle[0].uri
    error_message = "Scheduler requires IAM and must remain paused before real acceptance."
  }
  assert {
    condition     = toset(google_project_iam_custom_role.lifecycle_sql[0].permissions) == toset(["cloudsql.instances.get", "cloudsql.instances.update"]) && google_project_iam_member.lifecycle_sql[0].condition[0].expression == "resource.type == 'sqladmin.googleapis.com/Instance' && resource.name == 'projects/axiom-proof/instances/axiom-proof-preprod-postgres'" && google_storage_bucket_iam_member.lifecycle_state[0].condition[0].expression == "resource.name == 'projects/_/buckets/axiom-proof-preprod-state-188516662106/objects/marketing-preprod/lifecycle/state.json'"
    error_message = "SQL and CAS grants must be constrained to exact approved resources."
  }
  assert {
    condition     = length(output.request_contracts.auth.invokers) == 0 && toset(keys(output.request_contracts.rest.invokers)) == toset(["gateway"]) && toset(keys(output.request_contracts.gateway.invokers)) == toset(["bff"]) && !contains(values(output.request_contracts.rest.invokers), "allUsers") && !contains(values(output.request_contracts.gateway.invokers), "allUsers")
    error_message = "Private DB upstreams must exclusively pass through the gated BFF gateway."
  }
}
run "base_empty_image_no_lifecycle" {
  command = plan
  variables {
    deploy_services             = false
    lifecycle_image             = ""
    lifecycle_state_initialized = false
  }
  assert {
    condition     = length(google_cloud_run_v2_service.lifecycle) == 0 && length(google_cloud_scheduler_job.lifecycle) == 0 && length(google_storage_bucket_iam_member.lifecycle_state) == 0 && output.lifecycle_controller_uri == ""
    error_message = "Base phase must not initialize or mutate lifecycle state."
  }
}
run "unproven_seed_refused" {
  command = plan
  variables { lifecycle_state_initialized = false }
  expect_failures = [google_cloud_run_v2_service.lifecycle]
}
run "different_seed_target_refused" {
  command = plan
  variables { lifecycle_seed_target_sha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  expect_failures = [google_cloud_run_v2_service.lifecycle]
}
run "wrong_state_resource_refused" {
  command = plan
  variables { lifecycle_state_object = "terraform/state.json" }
  expect_failures = [google_cloud_run_v2_service.lifecycle]
}
run "too_short_lease_refused" {
  command = plan
  variables { lifecycle_lease_seconds = 25 }
  expect_failures = [google_cloud_run_v2_service.lifecycle]
}
run "unproven_scheduler_release_refused" {
  command = plan
  variables { lifecycle_scheduler_paused = false }
  expect_failures = [terraform_data.lifecycle_release]
}

run "bound_synthetic_acceptance_releases_scheduler" {
  command = apply
  variables {
    lifecycle_scheduler_paused           = false
    lifecycle_acceptance_manifest_path   = "tests/fixtures/lifecycle-acceptance.synthetic.json"
    lifecycle_acceptance_manifest_sha256 = filesha256("tests/fixtures/lifecycle-acceptance.synthetic.json")
  }
  assert {
    condition     = !google_cloud_scheduler_job.lifecycle[0].paused && output.idle_automation_enabled
    error_message = "Only an exactly bound protected acceptance proof releases scheduling."
  }
}
run "different_image_acceptance_refused" {
  command = plan
  variables {
    lifecycle_image                      = "asia-south1-docker.pkg.dev/axiom-proof/marketing/lifecycle@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    lifecycle_scheduler_paused           = false
    lifecycle_acceptance_manifest_path   = "tests/fixtures/lifecycle-acceptance.synthetic.json"
    lifecycle_acceptance_manifest_sha256 = filesha256("tests/fixtures/lifecycle-acceptance.synthetic.json")
  }
  expect_failures = [terraform_data.lifecycle_release]
}

run "full_services_missing_controller_refused" {
  command = plan
  variables { lifecycle_image = "" }
  expect_failures = [terraform_data.configuration]
}

run "unsafe_controller_pool_refused" {
  command = plan
  variables { lifecycle_settings = { cpu = "1", memory = "256Mi", port = 8080, concurrency = 9 } }
  expect_failures = [var.lifecycle_settings]
}
