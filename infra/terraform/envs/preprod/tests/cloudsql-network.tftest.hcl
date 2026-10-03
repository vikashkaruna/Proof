# Provider mocks: plan validation never reaches a cloud project.
mock_provider "google" {}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  # Must match the project the release-manifest fixture is bound to.
  project_id           = "axiom-iam-fixture"
  supabase_jwt_secret  = "synthetic-jwt-signing-key-for-offline-tests-only"
  supabase_anon_key    = "synthetic-public-anon-fixture"
  supabase_service_key = "synthetic-service-role-fixture"
  # The base now requires a minted BFF-only archive writer key; a synthetic
  # fixture satisfies the variable without any real credential.
  supabase_archive_writer_key = "synthetic-archive-writer-fixture"
  # Preprod also requires an exact release identity and the operator-owned S3
  # evidence vault; synthetic fixtures satisfy those variables offline.
  release_sha                = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  release_manifest_file      = "tests/runtime_iam_release.fixture.json"
  evidence_bucket            = "axiom-offline-fixture-evidence"
  evidence_endpoint          = "https://s3.ap-south-1.amazonaws.com"
  evidence_access_key_id     = "synthetic-access-key-for-tests"
  evidence_secret_access_key = "synthetic-secret-key-for-offline-tests-only"
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

run "cloud_run_uses_direct_vpc_egress" {
  command = plan
  assert {
    condition = alltrue([
      for svc in [
        google_cloud_run_v2_service.bff,
        google_cloud_run_v2_service.supabase_auth,
        google_cloud_run_v2_service.supabase_rest,
        ] : (
        svc.template[0].execution_environment == "EXECUTION_ENVIRONMENT_GEN2" &&
        length(svc.template[0].vpc_access[0].network_interfaces) == 1 &&
        svc.template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY" &&
        svc.template[0].vpc_access[0].connector == null
      )
    ])
    error_message = "Services that reach Cloud SQL must use Direct VPC egress on the dedicated subnet, gen2, private ranges only, and no connector."
  }
  assert {
    condition     = google_compute_subnetwork.run_egress.private_ip_google_access == true && endswith(google_compute_subnetwork.run_egress.ip_cidr_range, "/24")
    error_message = "The Cloud Run egress subnet must keep Private Google Access and a /24 of headroom."
  }
}

run "internal_services_are_private_by_default" {
  command = plan
  assert {
    condition = (
      google_cloud_run_v2_service.agent_runtime.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" &&
      google_cloud_run_v2_service.model_gateway.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" &&
      length(google_cloud_run_v2_service_iam_member.agent_runtime_public) == 0 &&
      length(google_cloud_run_v2_service_iam_member.model_gateway_public) == 0
    )
    error_message = "agent-runtime and model-gateway must be internal-only with no allUsers invoker by default."
  }
  assert {
    condition = (
      toset(keys(google_cloud_run_v2_service_iam_member.agent_runtime_invoker)) == toset(["bff", "temporal_worker"]) &&
      toset(keys(google_cloud_run_v2_service_iam_member.model_gateway_invoker)) == toset(["agent_runtime"])
    )
    error_message = "Only the named calling services may invoke the internal services."
  }
  assert {
    condition     = length(google_dns_managed_zone.run_app) == 1 && length(google_dns_record_set.run_app) == 2
    error_message = "Internal routing needs the private run.app zone and both records."
  }
  assert {
    condition = alltrue([
      for svc in [
        google_cloud_run_v2_service.agent_runtime,
        google_cloud_run_v2_service.temporal_worker,
      ] : length(svc.template[0].vpc_access[0].network_interfaces) == 1
    ])
    error_message = "Callers of internal services need the VPC path."
  }
}

run "internal_services_can_be_reopened" {
  command = plan
  variables {
    internal_services_private = false
  }
  assert {
    condition = (
      google_cloud_run_v2_service.agent_runtime.ingress == "INGRESS_TRAFFIC_ALL" &&
      length(google_cloud_run_v2_service_iam_member.agent_runtime_public) == 1 &&
      length(google_cloud_run_v2_service_iam_member.agent_runtime_invoker) == 0 &&
      length(google_dns_managed_zone.run_app) == 0
    )
    error_message = "internal_services_private = false must restore the public endpoints and drop the private routing."
  }
}

run "non_production_scales_to_zero_by_default" {
  command = plan
  assert {
    condition = alltrue([
      for svc in [
        google_cloud_run_v2_service.bff,
        google_cloud_run_v2_service.web,
        google_cloud_run_v2_service.agent_runtime,
        google_cloud_run_v2_service.supabase_auth,
        google_cloud_run_v2_service.supabase_rest,
        google_cloud_run_v2_service.supabase_gateway,
      ] : svc.template[0].scaling[0].min_instance_count == 0
    ])
    error_message = "Preprod services must scale to zero by default."
  }
}

run "warm_instances_are_a_parameter" {
  command = plan
  variables {
    min_instance_count = 1
  }
  assert {
    condition     = google_cloud_run_v2_service.bff.template[0].scaling[0].min_instance_count == 1
    error_message = "min_instance_count must reach the services."
  }
}

run "out_of_range_min_instances_refused" {
  command = plan
  variables {
    min_instance_count = 5
  }
  expect_failures = [var.min_instance_count]
}
