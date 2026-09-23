#!/usr/bin/env python3
"""Fresh-file SPIRE host delivery and restart preflight; never activates services."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import stat
import subprocess
import sys
import time
from pathlib import Path

VERSION = '1.15.3'
PREFIX = Path('/opt/axiom/spire') / VERSION
OWNER = 0


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate field')
        result[key] = value
    return result


def layout(role: str) -> dict[str, tuple[Path, int, int]]:
    if role not in ('issuer', 'runner'):
        raise ValueError('role refused')
    binary = 'spire-server' if role == 'issuer' else 'spire-agent'
    result = {
        binary: (Path('/usr/local/bin') / binary, 0o755, 192 * 1024 * 1024),
        'spire_host.py': (PREFIX / 'spire_host.py', 0o600, 65536),
        'spire_state.py': (PREFIX / 'spire_state.py', 0o600, 65536),
        'state.json': (Path('/etc/axiom/spire/state.json'), 0o600, 4096),
        'spire.conf': (Path('/etc/axiom/spire') / ('server.conf' if role == 'issuer' else 'agent.conf'), 0o600, 16384),
        'state.mount': (Path('/etc/systemd/system/var-lib-spire.mount'), 0o644, 16384),
        'spire.service': (Path('/etc/systemd/system') / f'axiom-spire-{role}.service', 0o644, 16384),
    }
    if role == 'issuer':
        result.update({
            'spire_enrollment.py': (PREFIX / 'spire_enrollment.py', 0o600, 65536),
            'enroll.service': (Path('/etc/systemd/system/axiom-spire-enroll-issuer.service'), 0o644, 16384),
        })
    if role == 'runner':
        result.update({
            'bootstrap.pem': (Path('/etc/axiom/spire/bootstrap.pem'), 0o600, 65536),
            'spire_health.py': (PREFIX / 'spire_health.py', 0o600, 65536),
            'health.service': (Path('/etc/systemd/system/axiom-spire-health.service'), 0o644, 16384),
        })
    return result


def manifest(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {'schemaVersion', 'spireVersion', 'platform', 'architecture', 'role', 'files'}:
        raise ValueError('manifest refused')
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1 or value['spireVersion'] != VERSION or value['platform'] != 'ubuntu-24.04' or value['architecture'] not in ('amd64', 'arm64'):
        raise ValueError('manifest refused')
    if not isinstance(value['files'], dict) or set(value['files']) != set(layout(value['role'])):
        raise ValueError('manifest inventory refused')
    for digest in value['files'].values():
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('manifest digest refused')
    return value


def protected_directory(path: Path) -> None:
    for parent in (path, *path.parents):
        if parent.resolve(strict=True) != parent:
            raise ValueError('directory alias refused')
        meta = parent.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != OWNER or meta.st_mode & 0o022:
            raise ValueError('directory protection refused')


def read_file(path: Path, maximum: int, mode: int | None = None) -> bytes:
    protected_directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != OWNER or meta.st_nlink != 1 or meta.st_mode & 0o022 or not 0 < meta.st_size <= maximum:
            raise ValueError('file protection refused')
        if mode is not None and stat.S_IMODE(meta.st_mode) != mode:
            raise ValueError('file mode refused')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(maximum + 1)
        if len(data) != meta.st_size:
            raise ValueError('file changed')
        return data
    finally:
        os.close(fd)


def host_profile(value: dict) -> None:
    if sys.platform != 'linux' or sys.version_info[:2] != (3, 12):
        raise ValueError('host runtime refused')
    release = platform.freedesktop_os_release()
    if release.get('ID') != 'ubuntu' or release.get('VERSION_ID') != '24.04':
        raise ValueError('host platform refused')
    expected = {'amd64': 'x86_64', 'arm64': 'aarch64'}[value['architecture']]
    if platform.machine() != expected:
        raise ValueError('host architecture refused')
    version = subprocess.run(['/usr/bin/systemctl', '--version'], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, env={'PATH': '/usr/bin', 'LC_ALL': 'C'}).stdout
    if not version.startswith(b'systemd 255 '):
        raise ValueError('service manager refused')
    prerequisites = ['/usr/sbin/blkid', '/usr/bin/python3', '/usr/bin/systemctl']
    if value['role'] == 'runner':
        prerequisites.append('/usr/bin/docker')
    for name in prerequisites:
        path = Path(name).resolve(strict=True)
        protected_directory(path.parent)
        meta = path.stat()
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != OWNER or meta.st_mode & 0o022 or not meta.st_mode & 0o111:
            raise ValueError('host prerequisite refused')


def bundle(path: Path, expected: str) -> tuple[dict, bytes, dict[str, bytes]]:
    if not re.fullmatch(r'[0-9a-f]{64}', expected):
        raise ValueError('review digest refused')
    raw = read_file(path / 'manifest.json', 16384, 0o600)
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('review binding refused')
    value = manifest(json.loads(raw, object_pairs_hook=unique))
    # No arbitrary paths or executable installer hooks are accepted in a bundle.
    expected_names = {'manifest.json', *layout(value['role'])}
    if {p.name for p in path.iterdir()} != expected_names:
        raise ValueError('bundle inventory refused')
    files = {}
    for name, (_, _, maximum) in layout(value['role']).items():
        data = read_file(path / name, maximum, 0o600)
        if hashlib.sha256(data).hexdigest() != value['files'][name]:
            raise ValueError('bundle file refused')
        files[name] = data
    return value, raw, files


def installed(role: str) -> dict:
    value = manifest(json.loads(read_file(PREFIX / 'manifest.json', 16384, 0o600), object_pairs_hook=unique))
    if value['role'] != role:
        raise ValueError('installed role refused')
    host_profile(value)
    for name, (path, mode, maximum) in layout(role).items():
        if hashlib.sha256(read_file(path, maximum, mode)).hexdigest() != value['files'][name]:
            raise ValueError('installed file changed')
    return value


def parent_for_delivery(path: Path) -> None:
    missing = []
    current = path
    while not current.exists():
        if current.is_symlink():
            raise ValueError('directory alias refused')
        missing.append(current)
        current = current.parent
    protected_directory(current)
    for directory in reversed(missing):
        mode = 0o700 if directory == Path('/etc/axiom/spire') else 0o755
        directory.mkdir(mode=mode)
        os.chmod(directory, mode)
        protected_directory(directory)


def deliver(path: Path, data: bytes, mode: int) -> None:
    parent_for_delivery(path.parent)
    # Exact files may be reused after an interrupted delivery; foreign content
    # or permissions are never overwritten or silently repaired.
    if path.exists() or path.is_symlink():
        if read_file(path, len(data), mode) != data:
            raise ValueError('existing destination refused')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
    except BaseException:
        # An interrupted/failed partial file remains fail-closed for review.
        raise


def install(path: Path, expected: str) -> None:
    value, raw, files = bundle(path, expected)
    host_profile(value)
    targets = [(destination, files[name], mode) for name, (destination, mode, _) in layout(value['role']).items()]
    targets.append((PREFIX / 'manifest.json', raw, 0o600))
    # Validate all already-existing paths before writing anything. A common
    # version directory prevents accidental issuer/runner co-installation.
    for destination, data, mode in targets:
        if destination.exists() or destination.is_symlink():
            if read_file(destination, len(data), mode) != data:
                raise ValueError('conflicting installation refused')
        ancestor = destination.parent
        while not ancestor.exists():
            if ancestor.is_symlink():
                raise ValueError('destination alias refused')
            ancestor = ancestor.parent
        protected_directory(ancestor)
    for destination, data, mode in targets:
        deliver(destination, data, mode)
    installed(value['role'])


def runtime(role: str) -> None:
    if role != 'runner':
        raise ValueError('runtime role refused')
    for path in (Path('/run/workload'), Path('/run/spire-health')):
        protected_directory(path.parent)
        try:
            path.mkdir(mode=0o755)
            os.chmod(path, 0o755)
        except FileExistsError:
            pass
        protected_directory(path)
        if stat.S_IMODE(path.stat().st_mode) != 0o755:
            raise ValueError('runtime directory refused')


def wait_ready(role: str) -> None:
    if role not in ('issuer', 'runner'):
        raise ValueError('readiness role refused')
    binary, socket = ('spire-server', '/run/spire-server/api.sock') if role == 'issuer' else ('spire-agent', '/run/workload/api.sock')
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            result = subprocess.run(['/usr/local/bin/' + binary, 'healthcheck', '-socketPath', socket], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=min(2, max(0.01, deadline-time.monotonic())), env={'PATH':'/usr/local/bin:/usr/bin','HOME':'/nonexistent'})
            if result.returncode == 0:
                return
        except subprocess.TimeoutExpired:
            pass
        time.sleep(0.5)
    raise ValueError('SPIRE readiness refused')


def main() -> None:
    if os.geteuid() != 0 or sys.platform != 'linux':
        raise ValueError('host invocation refused')
    os.umask(0o077)
    args = sys.argv[1:]
    if len(args) == 3 and args[0] in ('--check-bundle', '--install'):
        path = Path(args[1])
        if args[0] == '--install':
            install(path, args[2])
        else:
            value, _, _ = bundle(path, args[2]); host_profile(value)
    elif len(args) == 2 and args[0] == '--installed':
        installed(args[1])
    elif len(args) == 2 and args[0] == '--runtime':
        runtime(args[1])
    elif len(args) == 2 and args[0] == '--wait':
        wait_ready(args[1])
    else:
        raise ValueError('host invocation refused')
    print('SPIRE host operation passed; services were not activated by this command.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('SPIRE host operation refused.', file=sys.stderr)
        sys.exit(1)
