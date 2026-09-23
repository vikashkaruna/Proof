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
    condition     = length(module.workload_vms) == 0 && output.workload_vm_hosts == null
    error_message = "Existing deployments must not silently create issuer or runner VMs."
  }
}

run "explicit_configuration_composes_private_hosts" {
  command = apply
  variables {
    workload_vms = {
      zone                     = "asia-south1-a"
      boot_image               = "projects/axiom-vm-fixture/global/images/reviewed-runner-20260923"
      controller_source_ranges = ["10.10.16.0/28"]
    }
  }
  assert {
    condition = length(module.workload_vms) == 1 && alltrue([
      for role, host in output.workload_vm_hosts :
      host.zone == "asia-south1-a" && host.name == "axiom-preprod-${role}"
    ])
    error_message = "Explicit configuration must compose exactly the intended Mumbai hosts."
  }
}
