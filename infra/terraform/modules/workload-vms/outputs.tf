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

output "controller_permissions" {
  description = "Non-secret desired-policy inventory. Compare the key fingerprint with persisted backend policy and reviewed controller configuration; verify effective IAM separately."
  value = {
    for tenant, permissions in local.controller_tenants : tenant => {
      schemaVersion        = 1
      tenantId             = tenant
      projectId            = var.project_id
      runnerServiceAccount = google_service_account.host["runner-${tenant}"].email
      backendSecret        = "projects/${var.project_id}/secrets/${google_secret_manager_secret.controller["${tenant}:backend"].secret_id}"
      tlsSecret            = "projects/${var.project_id}/secrets/${google_secret_manager_secret.controller["${tenant}:tls"].secret_id}"
      keys = {
        provider = "gcp"
        primary  = permissions.dispatch_keys.primary
        retiring = sort(permissions.dispatch_keys.retiring)
      }
      keyPolicyFingerprint = sha256(join("\n", concat(
        ["axiom.dispatch.key-policy.v1", tenant, "gcp", permissions.dispatch_keys.primary],
        sort(concat([permissions.dispatch_keys.primary], permissions.dispatch_keys.retiring))
      )))
    }
  }
}
