output "hosts" {
  description = "Private deployment references only. An instance existing is not issuer/controller readiness."
  value = {
    for role, host in google_compute_instance.host : role => {
      name            = host.name
      instance_id     = host.instance_id
      zone            = host.zone
      private_ip      = google_compute_address.host[role].address
      service_account = google_service_account.host[role].email
      state_disk      = google_compute_disk.state[role].id
    }
  }
}
