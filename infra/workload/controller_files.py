#!/usr/bin/env python3
"""Protected, versioned controller file delivery. Never starts a container or unit."""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import sys
import uuid
from pathlib import Path
sys.path.insert(0, '/opt/axiom/spire/1.15.3')
import spire_host as host
import spire_enrollment as enrollment

ROOT = Path('/etc/axiom/controllers')
RUNTIME = '/run/controller-secrets'
FILES = {'service.json': 16384, 'backend.key': 8194, 'tls.key': 16384, 'tls.crt': 65536}
UID = 20000
GID = 20000


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def manifest(value: object) -> dict:
    fields = {'schemaVersion', 'tenantId', 'spireManifestSha256', 'controllerImage', 'files'}
    if not isinstance(value, dict) or set(value) != fields or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('controller manifest refused')
    tenant = value['tenantId']
    if not isinstance(tenant, str) or str(uuid.UUID(tenant)) != tenant:
        raise ValueError('tenant refused')
    enrollment.sha(value['spireManifestSha256'])
    if not isinstance(value['controllerImage'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', value['controllerImage']):
        raise ValueError('controller image refused')
    if not isinstance(value['files'], dict) or set(value['files']) != set(FILES):
        raise ValueError('controller file inventory refused')
    for sha in value['files'].values(): enrollment.sha(sha)
    return value


def configuration(raw: bytes, review: dict, binding: dict) -> None:
    value = json.loads(raw, object_pairs_hook=host.unique)
    if not isinstance(value, dict) or set(value) != {'controller', 'listen', 'tls', 'backendServiceKeyFile'}:
        raise ValueError('service configuration refused')
    if value['listen'] != {'host': '0.0.0.0', 'port': 8443} or value['tls'] != {'keyFile': RUNTIME+'/tls.key', 'certFile': RUNTIME+'/tls.crt'} or value['backendServiceKeyFile'] != RUNTIME+'/backend.key':
        raise ValueError('protected service paths refused')
    controller = value['controller']
    fields = {'schemaVersion', 'tenantId', 'trustDomain', 'workloadSocket', 'issuerNodeId', 'namespace', 'launcher', 'keys', 'scheduler'}
    if not isinstance(controller, dict) or set(controller) != fields or type(controller['schemaVersion']) is not int or controller['schemaVersion'] != 1:
        raise ValueError('controller configuration refused')
    if controller['tenantId'] != review['tenantId'] or controller['trustDomain'] != binding['trustDomain'] or controller['issuerNodeId'] != binding['nodeId'] or controller['workloadSocket'] != '/run/workload/api.sock':
        raise ValueError('controller binding refused')
    launcher = controller['launcher']
    if not isinstance(launcher, dict) or set(launcher) != {'executable', 'dockerHost', 'image', 'workloadApiVolume'}:
        raise ValueError('launcher refused')
    if launcher['executable'] != '/usr/bin/docker' or launcher['dockerHost'] != 'unix:///run/docker.sock' or launcher['workloadApiVolume'] != 'axiom-workload-api-'+binding['filesystemUuid'] or not isinstance(launcher['image'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', launcher['image']):
        raise ValueError('launcher binding refused')
    # Full policy, KMS, scheduler and TLS validation remains authoritative in the
    # actual image's --check entrypoint. File delivery confers no runtime readiness.
    if not isinstance(controller['namespace'], str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', controller['namespace']):
        raise ValueError('namespace refused')
    if not isinstance(controller['keys'], dict) or set(controller['keys']) != {'provider', 'primary', 'retiring'} or controller['keys']['provider'] not in ('aws', 'gcp'):
        raise ValueError('key policy refused')
    if not isinstance(controller['scheduler'], dict) or set(controller['scheduler']) != {'audience', 'subject', 'email'}:
        raise ValueError('scheduler configuration refused')


def bundle(source: Path, expected: str) -> tuple[dict, bytes, dict[str, bytes]]:
    enrollment.sha(expected)
    raw = host.read_file(source/'manifest.json', 16384, 0o600)
    if digest(raw) != expected: raise ValueError('review digest refused')
    review = manifest(json.loads(raw, object_pairs_hook=host.unique))
    if {p.name for p in source.iterdir()} != {'manifest.json', *FILES}: raise ValueError('source inventory refused')
    payload = {name: host.read_file(source/name, maximum, 0o600) for name, maximum in FILES.items()}
    if any(digest(data) != review['files'][name] for name, data in payload.items()): raise ValueError('source digest refused')
    return review, raw, payload


def private_directory(path: Path, mode: int) -> None:
    host.protected_directory(path.parent)
    if not path.exists() and not path.is_symlink():
        path.mkdir(mode=mode)
        path.chmod(mode)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    host.protected_directory(path)
    if stat.S_IMODE(path.stat().st_mode) != mode: raise ValueError('directory mode refused')


def runtime_file(path: Path, maximum: int) -> bytes:
    host.protected_directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != UID or meta.st_gid != GID or meta.st_nlink != 1 or stat.S_IMODE(meta.st_mode) != 0o400 or not 0 < meta.st_size <= maximum:
            raise ValueError('runtime file protection refused')
        with os.fdopen(os.dup(fd), 'rb') as stream: data = stream.read(maximum+1)
        if len(data) != meta.st_size: raise ValueError('runtime file changed')
        return data
    finally: os.close(fd)


def checked(review: dict, raw: bytes, expected: str) -> Path:
    directory = ROOT/review['tenantId']/expected
    for parent in (ROOT, ROOT/review['tenantId'], directory):
        host.protected_directory(parent)
        if stat.S_IMODE(parent.stat().st_mode) != 0o700: raise ValueError('private ancestry refused')
    if host.read_file(directory/'manifest.json', 16384, 0o600) != raw: raise ValueError('installed manifest refused')
    if {p.name for p in directory.iterdir()} != {'manifest.json', 'ready.json', 'files'}: raise ValueError('installed inventory refused')
    files = directory/'files'
    host.protected_directory(files)
    if stat.S_IMODE(files.stat().st_mode) != 0o755 or {p.name for p in files.iterdir()} != set(FILES): raise ValueError('runtime inventory refused')
    for name, maximum in FILES.items():
        if digest(runtime_file(files/name, maximum)) != review['files'][name]: raise ValueError('runtime digest refused')
    receipt = enrollment.load(directory/'ready.json')
    if receipt != {'schemaVersion': 1, 'manifestSha256': expected}: raise ValueError('delivery receipt refused')
    return files


def install(source: Path, expected: str) -> Path:
    review, raw, payload = bundle(source, expected)
    binding = enrollment.installed(review['spireManifestSha256'], 'runner')
    configuration(payload['service.json'], review, binding)
    private_directory(ROOT.parent, 0o755)
    private_directory(ROOT, 0o700)
    private_directory(ROOT/review['tenantId'], 0o700)
    directory = ROOT/review['tenantId']/expected
    if directory.exists() or directory.is_symlink():
        # Only fully completed identical delivery is retryable. Preserve a partial
        # generation for explicit operator investigation, never repair it in place.
        return checked(review, raw, expected)
    private_directory(directory, 0o700)
    enrollment.create(directory/'manifest.json', raw)
    files = directory/'files'
    private_directory(files, 0o755)
    for name, data in payload.items():
        path = files/name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data);stream.flush()
            os.fchmod(stream.fileno(), 0o400);os.fchown(stream.fileno(), UID, GID);os.fsync(stream.fileno())
    fd = os.open(files, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)
    # Recheck installed SPIRE binding before publishing the completion receipt.
    if enrollment.installed(review['spireManifestSha256'], 'runner') != binding: raise ValueError('node binding changed')
    enrollment.create(directory/'ready.json', enrollment.encode({'schemaVersion': 1, 'manifestSha256': expected}))
    return checked(review, raw, expected)


def check(tenant: str, expected: str) -> Path:
    enrollment.sha(expected)
    if str(uuid.UUID(tenant)) != tenant: raise ValueError('tenant refused')
    directory = ROOT/tenant/expected
    raw = host.read_file(directory/'manifest.json', 16384, 0o600)
    if digest(raw) != expected: raise ValueError('installed digest refused')
    review = manifest(json.loads(raw, object_pairs_hook=host.unique))
    if review['tenantId'] != tenant: raise ValueError('installed tenant refused')
    binding = enrollment.installed(review['spireManifestSha256'], 'runner')
    files = checked(review, raw, expected)
    configuration(runtime_file(files/'service.json', FILES['service.json']), review, binding)
    if enrollment.installed(review['spireManifestSha256'], 'runner') != binding: raise ValueError('node binding changed')
    return files


def main() -> None:
    if sys.platform != 'linux' or os.geteuid() != 0 or len(sys.argv) != 4 or sys.argv[1] not in ('--install', '--check'):
        raise ValueError('root Linux file delivery required')
    os.umask(0o077)
    with enrollment.exclusive():
        if sys.argv[1] == '--install': install(Path(sys.argv[2]), sys.argv[3])
        else: check(sys.argv[2], sys.argv[3])
    print('Controller files verified; no runtime activation or readiness claimed.')


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Controller file delivery refused; preserve the generation for review.', file=sys.stderr)
        sys.exit(1)
