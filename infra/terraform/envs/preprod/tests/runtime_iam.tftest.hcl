# Offline provider mocks only: no cloud credentials, state or resources are used.
mock_provider "google" {
  mock_resource "google_compute_network" {
    defaults = {
      id        = "projects/axiom-iam-fixture/global/networks/test-vpc"
      self_link = "https://www.googleapis.com/compute/v1/projects/axiom-iam-fixture/global/networks/test-vpc"
    }
  }
}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id           = "axiom-iam-fixture"
  supabase_jwt_secret  = "synthetic-jwt-signing-key-for-offline-tests-only"
  supabase_anon_key    = "synthetic-public-anon-fixture"
  supabase_service_key = "synthetic-service-role-fixture"
}

run "separate_runtime_identities" {
  command = apply

  assert {
    condition     = length(google_service_account.runtime) == 9 && length(distinct([for sa in google_service_account.runtime : sa.account_id])) == 9
    error_message = "Every deployed service must have a distinct runtime identity."
  }
  assert {
    condition = alltrue([
      google_cloud_run_v2_service.bff.template[0].service_account == google_service_account.runtime["bff"].email,
      google_cloud_run_v2_service.web.template[0].service_account == google_service_account.runtime["web"].email,
      google_cloud_run_v2_service.marketing.template[0].service_account == google_service_account.runtime["marketing"].email,
      google_cloud_run_v2_service.agent_runtime.template[0].service_account == google_service_account.runtime["agent_runtime"].email,
      google_cloud_run_v2_service.model_gateway.template[0].service_account == google_service_account.runtime["model_gateway"].email,
      google_cloud_run_v2_service.temporal_worker.template[0].service_account == google_service_account.runtime["temporal_worker"].email,
      google_cloud_run_v2_service.supabase_auth.template[0].service_account == google_service_account.runtime["supabase_auth"].email,
      google_cloud_run_v2_service.supabase_rest.template[0].service_account == google_service_account.runtime["supabase_rest"].email,
      google_cloud_run_v2_service.supabase_gateway.template[0].service_account == google_service_account.runtime["supabase_gateway"].email,
    ])
    error_message = "A service is using another service's identity."
  }
  assert {
    condition = alltrue([
      for key, grant in google_secret_manager_secret_iam_member.runtime_access :
      grant.role == "roles/secretmanager.secretAccessor" &&
      grant.secret_id == google_secret_manager_secret.secret[local.runtime_secret_access[key].secret].secret_id &&
      grant.member == "serviceAccount:${google_service_account.runtime[local.runtime_secret_access[key].service].email}"
    ])
    error_message = "A secret grant is not bound to its intended secret and service."
  }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.runtime_access) == length(local.runtime_secret_access)
    error_message = "Every declared secret binding needs exactly one scoped grant."
  }
  assert {
    condition = (toset([for key, grant in local.runtime_secret_access : grant.secret if grant.service == "web"]) == toset(["supabase_anon_key"]) &&
      toset([for key, grant in local.runtime_secret_access : grant.secret if grant.service == "marketing"]) == toset(["supabase_anon_key", "resend_api_key"]) &&
    length([for key, grant in local.runtime_secret_access : key if grant.service == "supabase_gateway"]) == 0)
    error_message = "SSR/gateway identities must not acquire backend credentials. Contact mail remains a separately tracked marketing exception."
  }
  assert {
    condition     = length(google_secret_manager_secret.mfa_previous_keys) == 0 && length(google_secret_manager_secret_iam_member.mfa_previous_access) == 0
    error_message = "No retiring-key permission should exist outside rotation."
  }
}

run "production_names_and_rotation" {
  command = apply
  variables {
    environment                  = "production"
    mfa_encryption_keys_previous = "synthetic-retiring-key-for-offline-test-only"
  }
  assert {
    condition     = alltrue([for sa in google_service_account.runtime : length(sa.account_id) >= 6 && length(sa.account_id) <= 30 && can(regex("^[a-z][a-z0-9-]*[a-z0-9]$", sa.account_id))])
    error_message = "Service account IDs must fit GCP limits even with the longest supported environment."
  }
  assert {
    condition = (length(google_secret_manager_secret_iam_member.mfa_previous_access) == 1 &&
      google_secret_manager_secret_iam_member.mfa_previous_access[0].secret_id == google_secret_manager_secret.mfa_previous_keys[0].secret_id &&
      google_secret_manager_secret_iam_member.mfa_previous_access[0].member == "serviceAccount:${google_service_account.runtime["bff"].email}" &&
    google_secret_manager_secret_iam_member.mfa_previous_access[0].role == "roles/secretmanager.secretAccessor")
    error_message = "Only the BFF may read the conditional retiring MFA key ring."
  }
}

run "rotation_removed" {
  command = apply
  assert {
    condition     = length(google_secret_manager_secret_version.mfa_previous_keys) == 0 && length(google_secret_manager_secret_iam_member.mfa_previous_access) == 0
    error_message = "Ending rotation must remove the retiring secret version and its grant."
  }
}

run "unsupported_environment_is_refused" {
  command = plan
  variables {
    environment = "unbounded-arbitrary-environment-name"
  }
  expect_failures = [var.environment]
}

run "assessment_retention_configuration" {
  command = plan
  variables {
    assessment_dispatch_retention_days = 30
  }
  assert {
    condition     = one([for setting in google_cloud_run_v2_service.bff.template[0].containers[0].env : setting.value if setting.name == "AXIOM_ASSESSMENT_DISPATCH_RETENTION_DAYS"]) == "30"
    error_message = "Explicit retention must reach only backend maintenance configuration."
  }
}
run "invalid_assessment_retention_refused" {
  command = plan
  variables {
    assessment_dispatch_retention_days = 0
  }
  expect_failures = [var.assessment_dispatch_retention_days]
}
