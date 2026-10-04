#!/usr/bin/env bash
# Bash 3 compatible. Callers retain their fixtures, roles and outcome assertions.
race_helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
race_run() {
  local first_sql="$1" second_sql="$2" first_log="$3" second_log="$4"
  local mode="${5:-blocked}" expectation="${6:-success}" expected_value="${7:-}"
  local status_file="$result_dir/race-second-status"
  python3 "$race_helper_dir/concurrency-barrier.py" "$container" "${race_database_user:-postgres}" \
    "$first_sql" "$second_sql" "$first_log" "$second_log" "$status_file" \
    "$mode" "$expectation" "$expected_value" || return "$?"
  race_second_status="$(cat "$status_file")"
}
