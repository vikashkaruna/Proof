mock_provider "google" {}
variables {
  project_id  = "axiom-vm-fixture"
  name_prefix = "axiom-preprod"
  zone        = "asia-south1-a"
  boot_image  = "projects/axiom-vm-fixture/global/images/reviewed-runner-20260923"
  network     = "projects/axiom-vm-fixture/global/networks/private"
  subnetwork  = "projects/axiom-vm-fixture/regions/asia-south1/subnetworks/private"
  tenants = {
    "11111111-1111-4111-8111-111111111111" = {
      controller_permissions = {
        dispatch_keys = {
          primary  = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-a-current"
          retiring = ["projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-a-retiring"]
        }
      }
    }
    "22222222-2222-4222-8222-222222222222" = {
      controller_permissions = {
        dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-b-current" }
      }
    }
    "33333333-3333-4333-8333-333333333333" = {}
  }
}

run "unconfigured_permissions_remain_absent" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = {} } }
  assert {
    condition     = length(google_secret_manager_secret.controller) == 0 && length(google_secret_manager_secret_iam_member.controller) == 0 && length(google_kms_crypto_key_iam_member.controller) == 0 && length(output.controller_permissions) == 0
    error_message = "Existing runner configurations must not acquire implicit secret or key authority."
  }
}

run "reject_foreign_key_region" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_permissions = { dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/us-central1/keyRings/dispatch/cryptoKeys/key-a", retiring = [] } } } } }
  expect_failures = [var.tenants]
}

run "reject_foreign_key_project" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_permissions = { dispatch_keys = { primary = "projects/foreign-project/locations/asia-south1/keyRings/dispatch/cryptoKeys/key-a", retiring = [] } } } } }
  expect_failures = [google_kms_crypto_key_iam_member.controller]
}

run "reject_version_in_place_of_key" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_permissions = { dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/key-a/cryptoKeyVersions/1", retiring = [] } } } } }
  expect_failures = [var.tenants]
}

run "reject_shared_key" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_permissions = { dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/shared-key", retiring = [] } } }, "22222222-2222-4222-8222-222222222222" = { controller_permissions = { dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/shared-key", retiring = [] } } } } }
  expect_failures = [var.tenants]
}

run "reject_foreign_retiring_key" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_permissions = { dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/key-a", retiring = [] } } }, "22222222-2222-4222-8222-222222222222" = { controller_permissions = { dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/key-b", retiring = ["projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/key-a"] } } } } }
  expect_failures = [var.tenants]
}

run "reject_duplicate_primary" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_permissions = { dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/key-a", retiring = ["projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/key-a"] } } } } }
  expect_failures = [var.tenants]
}

run "reject_duplicate_retiring" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_permissions = { dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/key-a", retiring = ["projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/old-key", "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/old-key"] } } } } }
  expect_failures = [var.tenants]
}

run "reject_excess_retiring_keys" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_permissions = { dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/key-a", retiring = [for index in range(10) : "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/old-${index}"] } } } } }
  expect_failures = [var.tenants]
}

run "reject_empty_primary" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_permissions = { dispatch_keys = { primary = "", retiring = [] } } } } }
  expect_failures = [var.tenants]
}

run "reject_zero_tenant" {
  command = plan
  variables { tenants = { "00000000-0000-0000-0000-000000000000" = {} } }
  expect_failures = [var.tenants]
}

run "only_explicit_tenant_resources_receive_permissions" {
  command = apply
  assert {
    condition = (
      length(google_secret_manager_secret.controller) == 4 &&
      length(google_secret_manager_secret_iam_member.controller) == 4 &&
      length(google_kms_crypto_key_iam_member.controller) == 3 &&
      toset(keys(output.controller_permissions)) == toset(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"])
    )
    error_message = "Only opted-in tenants get two secrets and their explicit primary/retiring key grants."
  }
  assert {
    condition = alltrue([
      for address, grant in google_secret_manager_secret_iam_member.controller :
      grant.project == "axiom-vm-fixture" && grant.role == "roles/secretmanager.secretAccessor" &&
      grant.secret_id == google_secret_manager_secret.controller[address].id &&
      grant.member == "serviceAccount:${google_service_account.host["runner-${split(":", address)[0]}"].email}"
    ])
    error_message = "Secret access must target only that tenant's runner and managed resource."
  }
  assert {
    condition = alltrue([
      for address, grant in google_kms_crypto_key_iam_member.controller :
      grant.role == "roles/cloudkms.cryptoKeyDecrypter" &&
      grant.member == "serviceAccount:${google_service_account.host["runner-${split(":", address)[0]}"].email}" &&
      contains(concat([var.tenants[split(":", address)[0]].controller_permissions.dispatch_keys.primary], var.tenants[split(":", address)[0]].controller_permissions.dispatch_keys.retiring), grant.crypto_key_id)
    ])
    error_message = "Every KMS grant must be decryption only for its tenant's exact key inventory."
  }
  assert {
    condition = alltrue([
      for address, secret in google_secret_manager_secret.controller :
      secret.project == "axiom-vm-fixture" && secret.labels.axiom_tenant == split(":", address)[0] &&
      secret.labels.axiom_role == "runner" && secret.labels.axiom_purpose == "controller_${split(":", address)[1]}" &&
      secret.secret_id == "${google_compute_instance.host["runner-${split(":", address)[0]}"].name}-${split(":", address)[1]}" &&
      length(secret.replication[0].auto) == 0 &&
      length(secret.replication[0].user_managed[0].replicas) == 1 &&
      one(secret.replication[0].user_managed[0].replicas).location == "asia-south1"
    ])
    error_message = "Secret containers must be tenant-labelled, unique and replicated only in Mumbai."
  }
  assert {
    condition = (
      length(distinct([for secret in google_secret_manager_secret.controller : secret.secret_id])) == 4 &&
      alltrue([for tenant, inventory in output.controller_permissions :
        inventory.schemaVersion == 1 && inventory.tenantId == tenant && inventory.projectId == "axiom-vm-fixture" &&
        inventory.runnerServiceAccount == google_service_account.host["runner-${tenant}"].email &&
        inventory.backendSecret == "projects/axiom-vm-fixture/secrets/${google_secret_manager_secret.controller["${tenant}:backend"].secret_id}" &&
        inventory.tlsSecret == "projects/axiom-vm-fixture/secrets/${google_secret_manager_secret.controller["${tenant}:tls"].secret_id}" &&
        inventory.keys.provider == "gcp" && inventory.keys.primary == var.tenants[tenant].controller_permissions.dispatch_keys.primary &&
        inventory.keys.retiring == sort(var.tenants[tenant].controller_permissions.dispatch_keys.retiring)
      ])
    )
    error_message = "Review inventory must bind host identity, tenant secrets and the exact key configuration."
  }
  # Cross-checked with DispatchKeyPolicy.fingerprint in the BFF, not a repeat of
  # the Terraform expression: also catches changes to purpose/order/newlines.
  assert {
    condition     = output.controller_permissions["11111111-1111-4111-8111-111111111111"].keyPolicyFingerprint == "84408be6bba7fda972957bc32d8ac053a39ed709d6ff11517f55af7edff400dc" # gitleaks:allow -- public SHA-256 of synthetic resource names, not a credential
    error_message = "IAM review fingerprint must equal the backend's persisted key-policy contract."
  }
}


run "primary_promotion_preserves_all_readable_grants" {
  command = plan
  variables {
    tenants = {
      "11111111-1111-4111-8111-111111111111" = {
        controller_permissions = {
          dispatch_keys = {
            primary  = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-a-retiring"
            retiring = ["projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-a-current"]
          }
        }
      }
      "22222222-2222-4222-8222-222222222222" = {
        controller_permissions = {
          dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-b-current" }
        }
      }
      "33333333-3333-4333-8333-333333333333" = {}
    }
  }
  assert {
    condition = (
      toset([for grant in google_kms_crypto_key_iam_member.controller : grant.crypto_key_id]) == toset([
        "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-a-current",
        "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-a-retiring",
        "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-b-current",
      ]) && output.controller_permissions["11111111-1111-4111-8111-111111111111"].keyPolicyFingerprint == "e5190bde28f89f87900b799573e2f5159869d9e4061c1abd9817b09053042de9" # gitleaks:allow -- public SHA-256 of synthetic resource names, not a credential
    )
    error_message = "Primary promotion must change the policy fence while retaining old-key read authority."
  }
}
