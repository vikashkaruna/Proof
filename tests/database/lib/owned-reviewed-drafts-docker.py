#!/usr/bin/env python3
"""Revalidate a fully owned disposable fixture before each barrier SQL connection."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
real = os.environ["AXIOM_FIXTURE_REAL_DOCKER"]
proof = json.loads(Path(os.environ["AXIOM_REVIEWED_DRAFTS_PROOF"]).read_text())
args = sys.argv[1:]
if not re.fullmatch(r"[a-f0-9]{64}", proof["containerId"]):
    raise RuntimeError("Immutable fixture ID required")
current = json.loads(subprocess.check_output([real, "inspect", proof["containerId"]]))[
    0
]
labels = current["Config"]["Labels"]
fixture = labels["com.axiom.fixture"]
if fixture == "database-policy-test":
    target_ok = (
        re.fullmatch(r"axiom-db-test-[0-9]+", proof["name"])
        and proof["project"] == "axiom-db-tests"
        and proof["database"] == "axiom_policy_test"
        and current["NetworkSettings"]["Ports"]["5432/tcp"] is None
    )
else:
    target_ok = (
        fixture == "reviewed-drafts-test"
        and re.fullmatch(r"axiom_reviewed_drafts_test[a-zA-Z0-9_]*", proof["database"])
        and current["Config"]["Image"] == proof["image"]
        and current["NetworkSettings"]["Ports"]["5432/tcp"]
        == [{"HostIp": "127.0.0.1", "HostPort": str(proof["loopbackPort"])}]
    )
if not (
    target_ok
    and current["Id"] == proof["containerId"]
    and current["Name"] == "/" + proof["name"]
    and labels["com.axiom.owner-worktree"] == str(ROOT) == proof["ownerWorktree"]
    and labels["com.axiom.fixture.project"] == proof["project"]
):
    raise RuntimeError("Owned fixture target guard refused")
if (
    args[:1] != ["exec"]
    or proof["containerId"] not in args
    or "psql" not in args
    or "-d" not in args
    or args[args.index("-d") + 1] != proof["database"]
):
    raise RuntimeError("Owned fixture SQL command guard refused")
os.execv(real, [real, *args])
