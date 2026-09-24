# ==============================================================================
# Axiom Proof — GCP Preprod Networking (VPC & Serverless Connector)
# ==============================================================================

# Enable required Google APIs
resource "google_project_service" "apis" {
  for_each = toset(concat([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "vpcaccess.googleapis.com",
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

# Serverless VPC Access Connector for Cloud Run to access Cloud SQL privately
resource "google_vpc_access_connector" "connector" {
  name          = "axiom-${var.environment}-conn"
  region        = var.region
  network       = google_compute_network.vpc.name
  ip_cidr_range = "10.10.16.0/28"
  min_instances = 2
  max_instances = 5
  machine_type  = "e2-micro"
  depends_on    = [google_project_service.apis]

  lifecycle {
    ignore_changes = [
      max_throughput,
      min_throughput,
    ]
  }
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
