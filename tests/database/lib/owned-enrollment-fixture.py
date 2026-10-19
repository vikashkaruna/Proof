"""Owned disposable SQL source/MFA foundation, not browser or real host proof."""

import argparse
from pathlib import Path

root = Path(__file__).resolve().parents[3]
source = (root / "tests/database/owned-deployment.test.sql").read_text()
if not source.endswith("rollback;\n") or source.count("\nrollback;") != 1:
    raise ValueError("Reviewed owned enrollment fixture boundary changed")
print(source.removesuffix("rollback;\n"))

parser = argparse.ArgumentParser()
parser.add_argument("--active", action="store_true")
args = parser.parse_args()
if args.active:
    active = (root / "tests/database/owned-deployment-enrollment.test.sql").read_text()
    marker = "set local role service_role;\nselect public.rollback_owned_deployment_authority"
    if active.count(marker) != 1:
        raise ValueError("Reviewed active enrollment boundary changed")
    # A short real DB-clock lifetime exercises the same expiry fence without a
    # 15-minute sleeping fixture. No retained token or approval is rewritten.
    print(
        active[: active.index(marker)].replace(
            "interval '2 minutes'", "interval '20 seconds'"
        )
    )
