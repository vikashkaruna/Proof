#!/usr/bin/env bash
# Confidentiality guard for staged or ranged changes. Used by:
#   - .husky/pre-commit              (every commit, --staged)
#   - CI / manual review             (--range <base>..<head>)
#   - Claude Code hook               (.claude/hooks/block_private_leak.py mirrors the checks)
#
# Blocks:
#   1. any path in the private documentation zones (docs/private-docs, docs/private-plans,
#      legacy private-docs/, or any other docs/ file outside the tracked allow-list)
#   2. secret-bearing file names (.env, *.pem, *.key, *.tfstate, *.tfvars, ...)
#   3. secret-looking content in added documentation or markdown lines
#   4. docs/shared-docs/*.md without the front-matter marker `classification: shared`
#   5. high-confidence credentials in any added line outside tests and lockfiles
# No bypass is offered. Fix the content or move it to docs/private-docs/.
set -euo pipefail

mode="${1:---staged}"
if [ "$mode" = "--range" ]; then
  range="${2:?usage: guard-private-docs.sh --range <base>..<head>}"
  files() { git diff --name-only --diff-filter=ACMR "$range"; }
  added() { git diff -U0 --diff-filter=ACMR "$range" -- "$@"; }
  blob() { git show "${range##*..}:$1"; }
else
  files() { git diff --cached --name-only --diff-filter=ACMR; }
  added() { git diff --cached -U0 --diff-filter=ACMR -- "$@"; }
  blob() { git show ":$1"; }
fi

fail=0
say() { echo "BLOCKED: $*" >&2; fail=1; }

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    docs/README.md | docs/private-docs/README.md | docs/private-plans/README.md) ;;
    docs/shared-docs/*) ;;
    docs/* | private-docs/*)
      say "$f is private. docs/ outside README files and shared-docs/ is git-ignored; never use 'git add -f'." ;;
  esac
  case "$f" in
    .env.example | *.example | *.sample) ;;
    .env | .env.* | *.pem | *.key | *.p12 | *.pfx | *.tfstate | *.tfstate.* | *.tfvars | kubeconfig* | *.kubeconfig | secrets/* | */secrets/* | *.secrets.yaml | *.private.md | *-CONFIDENTIAL.*)
      say "$f looks like secret or confidential material." ;;
  esac
  case "$f" in
    docs/shared-docs/*.md)
      blob "$f" | head -20 | grep -qiE '^classification:[[:space:]]*shared[[:space:]]*$' \
        || say "$f is missing the front-matter line 'classification: shared' (see docs/README.md)." ;;
  esac
done < <(files)

# Secret-looking assignments and tokens in added documentation lines.
pat='(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}|(password|passwd|secret|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+_-]{16,})'
hits="$(added 'docs/*' '*.md' | grep -E '^\+[^+]' | grep -iE "$pat" || true)"
if [ -n "$hits" ]; then
  say "possible secret in added documentation lines (values redacted):"
  echo "$hits" | sed -E 's/([:=][[:space:]]*["'"'"']?[A-Za-z0-9]{4})[A-Za-z0-9\/+_-]+/\1<redacted>/' | cut -c1-110 | sed 's/^/    /' >&2
fi

# High-confidence credentials in any added line outside tests and lockfiles.
hi='(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abprs]-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9]{36,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})'
code_hits="$(added ':(exclude)tests/*' ':(exclude)*.lock' ':(exclude)pnpm-lock.yaml' ':(exclude)*/tests/*' ':(exclude)*.test.*' ':(exclude)*.spec.*' | grep -E '^\+[^+]' | grep -E "$hi" || true)"
if [ -n "$code_hits" ]; then
  say "possible credential in added lines (not in tests or lockfiles):"
  echo "$code_hits" | sed -E 's/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/\1<redacted>/g' | cut -c1-110 | sed 's/^/    /' >&2
fi

[ "$fail" -eq 0 ] || { echo "Move confidential material to docs/private-docs/ (git-ignored). See docs/README.md." >&2; exit 1; }
