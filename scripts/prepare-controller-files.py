#!/usr/bin/env python3
"""Prepare fresh protected files for review; never installs or activates them."""
import json
import os
import stat
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'infra/workload'))
import controller_files as delivery


def read(path: Path, maximum: int) -> bytes:
    if path.resolve(strict=True) != path: raise ValueError('source alias refused')
    for parent in path.parents:
        meta = parent.stat()
        if meta.st_uid not in (0, os.geteuid()) or meta.st_mode & 0o022: raise ValueError('source ancestry refused')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_nlink != 1 or stat.S_IMODE(meta.st_mode) != 0o600 or not 0 < meta.st_size <= maximum: raise ValueError('source protection refused')
        with os.fdopen(os.dup(fd), 'rb') as stream: data = stream.read(maximum+1)
        if len(data) != meta.st_size: raise ValueError('source changed')
        return data
    finally: os.close(fd)


def prepare(review_path: Path, source: Path, target: Path) -> str:
    value = json.loads(read(review_path, 4096), object_pairs_hook=delivery.host.unique)
    if not isinstance(value, dict) or set(value) != {'schemaVersion', 'tenantId', 'spireManifestSha256', 'controllerImage'}: raise ValueError('review refused')
    if {p.name for p in source.iterdir()} != set(delivery.FILES): raise ValueError('source inventory refused')
    payload = {name: read(source/name, maximum) for name, maximum in delivery.FILES.items()}
    review = delivery.manifest({**value, 'files': {name: delivery.digest(data) for name, data in payload.items()}})
    raw = delivery.enrollment.encode(review)
    # Output is always fresh and private, including when the caller's umask is permissive.
    os.umask(0o077)
    if target.absolute() != target or target.parent.resolve(strict=True) != target.parent: raise ValueError('output alias refused')
    for parent in (target.parent, *target.parent.parents):
        meta = parent.stat()
        if meta.st_uid not in (0, os.geteuid()) or meta.st_mode & 0o022: raise ValueError('output ancestry refused')
    target.mkdir(mode=0o700)
    for name, data in {'manifest.json': raw, **payload}.items():
        fd = os.open(target/name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream: stream.write(data);stream.flush();os.fsync(stream.fileno())
    return delivery.digest(raw)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4: raise ValueError('arguments required')
        result = prepare(*(Path(arg).absolute() for arg in sys.argv[1:]))
        print('Controller review bundle prepared: '+result+'; no host or service changed.')
    except Exception:
        print('Controller review bundle preparation refused; preserve partial output for review.', file=sys.stderr)
        sys.exit(1)
