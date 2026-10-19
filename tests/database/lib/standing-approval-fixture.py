"""Reuse genuine custody and measured-plan setup in an owned disposable SQL DB.

This emits SQL only. Enrollment rows/session/factor counters are explicit admin
stand-ins, never live host enrollment, browser TOTP or signing-key proof.
"""
from pathlib import Path

root = Path(__file__).resolve().parents[3]
pg = (root / 'tests/database/postgresql-sandbox-discovery.test.sql').read_text()
marker = "select pg_temp.ok(pg_temp.resolve()->>'targetBinding'"
if pg.count(marker) != 1:
    raise ValueError('Reviewed PostgreSQL source boundary changed')
print(pg[:pg.index(marker)])
print('reset role;')
print((root / 'tests/database/lib/owned-deployment-fixture.sql').read_text())
human = (root / 'tests/database/owned-human-plans.test.sql').read_text()
marker = '-- Ordinary backend, browser and target roles cannot use the human source.'
if human.count(marker) != 1:
    raise ValueError('Reviewed measured-human source boundary changed')
print(human[:human.index(marker)])
print('reset role;')
