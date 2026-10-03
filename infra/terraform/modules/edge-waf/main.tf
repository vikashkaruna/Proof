terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Per-IP rate limit plus the AWS managed common rule set. A web ACL only takes
# effect once associated with an Application Load Balancer or a CloudFront
# distribution; see envs/prod/waf.tf for why enabling it alone changes nothing yet.
variable "name_prefix" {
  type = string
}

resource "aws_wafv2_web_acl" "edge" {
  name        = "${var.name_prefix}-edge"
  description = "Axiom Proof public edge: per-IP rate limit and AWS managed common rules"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-managed-common"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-common"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-edge"
    sampled_requests_enabled   = true
  }
}

output "arn" {
  value = aws_wafv2_web_acl.edge.arn
}
