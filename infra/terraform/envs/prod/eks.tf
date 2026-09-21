# EKS cluster with Fargate profiles for stateless workloads and a
# GPU node group for the self-hosted model (vLLM).
# Per Doc 06 §6: this is the standard Kubernetes API (not ECS) — so
# the same manifests run on EKS, GKE, or AKS.

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  name               = var.cluster_name
  kubernetes_version = var.kubernetes_version

  # API endpoint access
  endpoint_public_access  = true
  endpoint_private_access = true
  public_access_cidrs     = ["0.0.0.0/0"] # restrict via WAF / OIDC in production

  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnets
  control_plane_subnet_ids = module.vpc.private_subnets

  # Encryption
  cluster_encryption_config = {
    provider_key_arn = aws_kms_key.eks.arn
    resources        = ["secrets"]
  }

  # EKS managed node group — for system pods (kube-system, etc.)
  eks_managed_node_groups = {
    system = {
      name           = "system"
      instance_types = ["m6i.large", "m6a.large"]
      min_size       = 2
      max_size       = 4
      desired_size   = 2
      subnet_ids     = module.vpc.private_subnets
      labels = {
        role = "system"
      }
    }
    # GPU node group for the self-hosted model gateway (vLLM).
    # L4-class GPUs are confirmed available in ap-south-1.
    gpu = {
      name           = "gpu"
      instance_types = ["g6f.xlarge"] # L4 GPU
      min_size       = 0
      max_size       = 4
      desired_size   = 1
      subnet_ids     = module.vpc.private_subnets
      labels = {
        role = "gpu"
      }
      taints = [{
        key    = "nvidia.com/gpu"
        value  = "present"
        effect = "NO_SCHEDULE"
      }]
    }
  }

  # Fargate profiles — for the stateless workload (BFF, agent runtime,
  # model gateway, web, marketing). Fargate is the boring managed
  # Kubernetes compute; per Doc 06 §6 we use it for everything that
  # doesn't need a GPU.
  fargate_profiles = {
    default = {
      name = "default"
      selectors = [
        { namespace = "axiom-proof" },
      ]
      subnet_ids = module.vpc.private_subnets
    }
  }

  # AWS auth
  enable_irsa = true # IAM Roles for Service Accounts

  tags = {
    "k8s.io/cluster-autoscaler/enabled"             = "true"
    "k8s.io/cluster-autoscaler/${var.cluster_name}" = "owned"
  }
}

# KMS key for EKS secrets encryption
resource "aws_kms_key" "eks" {
  description             = "EKS secrets encryption key"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

resource "aws_kms_alias" "eks" {
  name          = "alias/axiom-proof-eks"
  target_key_id = aws_kms_key.eks.key_id
}

# Cluster autoscaler
resource "helm_release" "cluster_autoscaler" {
  name       = "cluster-autoscaler"
  repository = "https://kubernetes.github.io/autoscaler"
  chart      = "cluster-autoscaler"
  version    = "9.29.0"
  namespace  = "kube-system"

  set = [
    {
      name  = "autoDiscovery.clusterName"
      value = module.eks.cluster_name
    },
    {
      name  = "awsRegion"
      value = "ap-south-1"
    },
  ]
}
