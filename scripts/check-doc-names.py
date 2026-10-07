#!/usr/bin/env python3
"""Validate private documentation file names against docs/README.md.

Local-only (private zones are git-ignored). Reads names, never document prose.
Exit 1 lists every violation. Subtrees that carry third-party or generated names
(_source, archive, help, developer, evidence) are exempt.
"""
from __future__ import annotations

import re
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
        head = SESSION_FILE.read_text(encoding="utf-8")
        if MARKER not in head:
            problems.append(f"{SESSION_FILE.relative_to(ROOT)}: missing newest-first marker {MARKER}")
        else:
            dates = re.findall(r"^### (\d{4}-\d{2}-\d{2})", head.split(MARKER, 1)[1], re.M)
            if dates != sorted(dates, reverse=True):
                problems.append("STATUS-session-log.md: session entries are not in reverse chronological order")
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print("Documentation names and session-log order passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
