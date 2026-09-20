# Secrets management. All Axiom secrets are stored in AWS Secrets
# Manager, accessed from the EKS pods via IRSA. The values are NEVER
# in plaintext in this file.

resource "aws_secretsmanager_secret" "supabase" {
  name                    = "axiom-proof/supabase"
  description             = "Supabase URL, anon key, service-role key"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.evidence.arn
}

resource "aws_secretsmanager_secret" "internal" {
  name                    = "axiom-proof/internal"
  description             = "Approval signing key, agent-runtime internal token, model-gateway key, distinct MFA encryption key"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.evidence.arn
}

resource "aws_secretsmanager_secret" "temporal" {
  name                    = "axiom-proof/temporal"
  description             = "Temporal Cloud API key"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.evidence.arn
}

resource "aws_secretsmanager_secret" "per_tenant_signing" {
  name                    = "axiom-proof/approval-keys"
  description             = "Per-tenant approval signing keys (JSON map of tenant_id → key)"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.evidence.arn
}
