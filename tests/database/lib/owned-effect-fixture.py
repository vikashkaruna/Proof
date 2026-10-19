"""Retain the real accepted168 fixture and its explicit SQL-only authority label."""

from pathlib import Path

root = Path(__file__).resolve().parents[3]
source = (root / "tests/database/owned-execution-binding.test.sql").read_text()
if not source.endswith("rollback;\n") or source.count("\nrollback;") != 1:
    raise ValueError("Reviewed owned execution fixture boundary changed")
for name in ("before_owned168_forward", "after_owned168_forward"):
    if source.count(f"savepoint {name};") != 1:
        raise ValueError("Reviewed owned execution observation boundary changed")
print(source.removesuffix("rollback;\n"))
