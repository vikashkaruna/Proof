# Axiom's evidence vault is an operator-owned S3 bucket in ap-south-1 with
# Object Lock COMPLIANCE mode. This GCP stack deliberately does not create a
# GCS "evidence" bucket: an unlocked GCS retention policy is not the hard-rule
# S3 Compliance vault. scripts/verify-preprod-s3.py checks bucket and exact
# retained probe version before any preprod provisioning or service rollout.
