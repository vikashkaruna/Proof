# Dependency order uses actual provider URIs, never guessed run.app hostnames.
# Firebase Hosting rewrites SSR routes to marketing; no Auth/public gateway rewrite
# is deployed by this profile. API_EXTERNAL_URL is an explicit public site origin;
# external Auth redirect journeys require a separately reviewed origin/hosting setup.
# The Hosting CLI deployment is separate and must use outputs here.
locals {
  common_env = { ENVIRONMENT = var.environment, NODE_ENV = "production", AXIOM_RELEASE_SHA = var.release_sha }
}
module "auth" {
  invokers              = {}
  count                 = var.deploy_services ? 1 : 0
  service_account_email = google_service_account.runtime["auth"].email
  cpu                   = var.service_settings["auth"].cpu
  memory                = var.service_settings["auth"].memory
  min_instances         = var.min_instance_count
  max_instances         = var.max_instance_count
  source                = "./modules/request-service"
  name                  = var.service_names["auth"]
  project_id            = var.project_id
  region                = var.region
  image                 = var.images["auth"]
  port                  = var.service_settings["auth"].port
  network               = google_compute_network.marketing.id
  subnetwork            = google_compute_subnetwork.run.id
  env = merge(lookup(var.service_env, "auth", {}), local.common_env, {
    GOTRUE_API_HOST               = "0.0.0.0"
    GOTRUE_API_PORT               = tostring(var.service_settings["auth"].port)
    GOTRUE_DB_DRIVER              = "postgres"
    GOTRUE_JWT_AUD                = "authenticated"
    GOTRUE_JWT_DEFAULT_GROUP_NAME = "authenticated"
    API_EXTERNAL_URL              = var.firebase_origin
    GOTRUE_SITE_URL               = var.firebase_origin
    GOTRUE_MAILER_AUTOCONFIRM     = "false"
    GOTRUE_DISABLE_SIGNUP         = "true"
  })
  secrets    = lookup(var.service_secrets, "auth", {})
  depends_on = [google_project_service.apis, terraform_data.configuration, google_secret_manager_secret.runtime]
}
module "rest" {
  invokers              = { gateway = "serviceAccount:${google_service_account.runtime["gateway"].email}" }
  count                 = var.deploy_services ? 1 : 0
  service_account_email = google_service_account.runtime["rest"].email
  cpu                   = var.service_settings["rest"].cpu
  memory                = var.service_settings["rest"].memory
  min_instances         = var.min_instance_count
  max_instances         = var.max_instance_count
  source                = "./modules/request-service"
  name                  = var.service_names["rest"]
  project_id            = var.project_id
  region                = var.region
  image                 = var.images["rest"]
  port                  = var.service_settings["rest"].port
  network               = google_compute_network.marketing.id
  subnetwork            = google_compute_subnetwork.run.id
  env = merge(lookup(var.service_env, "rest", {}), local.common_env, {
    PGRST_SERVER_PORT  = tostring(var.service_settings["rest"].port)
    PGRST_DB_SCHEMAS   = "public"
    PGRST_DB_ANON_ROLE = "anon"
    PGRST_JWT_AUD      = "authenticated"
  })
  secrets    = lookup(var.service_secrets, "rest", {})
  depends_on = [google_project_service.apis, terraform_data.configuration, google_secret_manager_secret.runtime]
}
module "gateway" {
  invokers              = { bff = "serviceAccount:${google_service_account.runtime["bff"].email}" }
  count                 = var.deploy_services ? 1 : 0
  service_account_email = google_service_account.runtime["gateway"].email
  cpu                   = var.service_settings["gateway"].cpu
  memory                = var.service_settings["gateway"].memory
  min_instances         = var.min_instance_count
  max_instances         = var.max_instance_count
  source                = "./modules/request-service"
  name                  = var.service_names["gateway"]
  project_id            = var.project_id
  region                = var.region
  image                 = var.images["gateway"]
  port                  = var.service_settings["gateway"].port
  network               = google_compute_network.marketing.id
  subnetwork            = google_compute_subnetwork.run.id
  env = merge(lookup(var.service_env, "gateway", {}), local.common_env, {
    SUPABASE_AUTH_UPSTREAM = (var.deploy_services ? module.auth[0].uri : "")
    SUPABASE_REST_UPSTREAM = (var.deploy_services ? module.rest[0].uri : "")
  })
  secrets    = lookup(var.service_secrets, "gateway", {})
  depends_on = [google_project_service.apis, terraform_data.configuration, google_secret_manager_secret.runtime]
}
module "bff" {
  invokers              = { public = "allUsers" }
  count                 = var.deploy_services ? 1 : 0
  service_account_email = google_service_account.runtime["bff"].email
  cpu                   = var.service_settings["bff"].cpu
  memory                = var.service_settings["bff"].memory
  min_instances         = var.min_instance_count
  max_instances         = var.max_instance_count
  source                = "./modules/request-service"
  name                  = var.service_names["bff"]
  project_id            = var.project_id
  region                = var.region
  image                 = var.images["bff"]
  port                  = var.service_settings["bff"].port
  network               = google_compute_network.marketing.id
  subnetwork            = google_compute_subnetwork.run.id
  env = merge(lookup(var.service_env, "bff", {}), local.common_env, {
    BFF_PORT                       = tostring(var.service_settings["bff"].port)
    GCP_PROJECT_ID                 = var.project_id
    GCP_REGION                     = var.region
    AXIOM_IDLE_PROJECT_ID          = var.project_id
    AXIOM_IDLE_CONTROLLER_URL      = local.lifecycle_enabled ? google_cloud_run_v2_service.lifecycle[0].uri : ""
    AXIOM_IDLE_CONTROLLER_AUDIENCE = local.lifecycle_enabled ? google_cloud_run_v2_service.lifecycle[0].uri : ""
    SUPABASE_URL                   = (var.deploy_services ? module.gateway[0].uri : "")
    AXIOM_AUTH_MODE                = "strict"
    AXIOM_PROOF_MARKETING_URL      = var.firebase_origin
    AXIOM_REGION                   = "ap-south-1"
  })
  secrets    = lookup(var.service_secrets, "bff", {})
  depends_on = [google_project_service.apis, terraform_data.configuration, google_secret_manager_secret.runtime, google_cloud_run_v2_service_iam_member.lifecycle]
}
module "marketing" {
  invokers              = { public = "allUsers" }
  count                 = var.deploy_services ? 1 : 0
  service_account_email = google_service_account.runtime["marketing"].email
  cpu                   = var.service_settings["marketing"].cpu
  memory                = var.service_settings["marketing"].memory
  min_instances         = var.min_instance_count
  max_instances         = var.max_instance_count
  source                = "./modules/request-service"
  name                  = var.service_names["marketing"]
  project_id            = var.project_id
  region                = var.region
  image                 = var.images["marketing"]
  port                  = var.service_settings["marketing"].port
  network               = google_compute_network.marketing.id
  subnetwork            = google_compute_subnetwork.run.id
  env = merge(lookup(var.service_env, "marketing", {}), local.common_env, {
    PORT                 = tostring(var.service_settings["marketing"].port)
    BFF_URL              = (var.deploy_services ? module.bff[0].uri : "")
    NEXT_PUBLIC_SITE_URL = var.firebase_origin
  })
  secrets    = lookup(var.service_secrets, "marketing", {})
  depends_on = [google_project_service.apis, terraform_data.configuration, google_secret_manager_secret.runtime]
}
