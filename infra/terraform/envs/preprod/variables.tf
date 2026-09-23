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

variable "retention_days" {
  description = "Evidence vault retention duration in days (WORM Compliance lock)"
  type        = number
  default     = 7 # 2555 days = 7 years statutory requirement under DPDPA, for testing we can use 7 days
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


variable "report_email_mode" {
  type        = string
  default     = "disabled"
  description = "BFF report delivery, enabled only after provider/domain verification."
  validation {
    condition     = contains(["disabled", "delivery"], var.report_email_mode)
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
