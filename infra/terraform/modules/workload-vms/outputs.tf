locals {
  host_references = {
    for key, host in google_compute_instance.host : key => {
      name            = host.name
      instance_id     = host.instance_id
      zone            = host.zone
      private_ip      = google_compute_address.host[key].address
      service_account = google_service_account.host[key].email
      state_disk      = google_compute_disk.state[key].id
      tenant_id       = local.hosts[key].tenant_id
    }
  }
}

output "hosts" {
  description = "One private issuer and dedicated runner references keyed by tenant UUID. Infrastructure references are not application readiness or tenant authorization."
  value = {
    issuer  = local.host_references["issuer"]
    runners = { for tenant in keys(var.tenants) : tenant => local.host_references["runner-${tenant}"] }
  }
}
