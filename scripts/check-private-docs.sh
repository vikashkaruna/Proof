#!/usr/bin/env bash
# Enforce documentation confidentiality without reading ignored document prose.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# Tracked documentation allow-list: docs/README.md, the two private-zone READMEs and
# docs/shared-docs/. Anything else under docs/, and the legacy root private-docs/, is private.
private_paths=(
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
tracked_docs=$(
  {
    git ls-files -- "${private_paths[@]}"
    git ls-files -- docs \
      | grep -vE '^docs/(README\.md|private-docs/README\.md|private-plans/README\.md|shared-docs/.+)$' || true
  }
)
if [[ -n "$tracked_docs" ]]; then
  printf '%s\n' 'Private documentation must not be tracked:' "$tracked_docs" >&2
  exit 1
fi
for probe in docs/private-docs/future-manual.md docs/private-plans/future-plan.md docs/future-flat-doc.md; do
  if ! git check-ignore --no-index -q "$probe"; then
    printf '%s\n' "$probe must be covered by the repository ignore rules." >&2
    exit 1
  fi
done
for kept in docs/README.md docs/private-docs/README.md docs/private-plans/README.md docs/shared-docs/overview.md; do
  if git check-ignore --no-index -q "$kept"; then
    printf '%s\n' "$kept must stay trackable; the ignore rules are too broad." >&2
    exit 1
  fi
done
printf '%s\n' 'Private documentation boundary passed; no documentation content was read.'
