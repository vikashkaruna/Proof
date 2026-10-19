"""Prepare public-only contexts for the controlled172 engineering fixture.

No build/pull/runtime action. Caller must separately verify exact cached base
8edef78e3e26cec72602edf19d665f48965296c01aa5365f7d4ff6758f45fb0a
and owned aliases in normal.Dockerfile, then build with --network=none --pull=false.
Human adapter/SVID issuer are synthetic; deployment acceptance is separate.
"""
from pathlib import Path
import argparse
import shutil
ROOT = Path(__file__).resolve().parents[4]
p = argparse.ArgumentParser()
p.add_argument('directory', type=Path)
a = p.parse_args()
if not a.directory.is_absolute() or a.directory.exists():
    raise SystemExit('New absolute owned directory required')
for kind in ('normal', 'adversary'):
    d = a.directory / kind
    d.mkdir(parents=True, mode=0o700)
    shutil.copyfile(Path(__file__).with_name(kind + '.Dockerfile'), d / 'Dockerfile')
for name in ('assessment_supervisor.py', 'prativedan_accounted_process.py',
             'prativedan_accounted_supervisor.py', 'prativedan_pure_worker.py',
             'prativedan_pure_supervisor.py'):
    shutil.copyfile(ROOT / 'services/agent-runtime/src/axiom' / name, a.directory / 'normal' / name)
shutil.copyfile(Path(__file__).with_name('unexpected_complete_worker.py'),
                a.directory / 'adversary/prativedan_pure_worker.py')
