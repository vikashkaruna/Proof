"""Pure emitter for175 native tests; owned SQL synthetic foundations only.

Reuses real171 custody/grant/MFA/read/cleanup flows. SQL factor counters are
explicit stand-ins, never real browser MFA or provider/SPIRE acceptance.
"""

from pathlib import Path

root = Path(__file__).resolve().parents[3]
base = (root / "tests/database/scheduled-postgresql-reads.test.sql").read_text()
marker = "-- Real wall clock, short-lived second scope:"
if base.count(marker) != 1:
    raise ValueError("Reviewed171 positive cleanup boundary changed")
print(base[: base.index(marker)])
