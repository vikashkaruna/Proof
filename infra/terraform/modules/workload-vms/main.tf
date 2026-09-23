terraform {
  required_version = ">= 1.7.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.25"
    }
  }
}

# Infrastructure foundation only: no issuer/node startup, secret contents, IAM
# grants, public interfaces or remote administration are implicitly enabled.
locals {
  roles = {
    issuer = { machine_type = "e2-small", state_gb = 20 }
    runner = { machine_type = "e2-standard-2", state_gb = 50 }
  }
}

resource "google_service_account" "host" {
  for_each     = local.roles
  project      = var.project_id
  account_id   = "${var.name_prefix}-${each.key}"
  display_name = "Axiom private workload ${each.key}"
}

resource "google_compute_address" "host" {
  for_each     = local.roles
  project      = var.project_id
  name         = "${var.name_prefix}-${each.key}"
  region       = "asia-south1"
  subnetwork   = var.subnetwork
  address_type = "INTERNAL"
}

resource "google_compute_disk" "state" {
  for_each = local.roles
  project  = var.project_id
  name     = "${var.name_prefix}-${each.key}-state"
  zone     = var.zone
  type     = "pd-balanced"
  size     = each.value.state_gb
  labels   = { axiom_role = each.key }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_instance" "host" {
  for_each            = local.roles
  project             = var.project_id
  name                = "${var.name_prefix}-${each.key}"
  zone                = var.zone
  machine_type        = each.value.machine_type
  deletion_protection = true
  can_ip_forward      = false
  labels              = { axiom_role = each.key }
  # Install the dedicated network boundary before any guest can boot. These
  # rules depend on identities/addresses, never on instance creation itself.
  depends_on = [
    google_compute_firewall.deny_ingress,
    google_compute_firewall.deny_egress,
    google_compute_firewall.spire,
    google_compute_firewall.spire_egress,
    google_compute_firewall.https_egress,
    google_compute_firewall.controller,
  ]

  boot_disk {
    initialize_params {
      image = var.boot_image
      type  = "pd-balanced"
      size  = 20
    }
  }
  attached_disk {
    source      = google_compute_disk.state[each.key].id
    device_name = "axiom-${each.key}-state"
    mode        = "READ_WRITE"
  }
  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
    stack_type = "IPV4_ONLY"
    network_ip = google_compute_address.host[each.key].address
    # Deliberately no access_config/IPv6 public interface.
  }
  service_account {
    email  = google_service_account.host[each.key].email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    # OAuth scope is a ceiling, not an IAM grant. Neither identity has resource
    # access until separately reviewed bootstrap/runtime bindings are prepared.
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  metadata = {
    enable-oslogin           = "TRUE"
    enable-oslogin-2fa       = "TRUE"
    block-project-ssh-keys   = "TRUE"
    serial-port-enable       = "FALSE"
    disable-legacy-endpoints = "TRUE"
  }
}

# Match dedicated service accounts rather than caller-editable network tags.
# Effective hierarchical/VPC rules still need deployment acceptance.
resource "google_compute_firewall" "deny_ingress" {
  project                 = var.project_id
  name                    = "${var.name_prefix}-deny-ingress"
  network                 = var.network
  direction               = "INGRESS"
  priority                = 1000
  source_ranges           = ["0.0.0.0/0"]
  target_service_accounts = [for identity in google_service_account.host : identity.email]
  deny { protocol = "all" }
}

resource "google_compute_firewall" "spire" {
  project                 = var.project_id
  name                    = "${var.name_prefix}-spire"
  network                 = var.network
  direction               = "INGRESS"
  priority                = 900
  source_service_accounts = [google_service_account.host["runner"].email]
  target_service_accounts = [google_service_account.host["issuer"].email]
  allow {
    protocol = "tcp"
    ports    = ["8081"]
  }
}

resource "google_compute_firewall" "controller" {
  count                   = length(var.controller_source_ranges) == 0 ? 0 : 1
  project                 = var.project_id
  name                    = "${var.name_prefix}-controller"
  network                 = var.network
  direction               = "INGRESS"
  priority                = 900
  source_ranges           = var.controller_source_ranges
  target_service_accounts = [google_service_account.host["runner"].email]
  allow {
    protocol = "tcp"
    ports    = ["8443"]
  }
}

resource "google_compute_firewall" "deny_egress" {
  project                 = var.project_id
  name                    = "${var.name_prefix}-deny-egress"
  network                 = var.network
  direction               = "EGRESS"
  priority                = 1000
  destination_ranges      = ["0.0.0.0/0"]
  target_service_accounts = [for identity in google_service_account.host : identity.email]
  deny { protocol = "all" }
}

resource "google_compute_firewall" "https_egress" {
  project                 = var.project_id
  name                    = "${var.name_prefix}-https-egress"
  network                 = var.network
  direction               = "EGRESS"
  priority                = 900
  destination_ranges      = ["0.0.0.0/0"]
  target_service_accounts = [for identity in google_service_account.host : identity.email]
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
}

resource "google_compute_firewall" "spire_egress" {
  project                 = var.project_id
  name                    = "${var.name_prefix}-spire-egress"
  network                 = var.network
  direction               = "EGRESS"
  priority                = 900
  destination_ranges      = ["${google_compute_address.host["issuer"].address}/32"]
  target_service_accounts = [google_service_account.host["runner"].email]
  allow {
    protocol = "tcp"
    ports    = ["8081"]
  }
}
