"""Owned disposable SQL source/MFA foundation, not browser or real host proof."""

from pathlib import Path

root = Path(__file__).resolve().parents[3]
source = (root / "tests/database/owned-deployment.test.sql").read_text()
if not source.endswith("rollback;\n") or source.count("\nrollback;") != 1:
    raise ValueError("Reviewed owned enrollment fixture boundary changed")
print(source.removesuffix("rollback;\n"))
