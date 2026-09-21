# VPC for the EKS cluster. 3 AZs in ap-south-1, public + private subnets,
# NAT gateway for egress, flow logs to CloudWatch.

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.5"

  name = "axiom-proof-vpc"
  cidr = var.vpc_cidr

  azs             = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
  public_subnets  = ["10.10.1.0/24", "10.10.2.0/24", "10.10.3.0/24"]
  private_subnets = ["10.10.11.0/24", "10.10.12.0/24", "10.10.13.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = false # HA across AZs
  enable_dns_hostnames = true
  enable_dns_support   = true

  enable_flow_log                      = true
  create_flow_log_cloudwatch_log_group = true
  create_flow_log_iam_role             = true
  flow_log_retention_in_days           = 30

  public_subnet_tags = {
    "kubernetes.io/role/elb"                    = 1
    "kubernetes.io/cluster/${var.cluster_name}" = "owned"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"           = 1
    "kubernetes.io/cluster/${var.cluster_name}" = "owned"
  }
}
