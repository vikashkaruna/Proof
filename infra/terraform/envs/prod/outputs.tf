output "vpc_id" {
  value = module.vpc.vpc_id
}

output "private_subnet_ids" {
  value = module.vpc.private_subnets
}

output "public_subnet_ids" {
  value = module.vpc.public_subnets
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  value     = module.eks.cluster_endpoint
  sensitive = true
}

output "eks_cluster_security_group_id" {
  value = module.eks.cluster_security_group_id
}

output "evidence_bucket" {
  value = aws_s3_bucket.evidence.bucket
}

output "redis_endpoint" {
  value     = aws_elasticache_replication_group.main.primary_endpoint_address
  sensitive = true
}

output "secrets_arns" {
  value = {
    supabase = aws_secretsmanager_secret.supabase.arn
    internal = aws_secretsmanager_secret.internal.arn
    temporal = aws_secretsmanager_secret.temporal.arn
  }
}

output "edge_waf_acl_arn" {
  description = "Null unless enable_edge_protection is true. Attach to an ALB or CloudFront distribution."
  value       = var.enable_edge_protection ? module.edge_waf[0].arn : null
}
