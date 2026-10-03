# ==============================================================================
# Axiom Proof — GCP Preprod Networking (VPC, Cloud Run Direct VPC egress)
# ==============================================================================

# Enable required Google APIs
resource "google_project_service" "apis" {
  for_each = toset(concat([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
  ], local.workload_kms_required ? ["cloudkms.googleapis.com"] : []))
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# Dynamic Project Metadata (retrieves project number for deterministic Cloud Run URLs)
data "google_project" "project" {
  project_id = var.project_id
}

# Custom VPC for isolation
resource "google_compute_network" "vpc" {
  name                    = "axiom-${var.environment}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

# Primary Regional Subnet in Mumbai (asia-south1)
resource "google_compute_subnetwork" "subnet" {
  name                     = "axiom-${var.environment}-subnet-${var.region}"
  ip_cidr_range            = "10.10.0.0/20"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  private_ip_google_access = true
}

# Dedicated subnet for Cloud Run Direct VPC egress. Replaces the Serverless VPC
# Access connector: no connector instances to size, patch or pay for, lower
# latency and higher throughput, and the same private path to Cloud SQL.
# A /24 leaves room for rolling revisions: Cloud Run reserves addresses in
# blocks of 16 per service and keeps a retired revision's addresses for up to 20
# minutes. Private Google Access stays on so Cloud Run, Artifact Registry and
# Secret Manager remain reachable without a public path.
resource "google_compute_subnetwork" "run_egress" {
  name                     = "axiom-${var.environment}-run-egress-${var.region}"
  ip_cidr_range            = local.run_egress_cidr
  region                   = var.region
  network                  = google_compute_network.vpc.id
  private_ip_google_access = true
}

locals {
  # Also the source range to allow in workload-VM controller firewalls. Rules
  # match this range, not network tags: tags are caller-editable, which is why
  # the workload-vms module matches service accounts instead.
  run_egress_cidr = "10.10.16.0/24"
}

# Private Service Connection for Cloud SQL
resource "google_compute_global_address" "private_ip_address" {
  name          = "axiom-${var.environment}-sql-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
  depends_on    = [google_project_service.apis]
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_address.name]
}
