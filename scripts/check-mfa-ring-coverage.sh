#!/usr/bin/env bash
# W1 — the MFA key ring must reach every surface that runs the BFF.
#
# The gap this closes was silent by construction. `AXIOM_MFA_ENCRYPTION_KEY`
# was wired everywhere; `AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS` was added to the
# Compose files when key rotation landed and to nothing else. Cloud Run and
# Helm carried only the primary key, so a rotation in a deployed environment
# had no path for the retiring list — and the failure would not have surfaced
# at deploy time. It surfaces later, as users whose factors were enrolled
# under the old key failing their second factor one at a time, which reads
# like an authenticator problem rather than a deployment one.
#
# Nothing detected the omission because no check asks the question across
# surfaces. This asks it. A new surface that runs the BFF belongs in the list.
set -euo pipefail
cd "$(dirname "$0")/.."

# Every deployment surface that starts the BFF, and so must be able to give it
# both halves of the ring.
surfaces=(
  "docker-compose.yml"
  "infra/docker/docker-compose.staging.yml"
  "infra/docker/docker-compose.preprod.yml"
  "infra/docker/docker-compose.prod.yml"
  "infra/terraform/envs/preprod/cloudrun.tf"
  "infra/helm/axiom-proof/templates/bff-deployment.yaml"
)

# Both halves. The retiring list may be absent at runtime — that is what "no
# rotation in flight" means — but the surface must be able to carry it.
required=(
  "AXIOM_MFA_ENCRYPTION_KEY"
  "AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS"
)

status=0
for surface in "${surfaces[@]}"; do
  if [ ! -f "$surface" ]; then
    echo "✗ ${surface}: listed as a BFF surface but not found"
    status=1
    continue
  fi

  missing=()
  for var in "${required[@]}"; do
    # Word-boundary match: AXIOM_MFA_ENCRYPTION_KEY is a prefix of
    # AXIOM_MFA_ENCRYPTION_KEYS_PREVIOUS, so a substring test would let the
    # primary key go missing while this check stayed green.
    grep -qE "\\b${var}\\b" "$surface" || missing+=("$var")
  done

  if [ ${#missing[@]} -gt 0 ]; then
    echo "✗ ${surface}: runs the BFF but cannot carry:"
    printf '    %s\n' "${missing[@]}"
    status=1
  else
    echo "✓ ${surface}"
  fi
done

if [ "$status" -ne 0 ]; then
  echo
  echo "A rotation cannot complete on a surface that carries only the primary key."
  echo "See docs/09 for the rotation runbook and packages/mfa/src/secret-store.ts"
  echo "for what the ring does with the retiring half."
fi

exit "$status"
