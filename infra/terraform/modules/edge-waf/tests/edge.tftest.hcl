mock_provider "aws" {}

variables {
  name_prefix = "axiom-test"
}

run "one_regional_acl_with_rate_limit_and_managed_rules" {
  command = plan
  assert {
    condition = (
      aws_wafv2_web_acl.edge.scope == "REGIONAL" &&
      length(aws_wafv2_web_acl.edge.rule) == 2 &&
      aws_wafv2_web_acl.edge.name == "axiom-test-edge"
    )
    error_message = "The edge ACL must be regional with the rate-limit and managed-common rules."
  }
}
