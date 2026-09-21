# Axiom Proof — Production AWS infrastructure
# Per Doc 05 / Doc 06, the deployment is single-CSP (AWS, ap-south-1)
# consolidating DB+Auth (Supabase as a separate managed vendor),
# object store (raw S3 with Object Lock), queue (ElastiCache Valkey),
# and compute (EKS).

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.23"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.11"
    }
  }

  # Remote state in S3 + DynamoDB locking. Required for team use.
  backend "s3" {
    # backend is configured per-environment via -backend-config
    # bucket         = "axiom-proof-terraform-state-ap-south-1"
    # key            = "prod/terraform.tfstate"
    # region         = "ap-south-1"
    # dynamodb_table = "axiom-proof-terraform-locks"
    # encrypt        = true
  }
}

provider "aws" {
  region = "ap-south-1"
  default_tags {
    tags = {
      Project     = "axiom-proof"
      Environment = "prod"
      ManagedBy   = "terraform"
      Owner       = "axiom-minds"
    }
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}

# ─── Variables ──────────────────────────────────────────────────────
# Declared in variables.tf, with descriptions. They were duplicated here
# as well — bare, and with identical defaults — which is why this module
# would not load: Terraform rejects a variable declared twice in one
# module, so prod could not plan at all until the copies came out.

# ─── Locals ─────────────────────────────────────────────────────────
locals {
  common_tags = {
    Project = "axiom-proof"
  }
}

# ─── Modules ────────────────────────────────────────────────────────
# Each module is in its own file for clarity.
