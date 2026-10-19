"""Fixed pure renderer supervisor; no workload socket or writer mounts."""

import sys

from .assessment_supervisor import supervise

if __name__ == "__main__":
    if sys.argv[1:] != ["--private-stdio"]:
        raise SystemExit(2)
    code, report = supervise(
        (sys.executable, "-m", "axiom.prativedan_pure_worker"), worker_uid=20006
    )
    import json

    sys.stdout.write(json.dumps({"kind": "supervisor", **report}, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    raise SystemExit(code)
