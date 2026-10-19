"""Reuse real measured human-plan SQL fixture; retain its explicit MFA stand-in label."""

from pathlib import Path

root = Path(__file__).resolve().parents[3]
source = (root / "tests/database/owned-human-plans.test.sql").read_text()
if not source.endswith("rollback;\n") or source.count("\nrollback;") != 1:
    raise ValueError("Reviewed owned human fixture boundary changed")
print(source.removesuffix("rollback;\n"))
