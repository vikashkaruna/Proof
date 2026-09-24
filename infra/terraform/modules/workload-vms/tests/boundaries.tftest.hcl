mock_provider "google" {
  mock_resource "google_compute_address" {
    defaults = { address = "10.10.0.10" }
  }
}

variables {
  project_id  = "axiom-vm-fixture"
  name_prefix = "axiom-preprod"
  zone        = "asia-south1-a"
  boot_image  = "projects/axiom-vm-fixture/global/images/reviewed-runner-20260923"
  network     = "https://www.googleapis.com/compute/v1/projects/axiom-vm-fixture/global/networks/private"
  subnetwork  = "https://www.googleapis.com/compute/v1/projects/axiom-vm-fixture/regions/asia-south1/subnetworks/private"
  tenants = {
    "11111111-1111-4111-8111-111111111111" = {}
    "22222222-2222-4222-8222-222222222222" = {}
  }
}

run "private_separate_hosts_and_state" {
  command = apply
  assert {
    condition = length(google_compute_instance.host) == 3 && alltrue([
      for key, host in google_compute_instance.host :
      host.zone == "asia-south1-a" && host.deletion_protection && !host.can_ip_forward &&
      host.network_interface[0].network == var.network &&
      host.network_interface[0].stack_type == "IPV4_ONLY" &&
      length(host.network_interface[0].access_config) == 0 &&
      length(host.network_interface[0].ipv6_access_config) == 0 &&
      host.service_account[0].email == google_service_account.host[key].email &&
      host.attached_disk[0].source == google_compute_disk.state[key].id &&
      host.attached_disk[0].device_name == "axiom-${local.hosts[key].role}-state"
    ])
    error_message = "Issuer and each tenant runner need private instances, identities and state."
  }
  assert {
    condition = length(distinct([for identity in google_service_account.host : identity.account_id])) == 3 && alltrue([
      for host in google_compute_instance.host :
      host.shielded_instance_config[0].enable_secure_boot &&
      host.shielded_instance_config[0].enable_vtpm &&
      host.shielded_instance_config[0].enable_integrity_monitoring &&
      host.metadata["enable-oslogin"] == "TRUE" &&
      host.metadata["enable-oslogin-2fa"] == "TRUE" &&
      host.metadata["block-project-ssh-keys"] == "TRUE" &&
      host.metadata["serial-port-enable"] == "FALSE" &&
      !contains(keys(host.metadata), "startup-script") &&
      !contains(keys(host.metadata), "ssh-keys")
    ])
    error_message = "Host hardening or inert/no-secret startup configuration regressed."
  }
  assert {
    condition     = length(google_compute_firewall.controller) == 0
    error_message = "No scheduler range means no controller ingress."
  }
  assert {
    condition = alltrue([
      for key, runner in local.runners :
      google_compute_firewall.spire[key].source_service_accounts == toset([google_service_account.host[key].email]) &&
      google_compute_firewall.spire[key].target_service_accounts == toset([google_service_account.host["issuer"].email]) &&
      one(google_compute_firewall.spire[key].allow).ports == tolist(["8081"]) &&
      google_compute_firewall.spire_egress[key].destination_ranges == toset(["${google_compute_address.host["issuer"].address}/32"]) &&
      google_compute_firewall.spire_egress[key].target_service_accounts == toset([google_service_account.host[key].email]) &&
      google_compute_firewall.spire[key].priority < google_compute_firewall.deny_ingress["issuer"].priority &&
      google_compute_firewall.spire_egress[key].priority < google_compute_firewall.deny_egress[key].priority
    ])
    error_message = "SPIRE traffic must bind each runner only to the issuer direction and port."
  }
  assert {
    condition = alltrue([
      for key, host in local.hosts :
      one(google_compute_firewall.deny_ingress[key].deny).protocol == "all" &&
      one(google_compute_firewall.deny_egress[key].deny).protocol == "all" &&
      one(google_compute_firewall.https_egress[key].allow).protocol == "tcp" &&
      one(google_compute_firewall.https_egress[key].allow).ports == tolist(["443"]) &&
      google_compute_firewall.deny_ingress[key].target_service_accounts == toset([google_service_account.host[key].email]) &&
      google_compute_firewall.deny_egress[key].target_service_accounts == toset([google_service_account.host[key].email]) &&
      google_compute_firewall.https_egress[key].target_service_accounts == toset([google_service_account.host[key].email])
    ])
    error_message = "Each host needs its own deny boundaries and HTTPS-only generic egress."
  }
}

run "dedicated_tenant_resources_and_independent_ingress" {
  command = apply
  variables {
    tenants = {
      "11111111-1111-4111-8111-111111111111" = { controller_source_ranges = ["10.10.16.0/28"] }
      "22222222-2222-4222-8222-222222222222" = {}
    }
  }
  assert {
    condition = (
      length(google_compute_instance.host) == 3 && length(google_compute_disk.state) == 3 &&
      length(google_compute_address.host) == 3 && length(google_service_account.host) == 3 &&
      length(distinct([for host in google_compute_instance.host : host.name])) == 3 &&
      length(distinct([for disk in google_compute_disk.state : disk.name])) == 3 &&
      length(distinct([for identity in google_service_account.host : identity.account_id])) == 3 &&
      toset(keys(output.hosts.runners)) == toset(keys(var.tenants)) && output.hosts.issuer.tenant_id == null &&
      alltrue([for tenant, host in output.hosts.runners : host.tenant_id == tenant &&
        google_compute_instance.host["runner-${tenant}"].metadata["axiom-tenant-id"] == tenant &&
        google_compute_instance.host["runner-${tenant}"].labels["axiom_tenant"] == tenant &&
      google_compute_disk.state["runner-${tenant}"].labels["axiom_tenant"] == tenant])
    )
    error_message = "Each tenant must receive its own runner, identity, address and disk, alongside one issuer."
  }
  assert {
    condition = (
      length(google_compute_firewall.controller) == 1 &&
      google_compute_firewall.controller["runner-11111111-1111-4111-8111-111111111111"].source_ranges == toset(["10.10.16.0/28"]) &&
      google_compute_firewall.controller["runner-11111111-1111-4111-8111-111111111111"].target_service_accounts == toset([google_service_account.host["runner-11111111-1111-4111-8111-111111111111"].email]) &&
      one(google_compute_firewall.controller["runner-11111111-1111-4111-8111-111111111111"].allow).ports == tolist(["8443"]) &&
      !contains(keys(google_compute_firewall.controller), "runner-22222222-2222-4222-8222-222222222222") &&
      length(google_compute_firewall.spire) == 2 && length(google_compute_firewall.spire_egress) == 2
    )
    error_message = "One tenant's scheduler range must not open another tenant's controller."
  }
}

run "reject_other_region" {
  command = plan
  variables { zone = "us-central1-a" }
  expect_failures = [var.zone]
}
run "reject_other_subnet_region" {
  command = plan
  variables { subnetwork = "projects/axiom-vm-fixture/regions/asia-south2/subnetworks/private" }
  expect_failures = [var.subnetwork]
}
run "reject_mutable_image_family" {
  command = plan
  variables { boot_image = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64" }
  expect_failures = [var.boot_image]
}
run "reject_public_controller_ingress" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_source_ranges = ["0.0.0.0/0"] } } }
  expect_failures = [var.tenants]
}
run "reject_private_prefix_covering_public_space" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_source_ranges = ["10.0.0.0/1"] } } }
  expect_failures = [var.tenants]
}
run "reject_invalid_ipv4" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_source_ranges = ["10.999.0.0/28"] } } }
  expect_failures = [var.tenants]
}
run "reject_unbound_runner" {
  command = plan
  variables { tenants = {} }
  expect_failures = [var.tenants]
}
run "reject_noncanonical_tenant" {
  command = plan
  variables { tenants = { "other-tenant" = {} } }
  expect_failures = [var.tenants]
}
run "production_identity_name_bounds" {
  command = apply
  variables { name_prefix = "abcdefghijklmnopqrstuvw" }
  assert {
    condition = (
      alltrue([for identity in google_service_account.host : length(identity.account_id) <= 30]) &&
      alltrue([for instance in google_compute_instance.host : length(instance.name) <= 63]) &&
      alltrue([for firewall in google_compute_firewall.deny_ingress : length(firewall.name) <= 63])
    )
    error_message = "Maximum permitted prefixes must still fit provider resource-name limits."
  }
}

run "reject_oversized_tenant_batch" {
  command = plan
  variables { tenants = { for index in range(101) : format("%08x-0000-4000-8000-000000000000", index) => {} } }
  expect_failures = [var.tenants]
}
run "reject_excess_scheduler_ranges" {
  command = plan
  variables { tenants = { "11111111-1111-4111-8111-111111111111" = { controller_source_ranges = [for index in range(9) : "10.10.${index}.0/24"] } } }
  expect_failures = [var.tenants]
}
