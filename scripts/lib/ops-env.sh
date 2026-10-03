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
    printf 'warning: %s and %s both exist and differ; using the first.\n' "$a" "$b" >&2
  fi
  for candidate in "$a" "$b"; do
    if [ -f "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

# Exports KEY=VALUE pairs from the file. A variable already set in the calling
# process keeps its value, so `GCP_REGION=... axiom-ops.sh ...` can override a
# single run without editing the file.
ops_load_env_file() {
  local file="$1" line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    val="${line#*=}"
    [ "$key" = "$line" ] && continue
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" == \"*\" && ${#val} -ge 2 ]]; then val="${val:1:${#val}-2}"; fi
    if [[ "$val" == \'*\' && ${#val} -ge 2 ]]; then val="${val:1:${#val}-2}"; fi
    if [ -z "${!key+x}" ]; then export "$key=$val"; fi
  done < "$file"
}

# A value that is still a template placeholder (`<...>`) is not a value.
ops_require_value() {
  local name="$1" value="${!1:-}"
  if [ -z "$value" ] || [[ "$value" == *"<"*">"* ]]; then
    printf 'error: %s is missing or still a placeholder in the environment file.\n' "$name" >&2
    return 1
  fi
}
