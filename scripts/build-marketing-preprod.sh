#!/usr/bin/env bash
# Seven-image release for the marketing acceptance profile, from one private file.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/scripts/lib/ops-env.sh"
ENV_FILE=""; DRY_RUN=false; BUILD_ONLY=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?missing environment file}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --build-only) BUILD_ONLY=true; shift ;;
    *) echo 'Usage: build-marketing-preprod.sh --env-file PRIVATE_FILE [--dry-run] [--build-only]' >&2; exit 2 ;;
  esac
done
[ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || { echo 'Explicit private environment file required' >&2; exit 2; }
case "$ENV_FILE" in *.example) echo 'Refusing an example deployment file' >&2; exit 2 ;; esac
ops_load_env_file "$ENV_FILE" "$REPO_ROOT"
for key in ENVIRONMENT GCP_PROJECT_ID GCP_REGION AXIOM_DEPLOYMENT_PROFILE AXIOM_ARTIFACT_REPOSITORY AXIOM_PROOF_MARKETING_URL AXIOM_PROOF_PLATFORM_URL UPSTREAM_POSTGREST_IMAGE MARKETING_PYTHON_RUNTIME_IMAGE MARKETING_POSTGRES_CLIENT_IMAGE MARKETING_NODE_RUNTIME_IMAGE MARKETING_AUTH_GO_BUILD_IMAGE MARKETING_AUTH_SOURCE_ARCHIVE_URL MARKETING_POSTGRES_CLIENT_APK_PACKAGE CLOUD_SQL_INSTANCE_NAME AXIOM_IDLE_STATE_BUCKET AXIOM_IDLE_STATE_OBJECT; do
  ops_require_value "$key"
done
ops_require_value MARKETING_TRIVY_IMAGE
[[ "$MARKETING_TRIVY_IMAGE" =~ ^aquasec/trivy@sha256:[a-f0-9]{64}$ ]] || { echo 'Explicit immutable official image scanner required' >&2; exit 2; }
[ "$ENVIRONMENT" = preprod ] && [ "$GCP_REGION" = asia-south1 ] && [ "$AXIOM_DEPLOYMENT_PROFILE" = marketing ] || { echo 'Requires the Mumbai marketing preprod profile' >&2; exit 2; }
[[ "$GCP_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || exit 2
[[ "$AXIOM_ARTIFACT_REPOSITORY" =~ ^axiom-proof-preprod-[a-z0-9-]+$ ]] || exit 2
for key in UPSTREAM_POSTGREST_IMAGE MARKETING_PYTHON_RUNTIME_IMAGE MARKETING_POSTGRES_CLIENT_IMAGE MARKETING_NODE_RUNTIME_IMAGE; do
  [[ "${!key}" =~ ^[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || { echo "Invalid immutable image: $key" >&2; exit 2; }
done
[[ "$MARKETING_AUTH_GO_BUILD_IMAGE" =~ ^golang@sha256:[a-f0-9]{64}$ ]] || { echo 'Explicit immutable official Go builder required' >&2; exit 2; }
[[ "$MARKETING_AUTH_SOURCE_ARCHIVE_URL" =~ ^https://codeload.github.com/supabase/auth/tar.gz/[a-f0-9]{40}$ ]] || { echo 'Exact official Auth source archive required' >&2; exit 2; }
[[ "$MARKETING_POSTGRES_CLIENT_APK_PACKAGE" =~ ^postgresql16-client=[0-9]+\.[0-9]+-r[0-9]+$ ]] || { echo 'Explicit minimal PostgreSQL client package version required' >&2; exit 2; }
cd "$REPO_ROOT"
SOURCE_SHA="$(git rev-parse HEAD)"
REGISTRY="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AXIOM_ARTIFACT_REPOSITORY}"
TAG="release-${SOURCE_SHA}"
[ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo 'Refusing image release from an uncommitted worktree' >&2; exit 1; }
if [ -n "${AXIOM_RELEASE_SHA:-}" ] && [ "$AXIOM_RELEASE_SHA" != "$SOURCE_SHA" ]; then
  echo 'Environment release SHA differs from the exact source revision' >&2; exit 1
fi
if [ "$DRY_RUN" = true ]; then
  echo "Validated seven-image release plan for project=$GCP_PROJECT_ID region=$GCP_REGION repository=$AXIOM_ARTIFACT_REPOSITORY source=$SOURCE_SHA"
  echo 'Would build marketing, marketing-only BFF, private gateway, migration job, lifecycle controller and reviewed patched Auth; mirror pinned REST; record immutable digests.'
  if [ "$BUILD_ONLY" = true ]; then
    echo 'Build-only stops after protected candidate scans for independent Auth review; no image publication or cloud deployment.'
  fi
  exit 0
fi
gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet
mkdir -p .axiom-runtime/marketing-preprod
umask 077
export SOURCE_SHA REGISTRY
# This dynamic build identity is derived from the verified clean source above;
# a conflicting explicit environment release was already refused.
export AXIOM_RELEASE_SHA="$SOURCE_SHA"
AUTH_CONTEXT="$(mktemp -d .axiom-runtime/marketing-preprod/auth-source.XXXXXXXX)"
export AUTH_CONTEXT
python3 - <<'PYAUTH'
import hashlib, importlib.util, json, os
from pathlib import Path
from urllib.request import ProxyHandler, build_opener, HTTPRedirectHandler
sources = Path('infra/docker/auth-security')
descriptor = json.loads((sources / 'source.json').read_bytes())
url = os.environ['MARKETING_AUTH_SOURCE_ARCHIVE_URL']
expected = 'https://codeload.github.com/supabase/auth/tar.gz/' + descriptor['upstream_commit']
if url != expected:
    raise ValueError('Auth source URL differs from the reviewed frozen source')
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Auth archive redirects refused')
with build_opener(ProxyHandler({}), NoRedirect()).open(url, timeout=60) as response:
    raw = response.read(64 * 1024 * 1024 + 1)
if len(raw) > 64 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != descriptor['upstream_archive_sha256']:
    raise ValueError('Auth official archive hash or bound mismatch')
parent = Path(os.environ['AUTH_CONTEXT'])
archive = parent / 'source.tar.gz'
archive.write_bytes(raw)
spec = importlib.util.spec_from_file_location('auth_prepare', sources / 'prepare_auth_build.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
snapshot = helper.prepare(archive, parent / 'context', os.environ['MARKETING_AUTH_GO_BUILD_IMAGE'])
(parent / 'snapshot-sha256').write_text(snapshot + '\n')
PYAUTH
python3 - <<'PYBUILD'
import hashlib, json, os, shutil
from pathlib import Path
context = Path('.axiom-runtime/marketing-preprod/lifecycle-build')
context.mkdir(parents=True, exist_ok=True, mode=0o700)
for name in ['Dockerfile', '.dockerignore', 'lifecycle.py', 'google_rest.py', 'server.py']:
    shutil.copyfile(Path('services/marketing-lifecycle') / name, context / name)
selected = {'environment': os.environ['ENVIRONMENT'], 'project': os.environ['GCP_PROJECT_ID'], 'instance': os.environ['CLOUD_SQL_INSTANCE_NAME'], 'bucket': os.environ['AXIOM_IDLE_STATE_BUCKET'], 'object': os.environ['AXIOM_IDLE_STATE_OBJECT']}
raw = (json.dumps(selected, sort_keys=True, separators=(',', ':')) + '\n').encode()
(context / 'approved-target.json').write_bytes(raw)
(context.parent / 'target-manifest-sha256').write_text(hashlib.sha256(raw).hexdigest() + '\n')
PYBUILD
pnpm exec tsx scripts/export-marketing-library.mts --output infra/supabase/marketing-library.json
for component in marketing bff gateway migrations lifecycle; do
  args=(--platform linux/amd64 --provenance=false --build-arg "AXIOM_RELEASE_SHA=$SOURCE_SHA" --label "org.opencontainers.image.revision=$SOURCE_SHA")
  case "$component" in
    marketing) file=infra/docker/Dockerfile.marketing
      args+=(--build-arg "NODE_RUNTIME_IMAGE=$MARKETING_NODE_RUNTIME_IMAGE" --build-arg "AXIOM_PROOF_MARKETING_URL=$AXIOM_PROOF_MARKETING_URL" --build-arg "AXIOM_PROOF_PLATFORM_URL=$AXIOM_PROOF_PLATFORM_URL") ;;
    bff) file=infra/docker/Dockerfile.bff; args+=(--target marketing-runtime --build-arg "NODE_RUNTIME_IMAGE=$MARKETING_NODE_RUNTIME_IMAGE") ;;
    gateway) file=infra/docker/Dockerfile.marketing-db-gateway; args+=(--build-arg "PYTHON_RUNTIME_IMAGE=$MARKETING_PYTHON_RUNTIME_IMAGE") ;;
    migrations) file=infra/docker/Dockerfile.marketing-migrations; args+=(--build-arg "POSTGRES_CLIENT_IMAGE=$MARKETING_POSTGRES_CLIENT_IMAGE" --build-arg "POSTGRES_CLIENT_APK_PACKAGE=$MARKETING_POSTGRES_CLIENT_APK_PACKAGE") ;;
    lifecycle) file=.axiom-runtime/marketing-preprod/lifecycle-build/Dockerfile; args+=(--build-arg "PYTHON_RUNTIME_IMAGE=$MARKETING_PYTHON_RUNTIME_IMAGE") ;;
  esac
  target="$REGISTRY/axiom-proof-preprod-${component}:$TAG"
  context=.
  [ "$component" != lifecycle ] || context=.axiom-runtime/marketing-preprod/lifecycle-build
  docker build "${args[@]}" -f "$file" -t "$target" "$context"
  if [ "$component" = migrations ]; then
    # Exercise the packaged helpers/library as the actual unprivileged Job user.
    docker run --rm --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges --user 65532:65532 \
      --entrypoint python3 "$target" -c '
import importlib.util, json, os
from pathlib import Path
for name in ("marketing-db-job", "marketing-state-adoption", "marketing-acceptance-job"):
    spec = importlib.util.spec_from_file_location(name, "/app/scripts/" + name + ".py")
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    if name == "marketing-db-job":
        helper.library_seed_program(Path("/app/infra/supabase/marketing-library.json"), os.environ["AXIOM_RELEASE_SHA"])
assert os.getuid() == 65532
assert json.loads(Path("/app/infra/supabase/marketing-library.json").read_bytes())
assert Path("/etc/ssl/certs/ca-certificates.crt").stat().st_size > 0
print("Migration image unprivileged helper/library/TLS smoke passed")'
  fi
done
AUTH_SNAPSHOT_SHA256="$(cat "$AUTH_CONTEXT/snapshot-sha256")"
docker build --platform linux/amd64 --provenance=false --target runtime \
  --build-arg "GO_BUILD_IMAGE=$MARKETING_AUTH_GO_BUILD_IMAGE" \
  --build-arg "SOURCE_SNAPSHOT_SHA256=$AUTH_SNAPSHOT_SHA256" \
  --label "org.opencontainers.image.revision=$SOURCE_SHA" \
  -t "$REGISTRY/axiom-proof-preprod-auth:$TAG" "$AUTH_CONTEXT/context"
for component in rest; do
  upstream="$UPSTREAM_POSTGREST_IMAGE"
  target="$REGISTRY/axiom-proof-preprod-${component}:$TAG"
  docker pull --platform linux/amd64 "$upstream"
  docker tag "$upstream" "$target"
done
python3 - <<'PYSCAN'
import hashlib, json, os, subprocess
from pathlib import Path
directory = Path('.axiom-runtime/marketing-preprod/image-scans')
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
cache = directory / 'cache'
cache.mkdir(mode=0o700, exist_ok=True)
images = {}
for component in ['marketing', 'bff', 'gateway', 'auth', 'rest', 'migrations', 'lifecycle']:
    tag = f"{os.environ['REGISTRY']}/axiom-proof-preprod-{component}:release-{os.environ['SOURCE_SHA']}"
    image_id = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag], text=True).strip()
    report = directory / f'{component}.scan.private.json'
    subprocess.run(['docker', 'run', '--rm', '--cpus=1', '--memory=1g', '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
        '-v', str(cache.resolve()) + ':/root/.cache/trivy',
        '-v', str(directory.resolve()) + ':/reports',
        os.environ['MARKETING_TRIVY_IMAGE'], 'image', '--scanners', 'vuln,secret',
        '--severity', 'HIGH,CRITICAL', '--format', 'json', '--output', '/reports/' + report.name,
        image_id], check=True, timeout=900)
    report.chmod(0o600)
    images[component] = {'image_id': image_id, 'report_path': str(report.resolve()),
                         'report_sha256': hashlib.sha256(report.read_bytes()).hexdigest()}
manifest = directory / 'candidate.private.json'
manifest.write_text(json.dumps({'release_sha': os.environ['SOURCE_SHA'],
    'scanner_image': os.environ['MARKETING_TRIVY_IMAGE'], 'images': images}, indent=2) + '\n')
manifest.chmod(0o600)
PYSCAN
if [ "$BUILD_ONLY" = true ]; then
  echo 'Seven images built and candidate scans retained privately. Independent Auth review and image clearance are still required before publication.'
  exit 0
fi
python3 scripts/marketing-image-clearance.py \
  --manifest .axiom-runtime/marketing-preprod/image-scans/candidate.private.json \
  --auth-review .axiom-runtime/marketing-preprod/auth-review.private.json \
  --output .axiom-runtime/marketing-preprod/image-scans/clearance.private.json
for component in marketing bff gateway auth rest migrations lifecycle; do
  docker push "$REGISTRY/axiom-proof-preprod-${component}:$TAG"
done
python3 - <<'PY'
import json, os, re, subprocess
from pathlib import Path
images = {}
for component in ['marketing', 'bff', 'gateway', 'auth', 'rest', 'migrations', 'lifecycle']:
    tag = f"{os.environ['REGISTRY']}/axiom-proof-preprod-{component}:release-{os.environ['SOURCE_SHA']}"
    raw = subprocess.check_output(['docker', 'inspect', '--format', '{{json .RepoDigests}}', tag], text=True)
    prefix = tag.rsplit(':', 1)[0] + '@sha256:'
    matches = [s for s in json.loads(raw) if s.startswith(prefix)]
    if len(matches) != 1 or not re.fullmatch(re.escape(prefix) + '[a-f0-9]{64}', matches[0]):
        raise RuntimeError('Missing or ambiguous pushed digest for ' + component)
    images[component] = matches[0]
path = Path('.axiom-runtime/marketing-preprod/release.private.json')
auxiliary = {component: images.pop(component) for component in ['migrations', 'lifecycle']}
auth_context = Path(os.environ['AUTH_CONTEXT'])
manifest = {'release_sha': os.environ['SOURCE_SHA'], 'images': images, 'auxiliary_images': auxiliary, 'lifecycle_target_manifest_sha256': Path('.axiom-runtime/marketing-preprod/target-manifest-sha256').read_text().strip(), 'auth_source_snapshot_sha256': (auth_context / 'snapshot-sha256').read_text().strip(), 'auth_source': json.loads((auth_context / 'context/review/source.json').read_bytes())}
path.write_text(json.dumps(manifest, indent=2) + '\n')
path.chmod(0o600)
print('Recorded all seven immutable image digests and lifecycle target binding.')
PY
