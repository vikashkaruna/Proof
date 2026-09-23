#!/usr/bin/env python3
"""Prepare reviewed pinned host files; no network, host installation or activation."""
import hashlib
import json
import os
import sys
from pathlib import Path
from lib.spire_host_bundle import MAX_ARCHIVE, prepare
from spire_host import unique


def bounded(path: str, limit: int) -> bytes:
    with open(path,'rb') as stream:
        data=stream.read(limit+1)
    if len(data)>limit:
        raise ValueError('input too large')
    return data


def main():
    if len(sys.argv) not in (4,5):
        raise ValueError('arguments refused')
    value=json.loads(bounded(sys.argv[1],16384),object_pairs_hook=unique)
    raw,payload=prepare(value,bounded(sys.argv[2],MAX_ARCHIVE),bounded(sys.argv[4],65536) if len(sys.argv)==5 else None)
    os.umask(0o077)
    target=Path(sys.argv[3]);target.mkdir(mode=0o700)
    for name,data in {**payload,'manifest.json':raw}.items():
        with (target/name).open('xb') as stream:
            stream.write(data)
    print('SPIRE host bundle prepared; review manifest SHA256 '+hashlib.sha256(raw).hexdigest()+'. No services activated.')


if __name__=='__main__':
    try: main()
    except Exception:
        print('SPIRE host bundle preparation refused.',file=sys.stderr)
        sys.exit(1)
