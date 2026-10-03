variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "axiom-proof-prod"
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.10.0.0/16"
}

variable "kubernetes_version" {
  description = "Kubernetes version for the EKS control plane"
  type        = string
  default     = "1.29"
}

variable "domain_name" {
  description = "Primary domain for the deployment"
  type        = string
  default     = "axiomproof.ai"
}

variable "enable_edge_protection" {
  description = "Create an AWS WAFv2 web acl (rate limit plus AWS managed common rules) for the public edge. Off by default; creating it protects nothing until it is attached to an ALB or CloudFront distribution (the current ingress is nginx behind an NLB, which WAF cannot protect)."
  type        = bool
  default     = false
}
