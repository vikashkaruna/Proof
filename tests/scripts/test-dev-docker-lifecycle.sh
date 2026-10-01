#!/usr/bin/env bash
# Local container lifecycle: down only stops, removal is opt-in, databases are
# protected unless explicitly named. Uses stub docker/curl; touches no real container.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/scripts" "$work/bin" "$work/infra/docker/environments"
cp "$repo/scripts/dev-docker.sh" "$work/scripts/"
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/scripts/sync-env.sh"
: > "$work/docker-compose.yml"
: > "$work/infra/docker/environments/.env.local"
: > "$work/infra/docker/environments/.env.staging"
chmod +x "$work/scripts/"*.sh
cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  *"config --services"*) printf 'bff\nweb\ntemporal-db\nsupabase-db\nagent-runtime\n' ;;
esac
exit 0
STUB
printf '#!/usr/bin/env bash\nexit 22\n' > "$work/bin/curl"
chmod +x "$work/bin/"*
export STUB_LOG="$work/calls.log"
fail=0
run() { : > "$STUB_LOG"; PATH="$work/bin:$PATH" bash "$work/scripts/dev-docker.sh" "$@" >"$work/out.txt" 2>&1; }
ok() { if ! eval "$1"; then echo "FAIL: $2"; fail=1; else echo "  ok: $2"; fi; }
calls() { cat "$STUB_LOG"; }

run --down
ok '[ "$(calls | grep -c " stop")" -ge 1 ]' "local --down stops containers"
ok '! calls | grep -qE "compose.* (down|rm)( |$)"' "local --down removes nothing"

run --env staging --down
ok 'calls | grep -qE "compose.* down"' "non-local --down keeps the original removal behaviour"

run --pause
ok 'calls | grep -qE "compose.* pause"' "--pause freezes containers"
run --unpause
ok 'calls | grep -qE "compose.* unpause"' "--unpause thaws containers"

run --remove
ok 'calls | grep -E "compose.* rm " | grep -q -- "--stop --force"' "--remove stops then force-removes"
ok 'calls | grep -E "compose.* rm " | grep -qE " bff( |$)"' "--remove includes application services"
ok '! calls | grep -E "compose.* rm " | grep -qE "temporal-db|supabase-db"' "--remove protects database containers"
run --env staging --remove || true
ok '! calls | grep -qE "compose.* rm "' "--remove refuses a non-local environment"

if run --remove-all; then rc=0; else rc=$?; fi
ok '[ "$rc" -ne 0 ] && ! calls | grep -qE "compose.* (down|rm)( |$)"' "--remove-all without --yes does nothing"
run --remove-all --yes
ok 'calls | grep -qE "compose.* down" && ! calls | grep -q -- "--volumes"' "--remove-all --yes removes containers but keeps volumes"
if run --remove-all --yes --volumes; then rc=0; else rc=$?; fi
ok '[ "$rc" -ne 0 ] && ! calls | grep -qE "compose.* down"' "--volumes without --confirm-data-loss does nothing"
run --remove-all --yes --volumes --confirm-data-loss
ok 'calls | grep -qE "compose.* down --volumes"' "explicit data-loss confirmation deletes volumes"

[ "$fail" -eq 0 ] && echo "dev-docker lifecycle: all assertions passed"
exit "$fail"
