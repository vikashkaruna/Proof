# Optional edge protection. Nothing is created unless enable_edge_protection is
# true (AXIOM_ENABLE_EDGE_PROTECTION in .env.production).
#
# A web ACL only takes effect once associated with an Application Load Balancer
# or a CloudFront distribution. The Helm chart today uses nginx ingress behind
# a Network Load Balancer, which WAF cannot protect, so enabling this alone
# changes nothing at runtime. It is here so the ACL, its rules and its ARN are
# decided and reviewed before the edge is switched to ALB or CloudFront.
module "edge_waf" {
  count       = var.enable_edge_protection ? 1 : 0
  source      = "../../modules/edge-waf"
  name_prefix = var.cluster_name
}
