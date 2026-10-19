"""Fixed private controller-computation supervisor, UID20107, empty environment."""

import sys

from .assessment_supervisor import supervise

if __name__ == "__main__":
    if sys.argv[1:] != ["--private-stdio"]:
        raise SystemExit(2)
    code, report = supervise(
        (sys.executable, "-m", "axiom.prativedan_accounted_process"), worker_uid=20107
    )
    # A private channel consumer must require this exact cleanup footer.
    import json

    sys.stdout.write(json.dumps({"kind": "supervisor", **report}, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    raise SystemExit(code)
