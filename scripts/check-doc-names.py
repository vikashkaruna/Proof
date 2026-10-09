#!/usr/bin/env python3
"""Validate private documentation file names against docs/README.md.

Local-only (private zones are git-ignored). Reads names, never document prose.
Exit 1 lists every violation. Subtrees that carry third-party or generated names
(_source, archive, help, developer, evidence) are exempt.
"""
from __future__ import annotations

import re
from datetime import datetime
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ZONES = {
    "docs/private-docs/operator": r"(OPS-\d{2}-[a-z0-9-]+|INDEX|README)\.md",
    "docs/private-docs/testing": (
        r"(TEST-\d{2}-[a-z0-9-]+|TEST-SUITES-[a-z0-9-]+|INDEX|README)\.md|TEST-DATA-[a-z0-9-]+\.json"
    ),
    "docs/private-docs/architecture": r"(ARCH-\d{2}-[a-z0-9-]+\.(md|html)|INDEX\.md)",
    "docs/private-docs/requirements": r"(REQ-\d{2}-[a-z0-9-]+|INDEX)\.md",
    "docs/private-docs/security": r"(SEC-\d{2}-[a-z0-9-]+|INDEX)\.md",
    "docs/private-docs/audits": r"(AUD-\d{8}-\d{3}-[a-z0-9-]+|INDEX)\.md",
    "docs/private-docs/status": r"(STATUS-[a-z0-9-]+|INDEX)\.md",
    "docs/private-docs/reference": r"(REF-[a-z0-9.-]+\.(md|json|html|ps1|yaml)|INDEX\.md)",
    "docs/private-plans": r"(PLAN-\d{2}-[a-z0-9-]+|INDEX|README)\.md",
}
EXEMPT = ("_source", "archive", "help", "developer", "evidence")
SESSION_FILE = ROOT / "docs/private-docs/status/STATUS-session-log.md"
MARKER = "<!-- NEWEST SESSION ENTRIES GO BELOW THIS LINE -->"


def session_log_problems(text: str) -> list[str]:
    """Validate the standalone insertion marker and recorded UTC minute ordering.

    Historical entries with a date only keep their original text; minute ordering
    applies to timed entries on the same day. Instructions may quote the marker.
    """
    lines = text.splitlines()
    markers = [i for i, line in enumerate(lines) if line.strip() == MARKER]
    if len(markers) != 1:
        return ["STATUS-session-log.md: expected exactly one standalone newest-first marker"]
    problems: list[str] = []
    previous_day = None
    previous_minute = None
    pattern = re.compile(r"^### (\d{4}-\d{2}-\d{2})(?:[ \t]+(\d{2}:\d{2})(?:[ \t]+(UTC))?)?(?:[ \t]|$)")
    for line in lines[markers[0] + 1:]:
        match = pattern.match(line)
        if match is None:
            continue
        day, minute, zone = match.groups()
        try:
            datetime.strptime(day, "%Y-%m-%d")
            if minute:
                datetime.strptime(minute, "%H:%M")
        except ValueError:
            problems.append("STATUS-session-log.md: invalid recorded session date or time")
            continue
        if minute and zone != "UTC":
            problems.append("STATUS-session-log.md: timed session entries must explicitly use UTC")
        if previous_day is not None and day > previous_day:
            problems.append("STATUS-session-log.md: session entries are not in reverse chronological order")
        if day == previous_day and minute and previous_minute and minute > previous_minute:
            problems.append("STATUS-session-log.md: timed sessions on the same day are not newest first")
        if day != previous_day:
            previous_minute = None
        previous_day = day
        if minute:
            previous_minute = minute
    return problems


def main() -> int:
    problems: list[str] = []
    for zone, pattern in ZONES.items():
        base = ROOT / zone
        if not base.is_dir():
            continue
        rx = re.compile(pattern)
        for path in sorted(base.rglob("*")):
            rel = path.relative_to(ROOT)
            if path.is_dir() or any(part in EXEMPT for part in path.relative_to(base).parts[:-1]):
                continue
            if path.name.startswith(".") or rx.fullmatch(path.name) is None:
                problems.append(f"{rel}: name does not match the {zone} convention")
    if SESSION_FILE.is_file():
        problems.extend(session_log_problems(SESSION_FILE.read_text(encoding="utf-8")))
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print("Documentation names and session-log order passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
