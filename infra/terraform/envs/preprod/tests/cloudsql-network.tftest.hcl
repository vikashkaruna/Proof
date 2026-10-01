# Provider mocks: plan validation never reaches a cloud project.
mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id           = "axiom-network-fixture"
  supabase_jwt_secret  = "synthetic-jwt-signing-key-for-offline-tests-only"
  supabase_anon_key    = "synthetic-public-anon-fixture"
  supabase_service_key = "synthetic-service-role-fixture"
}

run "private_only_by_default" {
  command = plan
  assert {
    condition = (
      google_sql_database_instance.postgres.settings[0].ip_configuration[0].ipv4_enabled == false &&
      length(google_sql_database_instance.postgres.settings[0].ip_configuration[0].authorized_networks) == 0
    )
    error_message = "Cloud SQL must have no public endpoint or authorized networks by default."
  }
}

run "explicit_narrow_runner" {
  command = plan
  variables {
    cloud_sql_authorized_networks = { "reviewed-migration-runner" = "203.0.113.7/32" }
  }
  assert {
    condition = (
      google_sql_database_instance.postgres.settings[0].ip_configuration[0].ipv4_enabled == true &&
      one(google_sql_database_instance.postgres.settings[0].ip_configuration[0].authorized_networks).name == "reviewed-migration-runner" &&
      one(google_sql_database_instance.postgres.settings[0].ip_configuration[0].authorized_networks).value == "203.0.113.7/32"
    )
    error_message = "Only the explicitly approved runner CIDR may receive public access."
  }
}

run "public_catch_all_refused" {
  command = plan
  variables {
    cloud_sql_authorized_networks = { "unsafe" = "0.0.0.0/0" }
  }
  expect_failures = [var.cloud_sql_authorized_networks]
}

run "broad_runner_refused" {
  command = plan
  variables {
    cloud_sql_authorized_networks = { "unsafe" = "203.0.113.0/24" }
  }
  expect_failures = [var.cloud_sql_authorized_networks]
}

run "malformed_runner_refused" {
  command = plan
  variables {
    cloud_sql_authorized_networks = { "unsafe" = "203.0.113.999/32" }
  }
  expect_failures = [var.cloud_sql_authorized_networks]
}
