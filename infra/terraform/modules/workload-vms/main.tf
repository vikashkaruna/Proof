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
  runners = {
    for tenant, settings in var.tenants : "runner-${tenant}" => {
      role                     = "runner"
      tenant_id                = tenant
      machine_type             = "e2-standard-2"
      state_gb                 = 50
      name                     = "${var.name_prefix}-r-${substr(sha256("${var.name_prefix}:${tenant}"), 0, 16)}"
      account_id               = "${substr(var.name_prefix, 0, 10)}-r-${substr(sha256("${var.name_prefix}:${tenant}"), 0, 16)}"
      controller_source_ranges = settings.controller_source_ranges
    }
  }
  hosts = merge({
    issuer = {
      role         = "issuer"
      tenant_id    = null
      machine_type = "e2-small"
      state_gb     = 20
      name         = "${var.name_prefix}-issuer"
      account_id   = "${var.name_prefix}-issuer"
    }
  }, local.runners)
}

resource "google_service_account" "host" {
  for_each     = local.hosts
  project      = var.project_id
  account_id   = each.value.account_id
  display_name = each.value.tenant_id == null ? "Axiom private workload issuer" : "Axiom tenant ${each.value.tenant_id} runner"
  lifecycle {
    precondition {
      condition     = length(distinct([for host in local.hosts : host.account_id])) == length(local.hosts)
      error_message = "Derived host identity names collide; choose a different reviewed prefix."
    }
  }
}

resource "google_compute_address" "host" {
  for_each     = local.hosts
  project      = var.project_id
  name         = each.value.name
  region       = "asia-south1"
  subnetwork   = var.subnetwork
  address_type = "INTERNAL"
}

resource "google_compute_disk" "state" {
  for_each = local.hosts
  project  = var.project_id
  name     = "${each.value.name}-state"
  zone     = var.zone
  type     = "pd-balanced"
  size     = each.value.state_gb
  labels   = each.value.tenant_id == null ? { axiom_role = each.value.role } : { axiom_role = each.value.role, axiom_tenant = each.value.tenant_id }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_instance" "host" {
  for_each            = local.hosts
  project             = var.project_id
  name                = each.value.name
  zone                = var.zone
  machine_type        = each.value.machine_type
  deletion_protection = true
  can_ip_forward      = false
  labels              = each.value.tenant_id == null ? { axiom_role = each.value.role } : { axiom_role = each.value.role, axiom_tenant = each.value.tenant_id }
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
    device_name = "axiom-${each.value.role}-state"
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
    # OAuth scope is a ceiling, not an IAM grant. No host identity has resource
    # access until separately reviewed bootstrap/runtime bindings are prepared.
  }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  metadata = merge({
    enable-oslogin           = "TRUE"
    enable-oslogin-2fa       = "TRUE"
    block-project-ssh-keys   = "TRUE"
    serial-port-enable       = "FALSE"
    disable-legacy-endpoints = "TRUE"
  }, each.value.tenant_id == null ? {} : { axiom-tenant-id = each.value.tenant_id })
}

# Each runner has its own identity, address, state and network rules. No shared
# runner or cross-tenant controller ingress is inferred from another tenant.
# Match dedicated service accounts rather than caller-editable network tags.
# Effective hierarchical/VPC rules still need deployment acceptance.
resource "google_compute_firewall" "deny_ingress" {
  for_each                = local.hosts
  project                 = var.project_id
  name                    = "${each.value.name}-deny-ingress"
  network                 = var.network
  direction               = "INGRESS"
  priority                = 1000
  source_ranges           = ["0.0.0.0/0"]
  target_service_accounts = [google_service_account.host[each.key].email]
  deny { protocol = "all" }
}

resource "google_compute_firewall" "spire" {
  for_each                = local.runners
  project                 = var.project_id
  name                    = "${each.value.name}-spire"
  network                 = var.network
  direction               = "INGRESS"
  priority                = 900
  source_service_accounts = [google_service_account.host[each.key].email]
  target_service_accounts = [google_service_account.host["issuer"].email]
  allow {
    protocol = "tcp"
    ports    = ["8081"]
  }
}

resource "google_compute_firewall" "controller" {
  for_each                = { for key, runner in local.runners : key => runner if length(runner.controller_source_ranges) > 0 }
  project                 = var.project_id
  name                    = "${each.value.name}-controller"
  network                 = var.network
  direction               = "INGRESS"
  priority                = 900
  source_ranges           = each.value.controller_source_ranges
  target_service_accounts = [google_service_account.host[each.key].email]
  allow {
    protocol = "tcp"
    ports    = ["8443"]
  }
}

resource "google_compute_firewall" "deny_egress" {
  for_each                = local.hosts
  project                 = var.project_id
  name                    = "${each.value.name}-deny-egress"
  network                 = var.network
  direction               = "EGRESS"
  priority                = 1000
  destination_ranges      = ["0.0.0.0/0"]
  target_service_accounts = [google_service_account.host[each.key].email]
  deny { protocol = "all" }
}

resource "google_compute_firewall" "https_egress" {
  for_each                = local.hosts
  project                 = var.project_id
  name                    = "${each.value.name}-https-egress"
  network                 = var.network
  direction               = "EGRESS"
  priority                = 900
  destination_ranges      = ["0.0.0.0/0"]
  target_service_accounts = [google_service_account.host[each.key].email]
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
}

resource "google_compute_firewall" "spire_egress" {
  for_each                = local.runners
  project                 = var.project_id
  name                    = "${each.value.name}-spire-egress"
  network                 = var.network
  direction               = "EGRESS"
  priority                = 900
  destination_ranges      = ["${google_compute_address.host["issuer"].address}/32"]
  target_service_accounts = [google_service_account.host[each.key].email]
  allow {
    protocol = "tcp"
    ports    = ["8081"]
  }
}
