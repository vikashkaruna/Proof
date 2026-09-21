# S3 evidence bucket with Object Lock Compliance mode.
# Per Doc 04 §6.2 and Doc 05 §5 — this is the substrate of "verifiable
# proof." Compliance mode means no one (including root) can shorten
# the retention period or delete the object before the retention
# period expires.

resource "aws_s3_bucket" "evidence" {
  bucket              = "axiom-proof-evidence-ap-south-1"
  object_lock_enabled = true
  # Force destroy is FALSE — we cannot delete a bucket with
  # Object Lock Compliance mode retention unexpired.
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    default_retention {
      mode = "COMPLIANCE"
      # Default 7 years. Per-artifact retention is set per-object.
      years = 7
    }
  }
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.evidence.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    id     = "transition-to-ia"
    status = "Enabled"

    # Applies to every object. Stating it empty rather than omitting it:
    # a rule with neither `filter` nor `prefix` is already a provider
    # warning and becomes an error in a later major.
    filter {}

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 365
      storage_class = "GLACIER"
    }
  }
}

resource "aws_s3_bucket_versioning" "evidence_lock" {
  bucket = aws_s3_bucket.evidence.id
  versioning_configuration {
    status = "Enabled"
  }

  # Object Lock requires versioning to be enabled. The combination
  # of versioning + Compliance mode retention is what makes the
  # evidence vault WORM.
  depends_on = [aws_s3_bucket_object_lock_configuration.evidence]
}

# KMS key for evidence bucket
resource "aws_kms_key" "evidence" {
  description             = "S3 evidence vault encryption key"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "evidence" {
  name          = "alias/axiom-proof-evidence"
  target_key_id = aws_kms_key.evidence.key_id
}

# IAM policy for the agent runtime's IRSA role
data "aws_iam_policy_document" "evidence_access" {
  statement {
    sid    = "AllowEvidenceRW"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:PutObjectLegalHold",
      "s3:PutObjectRetention",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectRetention",
      "s3:GetObjectLegalHold",
      "s3:GetBucketObjectLockConfiguration",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.evidence.arn,
      "${aws_s3_bucket.evidence.arn}/*",
    ]
  }
  statement {
    sid       = "DenyDeleteForWORM"
    effect    = "Deny"
    actions   = ["s3:DeleteObject", "s3:DeleteObjectVersion"]
    resources = ["${aws_s3_bucket.evidence.arn}/*"]
  }
}

resource "aws_iam_policy" "evidence_access" {
  name   = "axiom-proof-evidence-access"
  policy = data.aws_iam_policy_document.evidence_access.json
}
