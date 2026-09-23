# Optional controller authority. Values and signing keys never enter Terraform.
# This is desired resource policy, not proof of effective inherited IAM.
locals {
  controller_tenants = {
    for tenant, settings in var.tenants : tenant => settings.controller_permissions
    if settings.controller_permissions != null
  }
  controller_secrets = merge({}, [
    for tenant, permissions in local.controller_tenants : {
      for purpose in ["backend", "tls"] : "${tenant}:${purpose}" => {
        tenant  = tenant
        purpose = purpose
      }
    }
  ]...)
  controller_keys = merge({}, [
    for tenant, permissions in local.controller_tenants : {
      for key in toset(concat([permissions.dispatch_keys.primary], permissions.dispatch_keys.retiring)) : "${tenant}:${sha256(key)}" => {
        tenant = tenant
        key    = key
      }
    }
  ]...)
}

# Empty containers only. A separately authorized issuer delivers versions.
# Backend: scoped credential JSON. TLS: leaf key/certificate bundle, never CA key.
resource "google_secret_manager_secret" "controller" {
  for_each  = local.controller_secrets
  project   = var.project_id
  secret_id = "${local.runners["runner-${each.value.tenant}"].name}-${each.value.purpose}"
  labels = {
    axiom_role    = "runner"
    axiom_tenant  = each.value.tenant
    axiom_purpose = "controller_${each.value.purpose}"
  }
  replication {
    user_managed {
      replicas {
        location = "asia-south1"
      }
    }
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_secret_manager_secret_iam_member" "controller" {
  for_each  = local.controller_secrets
  project   = var.project_id
  secret_id = google_secret_manager_secret.controller[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.host["runner-${each.value.tenant}"].email}"
}

# The controller opens existing dispatches. Only the separate producer encrypts.
# Existing reviewed keys remain outside this module's creation/retirement scope.
resource "google_kms_crypto_key_iam_member" "controller" {
  for_each      = local.controller_keys
  crypto_key_id = each.value.key
  role          = "roles/cloudkms.cryptoKeyDecrypter"
  member        = "serviceAccount:${google_service_account.host["runner-${each.value.tenant}"].email}"
  lifecycle {
    precondition {
      condition     = startswith(each.value.key, "projects/${var.project_id}/locations/asia-south1/")
      error_message = "Controller dispatch keys must belong to this reviewed project in Mumbai."
    }
  }
}
