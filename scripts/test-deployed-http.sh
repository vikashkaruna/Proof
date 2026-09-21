#!/usr/bin/env bash
# Two independently running production-mode BFF containers, exercised over HTTP.
# This proves the external runner, not a cloud/on-prem deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mode=${1:-api-only}
if [ "$mode" != api-only ] && [ "$mode" != --browser ]; then echo 'Usage: test-deployed-http.sh [--browser]' >&2; exit 2; fi
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo 'Commit the reviewed changes first: container acceptance must name the source it builds.' >&2
  exit 2
fi
./scripts/start-parity-supabase.sh
revision=$(git rev-parse HEAD)
image="axiom-acceptance-bff:${revision:0:12}"
docker build --build-arg "AXIOM_RELEASE_SHA=$revision" -f infra/docker/Dockerfile.bff -t "$image" .
state_dir="$PWD/.axiom-runtime/deployed-http"
mkdir -p "$state_dir"
if [ "$mode" = --browser ]; then
  docker build --build-arg "AXIOM_RELEASE_SHA=$revision" -f infra/docker/Dockerfile.web -t axiom-acceptance-web:local .
  docker build --build-arg "AXIOM_RELEASE_SHA=$revision" -f infra/docker/Dockerfile.marketing -t axiom-acceptance-marketing:local .
fi
containers=()
network_id=$(docker network create "axiom-http-$$")
cleanup() {
  for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
  docker network rm "$network_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for environment in preprod production; do
  if [ "$environment" = preprod ]; then port=57400; web_port=57410; marketing_port=57420; else port=57401; web_port=57411; marketing_port=57421; fi
  container="axiom-http-${environment}-$$"
  python3 - "$state_dir" "$environment" "$port" "$revision" "$web_port" "$marketing_port" <<'PY'
from pathlib import Path
import json,sys,secrets,os
root=Path(sys.argv[1]);environment=sys.argv[2];port=sys.argv[3];revision=sys.argv[4]
status=json.loads((Path(os.environ.get('AXIOM_PARITY_STATE_DIR','.axiom-runtime/parity'))/'status.json').read_text())
env={'NODE_ENV':'production','ENVIRONMENT':environment,'AXIOM_AUTH_MODE':'strict','AXIOM_RELEASE_SHA':revision,'SUPABASE_URL':'http://host.docker.internal:56321','SUPABASE_ANON_KEY':status['PUBLISHABLE_KEY'],'SUPABASE_SERVICE_KEY':status['SECRET_KEY'],'APPROVAL_SIGNING_KEY':secrets.token_hex(32),'AXIOM_MFA_ENCRYPTION_KEY':secrets.token_hex(32),'AGENT_RUNTIME_INTERNAL_TOKEN':secrets.token_hex(32),'AGENT_RUNTIME_URL':'http://unused-runtime.invalid','MODEL_GATEWAY_API_KEY':secrets.token_hex(32),'AXIOM_REGION':'ap-south-1','LOG_LEVEL':'error'}
(root/f'{environment}.env').write_text(''.join(f'{k}={v}\n' for k,v in env.items()))
target={'schemaVersion':1,'deploymentId':f'http-{environment}','environment':environment,'topology':'local-docker','syntheticFixtures':True,'expectedRevision':revision,'bffUrl':f'http://127.0.0.1:{port}','webUrl':f'http://127.0.0.1:{sys.argv[5]}','marketingUrl':f'http://127.0.0.1:{sys.argv[6]}','supabaseUrl':status['API_URL'],'anonKey':status['ANON_KEY'],'publishableKey':status['PUBLISHABLE_KEY'],'serviceKey':status['SERVICE_ROLE_KEY']}
(root/f'{environment}.json').write_text(json.dumps(target))
web={k:env[k] for k in ['NODE_ENV','ENVIRONMENT','AXIOM_AUTH_MODE','SUPABASE_URL','SUPABASE_ANON_KEY','AXIOM_REGION']}
# Linux containers cannot reach host ports published only on loopback.
# Use private Docker DNS for SSR -> BFF; keep browser ports loopback-only.
web['BFF_PUBLIC_URL']=f'http://bff-{environment}:4000'
(root/f'{environment}-web.env').write_text(''.join(f'{k}={v}\n' for k,v in web.items()))
PY
  containers+=("$container")
  docker run -d --name "$container" --network "$network_id" --network-alias "bff-$environment" --add-host=host.docker.internal:host-gateway --env-file "$state_dir/$environment.env" -p "127.0.0.1:$port:4000" "$image" >/dev/null
  ready=false
  for attempt in $(seq 1 60); do
    if curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null; then ready=true; break; fi
    sleep 1
  done
  [ "$ready" = true ] || { echo "$environment BFF did not start; inspect its protected local logs." >&2; docker logs "$container" > "$state_dir/$environment.private.log" 2>&1; exit 1; }
  if [ "$mode" = --browser ]; then
    for app in web marketing; do
      app_container="axiom-http-${environment}-${app}-$$"
      containers+=("$app_container")
      if [ "$app" = web ]; then app_port=$web_port; internal_port=3001; else app_port=$marketing_port; internal_port=3000; fi
      docker run -d --name "$app_container" --network "$network_id" --add-host=host.docker.internal:host-gateway --env-file "$state_dir/$environment-web.env" -p "127.0.0.1:$app_port:$internal_port" "axiom-acceptance-${app}:local" >/dev/null
      # Check the internal hop explicitly. Host-side API success cannot prove
      # a container can reach the BFF (loopback publishing differs on Linux).
      docker exec "$app_container" node --input-type=module -e '
        const r = await fetch(process.env.BFF_PUBLIC_URL + "/health", {signal: AbortSignal.timeout(5000)});
        if (r.status !== 200 || (await r.json()).environment !== process.env.ENVIRONMENT) process.exit(1);
      '
      ready=false
      for attempt in $(seq 1 60); do
        if curl --silent --fail "http://127.0.0.1:$app_port/" >/dev/null; then ready=true; break; fi
        sleep 1
      done
      [ "$ready" = true ] || { echo "$app did not start; inspect protected logs." >&2; docker logs "$app_container" > "$state_dir/$environment-$app.private.log" 2>&1; exit 1; }
    done
    ./scripts/run-deployed-acceptance.sh "$state_dir/$environment.json"
  else
    ./scripts/run-deployed-acceptance.sh "$state_dir/$environment.json" api-only
  fi
  echo "$environment: HTTP acceptance passed against the running container."
done
pnpm exec tsx scripts/compare-deployed-parity.ts .axiom-runtime/acceptance/http-preprod/api-results.json .axiom-runtime/acceptance/http-production/api-results.json

if [ "$mode" = --browser ]; then
  pnpm exec tsx scripts/compare-deployed-parity.ts .axiom-runtime/acceptance/http-preprod/browser-results.json .axiom-runtime/acceptance/http-production/browser-results.json
fi
