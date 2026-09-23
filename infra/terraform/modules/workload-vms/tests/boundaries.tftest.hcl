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
}

run "private_separate_hosts_and_state" {
  command = apply
  assert {
    condition = length(google_compute_instance.host) == 2 && alltrue([
      for role, host in google_compute_instance.host :
      host.zone == "asia-south1-a" && host.deletion_protection && !host.can_ip_forward &&
      host.network_interface[0].network == var.network &&
      host.network_interface[0].stack_type == "IPV4_ONLY" &&
      length(host.network_interface[0].access_config) == 0 &&
      length(host.network_interface[0].ipv6_access_config) == 0 &&
      host.service_account[0].email == google_service_account.host[role].email &&
      host.attached_disk[0].source == google_compute_disk.state[role].id
    ])
    error_message = "Issuer and runner must have separate private instances, identities and state."
  }
  assert {
    condition = length(distinct([for identity in google_service_account.host : identity.account_id])) == 2 && alltrue([
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
    condition = (
      google_compute_firewall.spire.source_service_accounts == toset([google_service_account.host["runner"].email]) &&
      google_compute_firewall.spire.target_service_accounts == toset([google_service_account.host["issuer"].email]) &&
      one(google_compute_firewall.spire.allow).ports == tolist(["8081"]) &&
      google_compute_firewall.spire_egress.destination_ranges == toset(["${google_compute_address.host["issuer"].address}/32"]) &&
      google_compute_firewall.spire.priority < google_compute_firewall.deny_ingress.priority &&
      google_compute_firewall.spire_egress.priority < google_compute_firewall.deny_egress.priority
    )
    error_message = "SPIRE traffic must be limited to the reviewed runner/issuer direction and port."
  }
  assert {
    condition = (
      one(google_compute_firewall.deny_ingress.deny).protocol == "all" &&
      one(google_compute_firewall.deny_egress.deny).protocol == "all" &&
      one(google_compute_firewall.https_egress.allow).protocol == "tcp" &&
      one(google_compute_firewall.https_egress.allow).ports == tolist(["443"])
    )
    error_message = "Unlisted traffic must be denied; generic host egress is HTTPS only."
  }
}

run "explicit_scheduler_ingress" {
  command = apply
  variables {
    controller_source_ranges = ["10.10.16.0/28"]
  }
  assert {
    condition = (
      google_compute_firewall.controller[0].source_ranges == toset(["10.10.16.0/28"]) &&
      google_compute_firewall.controller[0].target_service_accounts == toset([google_service_account.host["runner"].email]) &&
      one(google_compute_firewall.controller[0].allow).ports == tolist(["8443"])
    )
    error_message = "Only the explicit scheduler range may reach the runner TLS port."
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
  variables { controller_source_ranges = ["0.0.0.0/0"] }
  expect_failures = [var.controller_source_ranges]
}
run "reject_private_prefix_covering_public_space" {
  command = plan
  variables { controller_source_ranges = ["10.0.0.0/1"] }
  expect_failures = [var.controller_source_ranges]
}
run "reject_invalid_ipv4" {
  command = plan
  variables { controller_source_ranges = ["10.999.0.0/28"] }
  expect_failures = [var.controller_source_ranges]
}
run "production_identity_name_bounds" {
  command = apply
  variables { name_prefix = "axiom-production" }
  assert {
    condition     = alltrue([for identity in google_service_account.host : length(identity.account_id) <= 30])
    error_message = "Production service account names must fit provider limits."
  }
}
