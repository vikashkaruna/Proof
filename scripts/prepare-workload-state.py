#!/usr/bin/env python3
"""Prepare an owner-only state binding for review; never touch the target host."""
import json
import os
import sys
from pathlib import Path

from lib.spire_deployment import deployment_bundle
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'infra/workload'))
from spire_state import policy, unique


def main():
    if len(sys.argv) != 5:
        raise ValueError('arguments refused')
    source, role, filesystem_uuid, target = sys.argv[1:]
    with open(source, 'rb') as stream:
        raw = stream.read(16385)
    if len(raw) > 16384:
        raise ValueError('policy too large')
    spire = json.loads(raw, object_pairs_hook=unique)
    bundle = deployment_bundle(spire)
    value = policy({'schemaVersion': 1, 'role': role, 'filesystemUuid': filesystem_uuid, 'trustDomain': spire['trustDomain'], 'nodeId': json.loads(bundle['release.json'])['expectedNodeId'] if role == 'runner' else None})
    os.umask(0o077)
    with open(target, 'x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    print('SPIRE state binding prepared; no disk or host changed.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('SPIRE state binding preparation refused.', file=sys.stderr)
        sys.exit(1)
