output "cloud_run_uris" { value = var.deploy_services ? { marketing = module.marketing[0].uri, bff = module.bff[0].uri, gateway = module.gateway[0].uri, auth = module.auth[0].uri, rest = module.rest[0].uri } : {} }
output "database" { value = { name = google_sql_database.marketing.name, instance = google_sql_database_instance.marketing.name, private_ip = google_sql_database_instance.marketing.private_ip_address, connection_name = google_sql_database_instance.marketing.connection_name } }
output "firebase_rewrites" { value = var.deploy_services ? [{ source = "**", run = { serviceId = module.marketing[0].name, region = var.region } }] : [] }
output "idle_automation_enabled" { value = local.lifecycle_enabled && !var.lifecycle_scheduler_paused }
output "request_contracts" { value = var.deploy_services ? { marketing = module.marketing[0].request_contract, bff = module.bff[0].request_contract, gateway = module.gateway[0].request_contract, auth = module.auth[0].request_contract, rest = module.rest[0].request_contract } : {} }

output "runtime_service_accounts" { value = { for key, sa in google_service_account.runtime : key => sa.email } }
output "migration_service_account" { value = var.migration_account_id != "" ? google_service_account.migration[0].email : "" }
output "secret_ids" { value = { for key, s in google_secret_manager_secret.runtime : key => s.secret_id } }

output "lifecycle_controller_uri" { value = local.lifecycle_enabled ? google_cloud_run_v2_service.lifecycle[0].uri : "" }
output "lifecycle_request_contract" { value = local.lifecycle_enabled ? { private_iam = true, invokers = keys(google_cloud_run_v2_service_iam_member.lifecycle), request_seconds = var.lifecycle_request_seconds, lease_seconds = var.lifecycle_lease_seconds, scheduler_paused = var.lifecycle_scheduler_paused, target_manifest_sha256 = var.lifecycle_target_manifest_sha256 } : null }
