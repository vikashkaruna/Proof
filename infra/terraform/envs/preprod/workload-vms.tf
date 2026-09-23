# Explicitly opt-in: no workload VM is provisioned by an existing deployment.
# Keep null until node/issuer bootstrap, protected state and service supervision
# are reviewed. This foundation does not claim either application is ready.
variable "workload_vms" {
  type = object({
    zone                     = string
    boot_image               = string
    controller_source_ranges = optional(set(string), [])
  })
  default = null
}

module "workload_vms" {
  count                    = var.workload_vms == null ? 0 : 1
  source                   = "../../modules/workload-vms"
  project_id               = var.project_id
  name_prefix              = "axiom-${var.environment}"
  zone                     = var.workload_vms.zone
  boot_image               = var.workload_vms.boot_image
  controller_source_ranges = var.workload_vms.controller_source_ranges
  network                  = google_compute_network.vpc.self_link
  subnetwork               = google_compute_subnetwork.subnet.self_link
  depends_on               = [google_project_service.apis]
}

output "workload_vm_hosts" {
  value = var.workload_vms == null ? null : module.workload_vms[0].hosts
}
