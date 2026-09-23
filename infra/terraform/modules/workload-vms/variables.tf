variable "project_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Use a canonical GCP project ID."
  }
}

variable "name_prefix" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,21}[a-z0-9]$", var.name_prefix))
    error_message = "Use a lowercase resource prefix of 3–23 characters."
  }
}

variable "zone" {
  type = string
  validation {
    condition     = contains(["asia-south1-a", "asia-south1-b", "asia-south1-c"], var.zone)
    error_message = "Workload VMs and their state disks must remain in Mumbai."
  }
}

variable "network" {
  type = string
}

variable "subnetwork" {
  type = string
  validation {
    condition     = can(regex("/regions/asia-south1/subnetworks/[a-z][a-z0-9-]+$", var.subnetwork))
    error_message = "Use an explicit Mumbai subnet resource URL."
  }
}

variable "boot_image" {
  description = "Reviewed named image resource; mutable image families are refused. This is not an image provenance attestation."
  type        = string
  validation {
    condition     = can(regex("^projects/[a-z][a-z0-9-]+/global/images/[a-z][a-z0-9-]+$", var.boot_image))
    error_message = "Pin a reviewed projects/PROJECT/global/images/IMAGE resource, never an image family."
  }
}

variable "tenants" {
  description = "Dedicated runner per canonical tenant UUID. Scheduler ranges are reviewed independently per tenant; empty ranges disable controller ingress."
  type = map(object({
    controller_source_ranges = optional(set(string), [])
  }))
  validation {
    condition = length(var.tenants) > 0 && length(var.tenants) <= 100 && alltrue([
      for tenant, settings in var.tenants :
      can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", tenant)) &&
      length(settings.controller_source_ranges) <= 8 && alltrue([
        for cidr in settings.controller_source_ranges : can(cidrhost(cidr, 0)) && can(regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)[0-9.]+/(2[4-9]|3[0-2])$", cidr))
      ])
    ])
    error_message = "Declare 1–100 canonical lowercase tenant UUIDs; each may allow at most eight private IPv4 /24–/32 scheduler ranges."
  }
}
