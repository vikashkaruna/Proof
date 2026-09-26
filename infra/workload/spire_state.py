#!/usr/bin/env python3
"""Read-only Linux SPIRE state admission. Never mounts, formats or repairs disks."""
from __future__ import annotations

import base64
import json
import itertools
import os
import re
import stat
import subprocess  # nosec B404 - fixed blkid probe; constant argv, no shell
import sys
from pathlib import Path

STATE = Path('/var/lib/spire')
CONFIG = Path('/etc/axiom/spire/state.json')
OWNER = 0
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate field')
        result[key] = value
    return result


def policy(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {'schemaVersion', 'role', 'filesystemUuid', 'trustDomain', 'nodeId'}:
        raise ValueError('policy refused')
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or value['role'] not in ('issuer', 'runner'):
        raise ValueError('policy refused')
    domain = value['trustDomain']
    if not isinstance(domain, str) or len(domain) > 253 or not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*', domain) or any(len(p) > 63 or p.startswith('-') or p.endswith('-') for p in domain.split('.')):
        raise ValueError('domain refused')
    if not isinstance(value['filesystemUuid'], str) or not re.fullmatch(UUID, value['filesystemUuid']) or value['filesystemUuid'] == '00000000-0000-0000-0000-000000000000':
        raise ValueError('filesystem refused')
    if value['role'] == 'issuer':
        if value['nodeId'] is not None:
            raise ValueError('issuer binding refused')
    elif not isinstance(value['nodeId'], str) or not re.fullmatch(re.escape(f'spiffe://{domain}/spire/agent/gcp_iit/') + r'[a-z][a-z0-9-]{4,28}[a-z0-9]/[1-9][0-9]{0,19}', value['nodeId']) or int(value['nodeId'].rsplit('/', 1)[1]) > 2**64 - 1:
        raise ValueError('node binding refused')
    return value


def directory(path: Path, private: bool = False) -> None:
    if path.resolve(strict=True) != path:
        raise ValueError('directory alias refused')
    meta = path.lstat()
    if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != OWNER or meta.st_mode & (0o077 if private else 0o022):
        raise ValueError('directory protection refused')


def ancestors(path: Path) -> None:
    for parent in (path, *path.parents):
        directory(parent)


def private_file(path: Path, maximum: int, prefix: int | None = None) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != OWNER or meta.st_mode & 0o077 or meta.st_nlink != 1 or not 0 < meta.st_size <= maximum:
            raise ValueError('state file refused')
        limit = min(meta.st_size, prefix) if prefix is not None else meta.st_size
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(limit + (0 if prefix is not None else 1))
        if len(data) != limit:
            raise ValueError('state file changed')
        return data
    finally:
        os.close(fd)


def parse_mounts(text: str) -> list[dict]:
    if len(text) > 4 * 1024 * 1024:
        raise ValueError('mount table refused')
    result = []
    for line in text.splitlines():
        fields = line.split(' ')
        separator = fields.index('-')
        if separator < 6 or len(fields) != separator + 4 or not re.fullmatch(r'[0-9]+:[0-9]+', fields[2]):
            raise ValueError('mount record refused')
        decode = lambda s: re.sub(r'\\(040|011|012|134)', lambda m: chr(int(m[1], 8)), s)
        result.append({'id': fields[0], 'device': fields[2], 'root': decode(fields[3]), 'path': decode(fields[4]), 'options': set(fields[5].split(',')), 'fs': fields[separator + 1], 'super': set(fields[separator + 3].split(','))})
    return result


def mount_binding(text: str, device: int) -> tuple[str, str]:
    mounts = parse_mounts(text)
    roots = [m for m in mounts if m['path'] == '/']
    targets = [m for m in mounts if m['path'] == str(STATE)]
    expected = f'{os.major(device)}:{os.minor(device)}'
    if len(roots) != 1 or len(targets) != 1:
        raise ValueError('dedicated mount required')
    mount = targets[0]
    if mount['device'] != expected or roots[0]['device'] == expected or mount['root'] != '/' or mount['fs'] != 'ext4' or not {'rw', 'nosuid', 'nodev', 'noexec'} <= mount['options'] or 'ro' in mount['options'] or 'rw' not in mount['super'] or 'ro' in mount['super']:
        raise ValueError('mount binding refused')
    if any(m['path'].startswith(str(STATE) + '/') for m in mounts):
        raise ValueError('nested mount refused')
    return mount['id'], mount['device']


def mounted_device(value: dict) -> int:
    alias = Path('/dev/disk/by-id') / f"google-axiom-{value['role']}-state"
    ancestors(alias.parent)
    if alias.lstat().st_uid != OWNER:
        raise ValueError('device alias refused')
    target = alias.resolve(strict=True)
    ancestors(target.parent)
    meta = target.stat()
    if not stat.S_ISBLK(meta.st_mode) or meta.st_uid != OWNER or meta.st_mode & 0o002:
        raise ValueError('state device refused')
    # Probe the actual superblock rather than trusting a possibly stale UUID alias.
    observed = subprocess.run(['/usr/sbin/blkid', '-p', '-s', 'UUID', '-o', 'value', '--', str(target)], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, env={'PATH': '/usr/sbin:/usr/bin', 'LC_ALL': 'C'}).stdout  # nosec B603 - target is a resolved block-device path checked above, constant argv, no shell
    if observed != (value['filesystemUuid'] + '\n').encode('ascii'):
        raise ValueError('filesystem binding refused')
    return meta.st_rdev


def der(value: object) -> None:
    if not isinstance(value, str):
        raise ValueError('encoded state refused')
    decoded = base64.b64decode(value, validate=True)
    if not 32 <= len(decoded) <= 16384 or decoded[0] != 0x30:
        raise ValueError('encoded state refused')


def certificate(value: object) -> None:
    # SPIRE storageJSON holds base64-encoded PEM, whereas keys.json holds
    # base64-encoded PKCS8 DER. Do not conflate these pinned wire formats.
    if not isinstance(value, str):
        raise ValueError('certificate state refused')
    pem = base64.b64decode(value, validate=True)
    if len(pem) > 32768:
        raise ValueError('certificate state refused')
    match = re.fullmatch(rb'-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=\n]+)-----END CERTIFICATE-----\n', pem)
    if match is None:
        raise ValueError('certificate state refused')
    der(match[1].replace(b'\n', b'').decode('ascii'))


def ready(value: dict) -> None:
    marker = json.loads(private_file(STATE / '.axiom-state.json', 4096), object_pairs_hook=unique)
    if policy(marker) != value:
        raise ValueError('state marker refused')
    contents(value)


def contents(value: dict) -> None:
    data = STATE / ('server' if value['role'] == 'issuer' else 'agent')
    directory(data, private=True)
    keys = json.loads(private_file(data / 'keys.json', 1024 * 1024), object_pairs_hook=unique)
    if not isinstance(keys, dict) or set(keys) != {'keys'} or not isinstance(keys['keys'], dict) or not 1 <= len(keys['keys']) <= 32:
        raise ValueError('empty key state refused')
    for name, encoded in keys['keys'].items():
        if not name or len(name) > 512:
            raise ValueError('key identifier refused')
        der(encoded)
    if value['role'] == 'issuer':
        if private_file(data / 'db.sqlite3', 64 * 1024**3, prefix=16) != b'SQLite format 3\x00':
            raise ValueError('registry refused')
    else:
        cache = json.loads(private_file(data / 'agent-data.json', 1024 * 1024), object_pairs_hook=unique)
        for field in ('svid', 'bundle'):
            if not isinstance(cache, dict) or not isinstance(cache.get(field), list) or not 1 <= len(cache[field]) <= 16:
                raise ValueError('node recovery state refused')
            for encoded in cache[field]:
                certificate(encoded)


def empty() -> None:
    entries = list(itertools.islice(STATE.iterdir(), 2))
    if len(entries) > 1 or any(p.name != 'lost+found' for p in entries):
        raise ValueError('existing state refused')
    if entries:
        directory(entries[0], private=True)
        if next(entries[0].iterdir(), None) is not None:
            raise ValueError('recovered filesystem refused')


def check(mode: str, role: str) -> None:
    if mode not in ('--ready', '--empty', '--unsealed') or role not in ('issuer', 'runner'):
        raise ValueError('invocation refused')
    ancestors(CONFIG.parent)
    value = policy(json.loads(private_file(CONFIG, 4096), object_pairs_hook=unique))
    if value['role'] != role:
        raise ValueError('host role refused')
    device = mounted_device(value)
    ancestors(STATE)
    directory(STATE, private=True)
    if STATE.stat().st_dev != device:
        raise ValueError('device changed')
    def current_mount():
        with open('/proc/self/mountinfo', encoding='ascii') as stream:
            return mount_binding(stream.read(4 * 1024 * 1024 + 1), device)
    before = current_mount()
    if mode == '--ready':
        ready(value)
    elif mode == '--empty':
        empty()
    else:
        marker = STATE / '.axiom-state.json'
        if marker.exists() or marker.is_symlink():
            raise ValueError('existing marker refused')
        contents(value)
    if current_mount() != before or mounted_device(value) != device:
        raise ValueError('mount changed')


def main() -> None:
    if os.geteuid() != 0 or sys.platform != 'linux' or len(sys.argv) != 3:
        raise ValueError('invocation refused')
    check(sys.argv[1], sys.argv[2])
    print('SPIRE state check passed; no state changed.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('SPIRE state check refused.', file=sys.stderr)
        sys.exit(1)
