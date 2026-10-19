"""Fixed Karya-only root supervisor; its child runs solely as UID20005."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys

from .assessment_supervisor import supervise


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--private-stdio", action="store_true")
    try:
        args = parser.parse_args()
        if not args.private_stdio or not all(stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in (0, 1)):
            return 78
        code, report = supervise(
            command=(sys.executable, "-m", "axiom.owned_execution_worker"),
            seconds=40,
            worker_uid=20005,
        )
        sys.stdout.write("\n" + json.dumps({"supervisor": report}, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        return code
    except Exception:
        return 70


if __name__ == "__main__":
    raise SystemExit(main())
