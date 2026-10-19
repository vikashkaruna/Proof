"""Reuse the genuine custody/enrollment SQL foundation for owned165 tests only."""

from pathlib import Path

root = Path(__file__).resolve().parents[3]
base = (root / "tests/database/postgresql-sandbox-discovery.test.sql").read_text()
marker = "select pg_temp.ok(pg_temp.resolve()->>'targetBinding'"
if base.count(marker) != 1:
    raise ValueError("Reviewed PostgreSQL fixture boundary changed")
print(base[: base.index(marker)])
print("reset role;")

# Guarded disposable stand-ins are inert before migration169 exists.
print((root / "tests/database/lib/owned-deployment-fixture.sql").read_text())
