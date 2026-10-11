#!/usr/bin/env bash
# Shared environment-file resolution for scripts/axiom-ops.sh.
#
# One rule everywhere: the file for environment <env> is `.env.<env>` at the
# repository root, which in the main checkout is a symlink to
# `infra/docker/environments/.env.<env>` (the other accepted location, and where
# the committed templates really live). `--env-file` or AXIOM_ENV_FILE wins.
#
# The file is parsed, never sourced: no command substitution, no expansion, so
# a stray `$(...)` in a value cannot execute. Names only are ever printed.

ops_find_env_file() {
  local env="$1" root="$2" candidate
  if [ -n "${AXIOM_ENV_FILE:-}" ]; then
    [ -f "$AXIOM_ENV_FILE" ] && { printf '%s\n' "$AXIOM_ENV_FILE"; return 0; }
    return 1
  fi
  local a="${root}/.env.${env}" b="${root}/infra/docker/environments/.env.${env}"
  if [ -f "$a" ] && [ -f "$b" ] && [ ! "$a" -ef "$b" ] && ! cmp -s "$a" "$b"; then
    printf 'error: root and canonical environment files differ; select one explicitly.\n' >&2
    return 1
  fi
  for candidate in "$a" "$b"; do
    if [ -f "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

# Validate the entire selected file before changing the caller environment.
# Configuration declared by any committed environment template is authoritative:
# absent keys are unset, present keys replace inherited values. Tool transport
# (PATH, HOME, credential selectors, etc.) remains outside file configuration.
ops_load_env_file() {
  local OPS_ENV_file="$1" OPS_ENV_root="${2:-}" OPS_ENV_protocol
  local OPS_ENV_operation OPS_ENV_key OPS_ENV_val OPS_ENV_declaration
  if [ -z "$OPS_ENV_root" ]; then
    OPS_ENV_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || return 1
  fi
  OPS_ENV_protocol="$(mktemp "${TMPDIR:-/tmp}/axiom-env-protocol.XXXXXX")" || return 1
  chmod 600 "$OPS_ENV_protocol" || { rm -f "$OPS_ENV_protocol"; return 1; }
  if ! python3 "${OPS_ENV_root}/scripts/lib/ops-env-parse.py" --root "$OPS_ENV_root" --file "$OPS_ENV_file" > "$OPS_ENV_protocol"; then
    rm -f "$OPS_ENV_protocol"
    return 1
  fi
  # Preflight readonly caller variables before changing any configuration.
  while IFS= read -r -d '' OPS_ENV_operation && IFS= read -r -d '' OPS_ENV_key && IFS= read -r -d '' OPS_ENV_val; do
    OPS_ENV_declaration="$(declare -p "$OPS_ENV_key" 2>/dev/null)" || OPS_ENV_declaration=''
    if [[ "$OPS_ENV_declaration" =~ ^declare\ -[^\ ]*r ]]; then
      rm -f "$OPS_ENV_protocol"
      printf 'error: Environment key %s is readonly in the caller.\n' "$OPS_ENV_key" >&2
      return 1
    fi
    # Integer/array/nameref/case-conversion attributes would reinterpret bytes.
    if [[ "$OPS_ENV_declaration" =~ ^declare\ -[^\ ]*[aiAnlu] ]]; then
      rm -f "$OPS_ENV_protocol"
      printf 'error: Environment key %s has unsupported caller attributes.\n' "$OPS_ENV_key" >&2
      return 1
    fi
  done < "$OPS_ENV_protocol"
  # Bash 3.2 compatible: the helper writes triples separated by NUL, never code.
  while IFS= read -r -d '' OPS_ENV_operation && IFS= read -r -d '' OPS_ENV_key && IFS= read -r -d '' OPS_ENV_val; do
    case "$OPS_ENV_operation" in
      clear) unset "$OPS_ENV_key" ;;
      set) export "$OPS_ENV_key=$OPS_ENV_val" ;;
      *) rm -f "$OPS_ENV_protocol"; printf 'error: Invalid environment protocol.\n' >&2; return 1 ;;
    esac
  done < "$OPS_ENV_protocol"
  rm -f "$OPS_ENV_protocol"
}

# A value that is still a template placeholder (`<...>`) is not a value.
ops_require_value() {
  local name="$1" value="${!1:-}"
  if [ -z "$value" ] || [[ "$value" == *"<"*">"* ]]; then
    printf 'error: %s is missing or still a placeholder in the environment file.\n' "$name" >&2
    return 1
  fi
}
