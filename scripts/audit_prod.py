#!/usr/bin/env python3
"""Production dependency audit with a small, expiring allowlist.

Runs `pnpm audit --prod --audit-level=high --json` and fails on any high or critical
advisory that is not listed in security/audit-allowlist.json. An allowlisted advisory
passes only until its `expires` date, so an exception cannot outlive its review.
pnpm 9.12 has no audit ignore option, which is why this wrapper exists.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST = ROOT / "security" / "audit-allowlist.json"
BLOCKING = {"high", "critical"}


def load_allowlist(path: Path = ALLOWLIST) -> dict[str, dict]:
    data = json.loads(path.read_text())
    entries = {}
    for entry in data.get("allowed", []):
        for field in ("ghsa", "reason", "expires"):
            if not entry.get(field):
                raise ValueError(f"allowlist entry missing '{field}': {entry}")
        entries[entry["ghsa"]] = entry
    return entries


def evaluate(report: dict, allowed: dict[str, dict], today: date) -> tuple[list[str], list[str]]:
    """Return (failures, notes) for one parsed `pnpm audit --json` report."""
    failures: list[str] = []
    notes: list[str] = []
    for advisory in (report.get("advisories") or {}).values():
        severity = advisory.get("severity")
        if severity not in BLOCKING:
            continue
        ghsa = advisory.get("github_advisory_id") or str(advisory.get("id"))
        label = f"{advisory.get('module_name')} {advisory.get('vulnerable_versions')} ({ghsa}, {severity})"
        entry = allowed.get(ghsa)
        if entry is None:
            failures.append(f"{label}: not allowlisted")
        elif date.fromisoformat(entry["expires"]) < today:
            failures.append(f"{label}: allowlist entry expired on {entry['expires']}; re-review or fix")
        else:
            notes.append(f"{label}: allowed until {entry['expires']}")
    return failures, notes


def main() -> int:
    result = subprocess.run(
        ["pnpm", "audit", "--prod", "--audit-level=high", "--json"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError:
        print("audit-prod: could not parse `pnpm audit --json` output", file=sys.stderr)
        print(result.stdout[-500:] or result.stderr[-500:], file=sys.stderr)
        return 2
    failures, notes = evaluate(report, load_allowlist(), date.today())
    for note in notes:
        print(f"audit-prod: allowlisted - {note}")
    for failure in failures:
        print(f"audit-prod: FAIL - {failure}", file=sys.stderr)
    if failures:
        return 1
    print("audit-prod: no blocking advisories outside the allowlist")
    return 0


if __name__ == "__main__":
    sys.exit(main())
