#!/usr/bin/env bash
# Publish only images whose embedded provenance matches this exact source.
set -euo pipefail

IMAGE_TAG=${GITHUB_SHA:?GITHUB_SHA is required}
if [[ ! "$IMAGE_TAG" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Image publication requires an exact full source SHA.' >&2
  exit 1
fi
OWNER_LC=$(printf '%s' "${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}" | tr '[:upper:]' '[:lower:]')
if [[ ! "$OWNER_LC" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'Invalid image registry owner.' >&2
  exit 1
fi

for component in web marketing bff agent-runtime model-gateway temporal-worker; do
  image="ghcr.io/${OWNER_LC}/axiom-${component}:${IMAGE_TAG}"
  docker buildx build --load -f "infra/docker/Dockerfile.${component}" \
    --build-arg "AXIOM_RELEASE_SHA=${IMAGE_TAG}" \
    --label "org.opencontainers.image.revision=${IMAGE_TAG}" \
    -t "$image" .
  docker image inspect "$image" | python3 -c '
import json, sys
images = json.load(sys.stdin)
if not isinstance(images, list) or len(images) != 1:
    raise SystemExit("Expected one built image")
config = images[0].get("Config") or {}
revision = (config.get("Labels") or {}).get("org.opencontainers.image.revision")
release = [value for value in config.get("Env") or [] if value.startswith("AXIOM_RELEASE_SHA=")]
if revision != sys.argv[1] or release != ["AXIOM_RELEASE_SHA=" + sys.argv[1]]:
    raise SystemExit("Built image release provenance differs from source; refusing push")
' "$IMAGE_TAG"
  docker push "$image"
done
