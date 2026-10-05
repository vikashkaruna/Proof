#!/usr/bin/env bash
# Enforce documentation confidentiality without reading ignored document prose.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
private_paths=(
  docs
  private-docs
  .design-sync/NOTES.md
  .design-sync/conventions.md
  .github/branch-protection.md
  'Axiom Proof App/README.md'
  'Axiom Proof Handoff Map/README.md'
  'Axiom Proof Site/README.md'
  Axiom-Proof_Readiness_Matrix.md
  VK_QUICK_REF_PROOF_MODULES_SETUP.md
  design-system/README.md
  infra/credential-issuer/README.md
  infra/helm/axiom-proof/ci/README.md
  infra/terraform/modules/workload-vms/README.md
  infra/workload/CONTROLLER_TRANSITIONS.md
  infra/workload/README.md
  packages/report-kit/README.md
  services/agent-runtime/README.md
  services/model-gateway/README.md
)
tracked_docs=$(git ls-files -- "${private_paths[@]}")
if [[ -n "$tracked_docs" ]]; then
  printf '%s\n' 'Private documentation must not be tracked:' "$tracked_docs" >&2
  exit 1
fi
if ! git check-ignore --no-index -q private-docs/future-manual.md; then
  printf '%s\n' 'private-docs/ must be covered by the repository ignore rules.' >&2
  exit 1
fi
printf '%s\n' 'Private documentation boundary passed; no documentation content was read.'
