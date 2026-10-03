variable "project_id" {
  description = "Google Cloud Platform Project ID"
  type        = string
  default     = "axiom-proof"
}

variable "region" {
  description = "GCP Region (Default strictly Mumbai asia-south1 for Indian data residency)"
  type        = string
  default     = "asia-south1"
}

variable "environment" {
  description = "Deployment environment name"
  type        = string
  default     = "preprod"
  validation {
    condition     = contains(["staging", "preprod", "production", "onprem"], var.environment)
    error_message = "Use a supported strict deployment environment: staging, preprod, production or onprem."
  }
}

variable "cloud_sql_tier" {
  description = "Compute tier for Cloud SQL PostgreSQL instance"
  type        = string
  default     = "db-f1-micro" # "db-custom-2-7680" # 2 vCPU, 7.5GB RAM; can use db-f1-micro for cost saving
}

variable "cloud_sql_disk_size_gb" {
  description = "Disk size in GB for Cloud SQL instance"
  type        = number
  default     = 10 # 20
}

variable "cloud_sql_instance_version" {
  description = "Token/version used to force regeneration of the Cloud SQL instance name suffix"
  type        = string
  default     = "v1"
}

variable "cloud_sql_authorized_networks" {
  description = "Named, narrowly scoped IPv4 CIDRs for a temporary external migration runner. Empty keeps Cloud SQL private-only. Never use a public catch-all."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([
      for name, cidr in var.cloud_sql_authorized_networks :
      length(name) > 0 && length(name) <= 64 &&
      can(cidrnetmask(cidr)) && can(regex("/32$", cidr))
    ])
    error_message = "Cloud SQL authorized networks must be named valid IPv4 /32 runner CIDRs; broad networks are forbidden."
  }
}

variable "release_sha" {
  description = "Exact reviewed Git revision in every released image"
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.release_sha))
    error_message = "Preprod requires an exact 40-character release SHA."
  }
}

variable "release_manifest_file" {
  description = "Absolute path to the nine-image immutable digest manifest"
  type        = string
  default     = ""
}

variable "evidence_bucket" {
  description = "Approved ap-south-1 S3 Object Lock Compliance bucket"
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.evidence_bucket))
    error_message = "An approved S3 evidence bucket is required."
  }
}

variable "evidence_endpoint" {
  description = "Approved Mumbai S3 endpoint"
  type        = string
  default     = ""
  validation {
    condition     = var.evidence_endpoint == "https://s3.ap-south-1.amazonaws.com"
    error_message = "Evidence must use the ap-south-1 AWS S3 endpoint."
  }
}

variable "evidence_access_key_id" {
  type      = string
  default   = ""
  sensitive = true
  validation {
    condition     = length(var.evidence_access_key_id) >= 16
    error_message = "A scoped evidence S3 access key is required."
  }
}

variable "evidence_secret_access_key" {
  type      = string
  default   = ""
  sensitive = true
  validation {
    condition     = length(var.evidence_secret_access_key) >= 32
    error_message = "A scoped evidence S3 secret key is required."
  }
}

# Upstash Redis
variable "upstash_redis_url" {
  description = "Upstash Redis connection URL (rediss://...)"
  type        = string
  default     = ""
  sensitive   = true
}

# Temporal Cloud GCP Subscription
variable "temporal_address" {
  description = "Temporal Cloud host address on GCP"
  type        = string
  default     = "axiom-proof.dkxyc.tmprl.cloud:7233"
}

variable "temporal_namespace" {
  description = "Temporal Cloud namespace"
  type        = string
  default     = "axiom-proof"
}

variable "temporal_api_key" {
  description = "Temporal Cloud API Key"
  type        = string
  default     = ""
  sensitive   = true
}

# Model Provider API Keys
variable "anthropic_api_key" {
  description = "Anthropic Claude API Key (Primary agent model)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "openai_api_key" {
  description = "OpenAI API Key (Fallback 1 model)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "gemini_api_key" {
  description = "Google Gemini API Key (Fallback 2 model)"
  type        = string
  default     = ""
  sensitive   = true
}

# Approval Engine & Auth Secrets
variable "approval_signing_key" {
  description = "HMAC secret key for signing scope-bound approval tokens (minimum 32 characters)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "agent_runtime_internal_token" {
  description = "Service-to-service internal token between BFF and Agent Runtime"
  type        = string
  default     = ""
  sensitive   = true
}

variable "model_gateway_api_key" {
  description = "Service-to-service API key for Model Gateway"
  type        = string
  default     = ""
  sensitive   = true
}

# Transactional Email (Resend)
variable "resend_api_key" {
  description = "Resend API key for transactional email delivery"
  type        = string
  default     = ""
  sensitive   = true
}

variable "axiom_from_email" {
  description = "Sender email for automated notifications and reports"
  type        = string
  default     = "Axiom Proof <platform@axiomproof.ai>"
}

variable "axiom_sales_email" {
  description = "Axiom sales recipient email"
  type        = string
  default     = "sales@axiomproof.ai"
}

variable "axiom_founder_email" {
  description = "Axiom founder recipient email"
  type        = string
  default     = "founder@axiomminds.ai"
}

variable "contact_recipient_email" {
  description = "Recipient email address for founder contact inquiries"
  type        = string
  default     = "hello@axiomminds.ai"
}

variable "mfa_encryption_key" {
  description = "Persistent BFF-only MFA encryption key, distinct from signing keys. Empty generates a stable random key."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = var.mfa_encryption_key == "" || length(var.mfa_encryption_key) >= 32
    error_message = "MFA encryption key must have at least 32 characters."
  }
}

# The retiring half of the key ring. Comma-separated, newest first, and empty
# except while a rotation is in flight — which is why it is not a member of
# `local.managed_secrets`: Secret Manager will not store an empty payload, so a
# permanently-empty member would fail every apply that is not a rotation.
# See secrets.tf for how absence is expressed.
variable "mfa_encryption_keys_previous" {
  description = "Retiring MFA encryption keys, comma-separated, newest first. Empty unless a rotation is in flight."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition = var.mfa_encryption_keys_previous == "" || alltrue([
      for key in split(",", var.mfa_encryption_keys_previous) : length(trimspace(key)) >= 32
    ])
    error_message = "Every retiring MFA encryption key must have at least 32 characters."
  }
}

# ─── Self-hosted Supabase (W0.1) ──────────────────────────────────────────────
# These cannot be generated here the way the other secrets are. The anon and
# service_role keys are JWTs SIGNED WITH the JWT secret, so a random value per
# resource would produce three unrelated strings and no token would validate.
# They are minted together by scripts/mint-supabase-keys.mjs and carried in
# .env like every other value; sync-env.sh refuses to deploy without them.
variable "supabase_jwt_secret" {
  description = "HS256 secret GoTrue signs with and PostgREST validates against. Must be the one the anon/service keys were signed with."
  type        = string
  default     = ""
  sensitive   = true
}

variable "supabase_anon_key" {
  description = "Supabase anon JWT, signed with supabase_jwt_secret. Public by design; RLS is the boundary, not this value."
  type        = string
  default     = ""
  sensitive   = true
}

variable "supabase_service_key" {
  description = "Supabase service_role JWT, signed with supabase_jwt_secret. Bypasses RLS by design; server-side only."
  type        = string
  default     = ""
  sensitive   = true
}

variable "supabase_statutory_proof_writer_key" {
  description = "BFF-only restricted statutory_proof_writer JWT signed with supabase_jwt_secret."
  type        = string
  default     = ""
  sensitive   = true
}

variable "supabase_archive_writer_key" {
  description = "BFF-only approval_archive_writer JWT signed with supabase_jwt_secret; never distribute to agents or workers."
  type        = string
  default     = ""
  sensitive   = true
  validation {
    condition     = length(var.supabase_archive_writer_key) > 0
    error_message = "A minted BFF-only approval_archive_writer JWT is required."
  }
}

variable "supabase_human_action_writer_key" {
  description = "BFF-only restricted human_action_writer JWT signed with supabase_jwt_secret."
  type        = string
  default     = ""
  sensitive   = true
}

variable "supabase_evidence_ingestion_writer_key" {
  description = "BFF-only restricted evidence_ingestion_writer JWT signed with supabase_jwt_secret."
  type        = string
  default     = ""
  sensitive   = true
}


variable "supabase_agent_ledger_writer_key" {
  description = "Restricted agent_ledger_writer JWT (append_agent_ledger only) held by the BFF and agent runtime, signed with supabase_jwt_secret."
  type        = string
  default     = ""
  sensitive   = true
}


variable "report_email_mode" {
  type        = string
  default     = "disabled"
  description = "BFF report delivery, enabled only after provider/domain verification."
  validation {
    condition     = contains(["disabled", "delivery"], var.report_email_mode)
    error_message = "Use disabled or delivery."
  }
}

variable "contact_email_mode" {
  type        = string
  default     = "disabled"
  description = "BFF founder-contact notification mail; inquiries are always persisted first (C-W0-6)."
  validation {
    condition     = contains(["disabled", "delivery"], var.contact_email_mode)
    error_message = "Use disabled or delivery."
  }
}

variable "invitation_email_mode" {
  type        = string
  default     = "disabled"
  description = "BFF tenant-invitation mail (C-W1-3); invitations work with a shared one-time link when disabled."
  validation {
    condition     = contains(["disabled", "delivery"], var.invitation_email_mode)
    error_message = "Use disabled or delivery."
  }
}

variable "assessment_dispatch_retention_days" {
  description = "Days to retain private dispatch ciphertext after independent completion; separate from sealed evidence."
  type        = number
  default     = 90
  validation {
    condition     = var.assessment_dispatch_retention_days >= 1 && var.assessment_dispatch_retention_days <= 36500 && floor(var.assessment_dispatch_retention_days) == var.assessment_dispatch_retention_days
    error_message = "Assessment dispatch retention must be an integer from 1 to 36500 days."
  }
}

variable "min_instance_count" {
  description = "Warm instances kept per always-on Cloud Run service. 0 scales to zero when idle (lowest cost, first request after idle is slower); raise it when latency matters."
  type        = number
  default     = 0
  validation {
    condition     = var.min_instance_count >= 0 && var.min_instance_count <= 2 && floor(var.min_instance_count) == var.min_instance_count
    error_message = "min_instance_count must be a whole number from 0 to 2."
  }
}

variable "internal_services_private" {
  description = "Keep agent-runtime and model-gateway off the public internet: internal ingress, IAM invoker limited to the calling services, and Google ID-token auth on every call. false restores the earlier public endpoints guarded only by the shared token."
  type        = bool
  default     = true
}

