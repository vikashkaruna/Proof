#!/usr/bin/env bash
# W0.1 — every declared Terraform variable must be written from the .env file.
#
# The gap this closes was invisible and expensive. `variables.tf` declared 23
# variables; `deploy-preprod-gcp.sh` mapped 15 of them by hand, one `if` per
# line, and the rest silently took their Terraform defaults. So an operator
# who set AXIOM_MFA_ENCRYPTION_KEY in .env.preprod — exactly as the template
# instructs — had it ignored, and Terraform minted a different random key into
# Secret Manager. Nothing failed: the BFF received *a* valid key, config checks
# passed, and the operator's key management simply referred to the wrong
# secret. `retention_days` was the same shape of defect with a worse blast
# radius: no environment key existed at all, so an evidence bucket could be
# created with a test-length COMPLIANCE lock.
#
# A hand-maintained mapping drifts the moment someone adds a variable. This
# makes the drift fail the build instead.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
for tf_dir in infra/terraform/envs/*/; do
  env_name="$(basename "$tf_dir")"
  # Mirror sync-env.sh: the `prod` Terraform directory is configured by
  # .env.production.
  [ "$env_name" = "prod" ] && env_name="production"
  vars_file="${tf_dir}variables.tf"
  [ -f "$vars_file" ] || continue

  # sync-env.sh writes the tfvars; render it for this environment and compare.
  tfvars="${tf_dir}terraform.tfvars"
  restore=false
  if [ -f "$tfvars" ]; then cp "$tfvars" "${tfvars}.coverage-backup"; restore=true; fi
  ./scripts/sync-env.sh "$env_name" terraform >/dev/null 2>&1 || true

  if [ ! -f "$tfvars" ]; then
    echo "✗ ${env_name}: sync-env.sh produced no terraform.tfvars"
    status=1
    [ "$restore" = true ] && mv "${tfvars}.coverage-backup" "$tfvars"
    continue
  fi

  missing=()
  while read -r name; do
    grep -qE "^[[:space:]]*${name}[[:space:]]*=" "$tfvars" || missing+=("$name")
  done < <(grep -oE '^variable "[a-z0-9_]+"' "$vars_file" | sed 's/variable "//;s/"//')

  if [ ${#missing[@]} -gt 0 ]; then
    echo "✗ ${env_name}: declared in variables.tf but never written from .env:"
    printf '    %s\n' "${missing[@]}"
    echo "    Add them to do_terraform() in scripts/sync-env.sh."
    status=1
  else
    declared=$(grep -cE '^variable "' "$vars_file")
    echo "✓ ${env_name}: all ${declared} declared variables are written from .env"
  fi

  if [ "$restore" = true ]; then
    mv "${tfvars}.coverage-backup" "$tfvars"
  else
    rm -f "$tfvars"
  fi
done

exit "$status"
