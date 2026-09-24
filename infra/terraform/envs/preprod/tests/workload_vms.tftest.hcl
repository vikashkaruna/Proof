mock_provider "google" {
  mock_resource "google_compute_network" {
    defaults = {
      id        = "projects/axiom-vm-fixture/global/networks/private"
      self_link = "https://www.googleapis.com/compute/v1/projects/axiom-vm-fixture/global/networks/private"
    }
  }
  mock_resource "google_compute_subnetwork" {
    defaults = {
      self_link = "https://www.googleapis.com/compute/v1/projects/axiom-vm-fixture/regions/asia-south1/subnetworks/private"
    }
  }
  mock_resource "google_compute_address" {
    defaults = { address = "10.10.0.10" }
  }
}
mock_provider "google-beta" {}
mock_provider "random" {}

variables {
  project_id           = "axiom-vm-fixture"
  supabase_jwt_secret  = "synthetic-jwt-signing-key-for-offline-tests-only"
  supabase_anon_key    = "synthetic-public-anon-fixture"
  supabase_service_key = "synthetic-service-role-fixture"
}

run "existing_deployment_does_not_create_workload_hosts" {
  command = apply
  assert {
    condition     = length(module.workload_vms) == 0 && output.workload_vm_hosts == null && output.workload_controller_permissions == null && !contains(keys(google_project_service.apis), "cloudkms.googleapis.com")
    error_message = "Existing deployments must not silently create issuer or runner VMs."
  }
}

run "explicit_configuration_composes_private_hosts" {
  command = apply
  variables {
    workload_vms = {
      zone       = "asia-south1-a"
      boot_image = "projects/axiom-vm-fixture/global/images/reviewed-runner-20260923"
      tenants    = { "11111111-1111-4111-8111-111111111111" = { controller_source_ranges = ["10.10.16.0/28"] } }
    }
  }
  assert {
    condition = (
      length(module.workload_vms) == 1 && length(output.workload_controller_permissions) == 0 && !contains(keys(google_project_service.apis), "cloudkms.googleapis.com") && output.workload_vm_hosts.issuer.name == "axiom-preprod-issuer" &&
      toset(keys(output.workload_vm_hosts.runners)) == toset(["11111111-1111-4111-8111-111111111111"]) &&
      output.workload_vm_hosts.runners["11111111-1111-4111-8111-111111111111"].zone == "asia-south1-a" &&
      output.workload_vm_hosts.runners["11111111-1111-4111-8111-111111111111"].tenant_id == "11111111-1111-4111-8111-111111111111"
    )
    error_message = "Explicit configuration must compose exactly the intended Mumbai hosts."
  }
}

run "explicit_permissions_compose_with_tenant_host" {
  command = apply
  variables {
    workload_vms = {
      zone       = "asia-south1-a"
      boot_image = "projects/axiom-vm-fixture/global/images/reviewed-runner-20260923"
      tenants = {
        "11111111-1111-4111-8111-111111111111" = {
          controller_permissions = {
            dispatch_keys = { primary = "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-a-current" }
          }
        }
      }
    }
  }
  assert {
    condition = (
      google_project_service.apis["cloudkms.googleapis.com"].service == "cloudkms.googleapis.com" && !google_project_service.apis["cloudkms.googleapis.com"].disable_on_destroy &&
      toset(keys(output.workload_controller_permissions)) == toset(["11111111-1111-4111-8111-111111111111"]) &&
      output.workload_controller_permissions["11111111-1111-4111-8111-111111111111"].runnerServiceAccount == output.workload_vm_hosts.runners["11111111-1111-4111-8111-111111111111"].service_account &&
      output.workload_controller_permissions["11111111-1111-4111-8111-111111111111"].keys.primary == "projects/axiom-vm-fixture/locations/asia-south1/keyRings/dispatch/cryptoKeys/tenant-a-current"
    )
    error_message = "The root must preserve reviewed per-tenant permissions and bind them to the same dedicated host identity."
  }
}
