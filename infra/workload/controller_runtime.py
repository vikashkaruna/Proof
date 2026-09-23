#!/usr/bin/env python3
"""Explicit host supervision with durable ownership; never recovers by name."""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import signal
import stat
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, '/opt/axiom/spire/1.15.3')
import controller_files as files
import controller_placement as placement
import spire_enrollment as enrollment
import spire_host as host
import spire_volumes as volumes

PROFILES = Path('/etc/axiom/controller-runtime')
STATE = Path('/var/lib/axiom-controller')
ENTRYPOINT = ['/sbin/tini', '--', 'node', '--import', '/app/node_modules/tsx/dist/loader.mjs', 'src/assessment-controller-service.ts']
LABEL = 'ai.axiomproof.controller.'


def tenant(value: object) -> str:
    if not isinstance(value, str) or str(uuid.UUID(value)) != value or uuid.UUID(value).int == 0:
        raise ValueError('runtime tenant refused')
    return value


def profile(value: object) -> dict:
    keys = {'schemaVersion', 'tenantId', 'placementFile', 'placementSha256', 'backendUrl'}
    if not isinstance(value, dict) or set(value) != keys or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('runtime profile refused')
    tenant(value['tenantId']); enrollment.sha(value['placementSha256'])
    path = value['placementFile']
    if not isinstance(path, str) or not re.fullmatch(r'/[A-Za-z0-9/_.-]{1,4095}', path) or str(Path(path)) != path or '..' in Path(path).parts:
        raise ValueError('runtime placement path refused')
    url = value['backendUrl']
    if not isinstance(url, str) or len(url) > 2048 or any(ord(char) < 33 or ord(char) > 126 for char in url):
        raise ValueError('backend URL refused')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/') or parsed.port not in (None, 443, 8443):
        raise ValueError('backend HTTPS origin required')
    return value


def reviewed(path: Path, expected: str) -> dict:
    enrollment.sha(expected)
    raw = host.read_file(path, 8192, 0o600)
    if enrollment.digest(raw) != expected: raise ValueError('runtime review digest refused')
    return profile(json.loads(raw, object_pairs_hook=host.unique))


def unit(value: dict, expected: str) -> bytes:
    profile(value); enrollment.sha(expected)
    return f'''[Unit]
Description=Axiom reviewed tenant assessment controller
BindsTo=docker.service axiom-spire-runner.service axiom-spire-health.service
After=docker.service axiom-spire-runner.service axiom-spire-health.service

[Service]
Type=exec
User=root
Group=root
UMask=0077
ExecStart=/usr/bin/python3 -I -B {host.PREFIX}/controller_runtime.py --run {expected}
ExecStopPost=/usr/bin/python3 -I -B {host.PREFIX}/controller_runtime.py --stop {value['tenantId']} {expected}
Restart=no
TimeoutStartSec=180
TimeoutStopSec=130
KillMode=control-group
NoNewPrivileges=yes
LimitCORE=0
TasksMax=128
MemoryMax=256M
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
'''.encode()


def install(source: Path, expected: str) -> None:
    value = reviewed(source, expected)
    raw = host.read_file(source, 8192, 0o600)
    if enrollment.digest(raw) != expected: raise ValueError('runtime profile changed')
    # Installation is static delivery. Live admission happens again at --run.
    placement_raw = host.read_file(Path(value['placementFile']), 4096, 0o600)
    if enrollment.digest(placement_raw) != value['placementSha256']: raise ValueError('placement review refused')
    placed = placement.profile(json.loads(placement_raw, object_pairs_hook=host.unique))
    if placed['tenantId'] != value['tenantId']: raise ValueError('runtime tenant mismatch')
    files.check(placed['tenantId'], placed['controllerManifestSha256'])
    target = Path('/etc/systemd/system')/('axiom-controller-'+value['tenantId']+'.service')
    payload = unit(value, expected)
    destination = PROFILES/(expected+'.json')
    for path, data, mode in ((destination, raw, 0o600), (target, payload, 0o600)):
        if path.exists() or path.is_symlink():
            if host.read_file(path, 8192, mode) != data: raise ValueError('existing runtime delivery refused')
    files.private_directory(PROFILES, 0o700)
    for path, data in ((destination, raw), (target, payload)):
        if not path.exists(): enrollment.create(path, data)
    # No daemon-reload, enable, start, disk changes or image pulls.


@contextlib.contextmanager
def locked(identifier: str):
    tenant(identifier)
    files.private_directory(STATE, 0o700)
    directory = STATE/identifier
    files.private_directory(directory, 0o700)
    fd = os.open(directory/'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != host.OWNER or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('runtime lock refused')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield directory
    finally: os.close(fd)


def docker(*args: str, timeout=5) -> bytes:
    volumes.daemon_namespace()
    host.protected_directory(volumes.SOCKET.parent)
    info = volumes.SOCKET.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o002:
        raise ValueError('runtime Docker socket refused')
    return enrollment.command(['/usr/bin/docker', '--host', 'unix:///run/docker.sock', '--config', '/nonexistent/axiom-docker-config', *args], timeout=timeout)


def observation(*args: str) -> dict:
    values = json.loads(docker(*args), object_pairs_hook=host.unique)
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        raise ValueError('runtime Docker observation refused')
    return values[0]


def image_environment(image: str) -> list[str]:
    value = observation('image', 'inspect', image)
    config = value.get('Config', {})
    if value.get('Id') != image or config.get('User') != '20000:20000' or config.get('Entrypoint') != ENTRYPOINT or config.get('WorkingDir') != '/app/services/bff' or config.get('Cmd') not in (None, []) or config.get('Volumes') or config.get('OnBuild') or config.get('Healthcheck') or config.get('StopSignal') not in (None, '', 'SIGTERM'):
        raise ValueError('reviewed controller image contract refused')
    env = config.get('Env')
    if not isinstance(env, list) or any(not isinstance(item, str) or '=' not in item for item in env): raise ValueError('image environment refused')
    values = dict(item.split('=', 1) for item in env)
    fixed = {'PATH': '/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'PNPM_HOME': '/pnpm', 'NODE_ENV': 'production', 'TSX_DISABLE_CACHE': '1'}
    if len(env) != len(values) or set(values) != {*fixed, 'NODE_VERSION', 'YARN_VERSION'} or any(values.get(key) != item for key, item in fixed.items()) or any(not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', values[key]) for key in ('NODE_VERSION', 'YARN_VERSION')):
        raise ValueError('image environment refused')
    return env


def spec(value: dict, expected: str, ready: dict, attempt: str) -> dict:
    if ready['profile']['tenantId'] != value['tenantId']: raise ValueError('runtime tenant mismatch')
    image = ready['image']; env = image_environment(image)
    info = volumes.SOCKET.lstat()
    if info.st_gid < 0: raise ValueError('daemon group refused')
    name = 'axiom-controller-'+attempt
    labels = {LABEL+'tenant': value['tenantId'], LABEL+'profile': expected, LABEL+'attempt': attempt}
    environment = [*env, 'AXIOM_REGION=ap-south-1', 'AWS_REGION=ap-south-1', 'SUPABASE_URL='+value['backendUrl']]
    mounts = [
        {'Type': 'bind', 'Source': ready['files'], 'Target': '/run/controller-secrets', 'ReadOnly': True},
        {'Type': 'bind', 'Source': '/run/docker.sock', 'Target': '/run/docker.sock'},
        *({'Type': 'volume', 'Source': ready['volumes'][kind]['Name'], 'Target': target, 'ReadOnly': True, 'VolumeOptions': {'NoCopy': True}} for kind, target in (('workload', '/run/workload'), ('health', '/run/spire-health'))),
    ]
    return {'name': name, 'image': image, 'labels': labels, 'env': environment, 'mounts': mounts, 'group': str(info.st_gid), 'privateIp': ready['profile']['privateIp']}


def arguments(value: dict) -> list[str]:
    args = ['create', '--pull', 'never', '--name', value['name'], '--hostname', value['name'], '--user', '20000:20000', '--group-add', value['group'], '--network', 'bridge', '--ipc', 'private', '--cgroupns', 'private', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--memory-swap', '512m', '--log-driver', 'none', '--restart', 'no', '--stop-signal', 'SIGTERM', '--publish', value['privateIp']+':8443:8443/tcp']
    for key, item in value['labels'].items(): args += ['--label', key+'='+item]
    for item in value['env']: args += ['--env', item]
    for mount in value['mounts']:
        option = 'type='+mount['Type']+',src='+mount['Source']+',dst='+mount['Target']
        if mount.get('ReadOnly'): option += ',readonly'
        if mount['Type'] == 'volume': option += ',volume-nocopy'
        args += ['--mount', option]
    return [*args, value['image'], '--serve', '/run/controller-secrets/service.json']


def owned(identifier: str, intended: dict) -> dict:
    if not re.fullmatch(r'[a-f0-9]{64}', identifier): raise ValueError('container ID refused')
    actual = observation('container', 'inspect', identifier)
    if actual.get('Id') != identifier or actual.get('Name') != '/'+intended['name'] or actual.get('Image') != intended['image'] or actual.get('Config', {}).get('Labels') != intended['labels']:
        raise ValueError('container ownership refused')
    return actual


def created(identifier: str, intended: dict) -> None:
    actual = owned(identifier, intended)
    config, setup = actual['Config'], actual['HostConfig']
    expected_config = {'User': '20000:20000', 'Entrypoint': ENTRYPOINT, 'Cmd': ['--serve', '/run/controller-secrets/service.json'], 'WorkingDir': '/app/services/bff', 'Hostname': intended['name'], 'OpenStdin': False, 'Tty': False, 'StopSignal': 'SIGTERM'}
    expected_host = {'NetworkMode': 'bridge', 'IpcMode': 'private', 'CgroupnsMode': 'private', 'ReadonlyRootfs': True, 'Privileged': False, 'PidMode': '', 'UTSMode': '', 'CapAdd': None, 'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'], 'GroupAdd': [intended['group']], 'PidsLimit': 128, 'Memory': 536870912, 'MemorySwap': 536870912, 'LogConfig': {'Type': 'none', 'Config': {}}, 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0}, 'PortBindings': {'8443/tcp': [{'HostIp': intended['privateIp'], 'HostPort': '8443'}]}, 'Mounts': intended['mounts']}
    if any(config.get(key) != value for key, value in expected_config.items()) or any(setup.get(key) != value for key, value in expected_host.items()) or sorted(config.get('Env', [])) != sorted(intended['env']) or any(setup.get(key) for key in ('Binds', 'Devices', 'DeviceRequests', 'VolumesFrom', 'Links', 'ExtraHosts', 'Tmpfs')) or actual.get('State', {}).get('Status') != 'created':
        raise ValueError('created controller confinement refused')


def pending(directory: Path) -> list[Path]:
    result = []
    for path in directory.iterdir():
        if path.name == 'lock': continue
        tenant(path.name); host.protected_directory(path)
        if stat.S_IMODE(path.stat().st_mode) != 0o700: raise ValueError('attempt protection refused')
        inventory = {p.name for p in path.iterdir()}
        if not {'intent.json'} <= inventory <= {'intent.json', 'container.json', 'stopped.json'}: raise ValueError('attempt inventory refused')
        if 'stopped.json' not in inventory: result.append(path)
        else:
            receipt = enrollment.load(path/'stopped.json')
            if receipt != {'schemaVersion': 1, 'containerId': enrollment.load(path/'container.json').get('containerId')}: raise ValueError('stop receipt refused')
    if len(result) > 1: raise ValueError('ambiguous controller attempts refused')
    return result


def stop_attempt(directory: Path, expected: str) -> None:
    intent = enrollment.load(directory/'intent.json')
    if set(intent) != {'schemaVersion', 'profileSha256', 'spec'} or intent['schemaVersion'] != 1 or intent['profileSha256'] != expected or intent['spec']['labels'].get(LABEL+'attempt') != directory.name or intent['spec']['labels'].get(LABEL+'tenant') != directory.parent.name:
        raise ValueError('runtime intent refused')
    record = enrollment.load(directory/'container.json')
    if set(record) != {'schemaVersion', 'containerId'} or record['schemaVersion'] != 1: raise ValueError('container receipt refused')
    identifier = record['containerId']
    actual = owned(identifier, intent['spec'])
    if actual.get('State', {}).get('Running'):
        # Application allows 85 seconds; Docker has a longer grace period. Stop
        # never calls placement, SPIRE, DNS, KMS or a backend service.
        docker('container', 'stop', '--time', '90', identifier, timeout=100)
    actual = owned(identifier, intent['spec'])
    if actual.get('State', {}).get('Running') is not False or actual.get('State', {}).get('Status') not in ('created', 'exited'):
        raise ValueError('controller stop unconfirmed')
    # Keep stopped containers and journals for explicit review/retention. Never
    # remove or adopt an object solely because its name matches.
    enrollment.create(directory/'stopped.json', enrollment.encode({'schemaVersion': 1, 'containerId': identifier}))


def stop(identifier: str, expected: str) -> None:
    enrollment.sha(expected)
    with locked(identifier) as directory:
        for attempt in pending(directory): stop_attempt(attempt, expected)


def run(expected: str) -> None:
    enrollment.sha(expected)
    path = PROFILES/(expected+'.json'); value = reviewed(path, expected)
    stopping = False
    def requested(*_):
        nonlocal stopping
        stopping = True
    old = {signum: signal.signal(signum, requested) for signum in (signal.SIGTERM, signal.SIGINT)}
    try:
        with locked(value['tenantId']) as directory:
            if pending(directory): raise ValueError('unresolved controller attempt requires review')
            with enrollment.exclusive(): ready = placement.check(Path(value['placementFile']), value['placementSha256'])
            attempt = str(uuid.uuid4()); intended = spec(value, expected, ready, attempt)
            if reviewed(path, expected) != value: raise ValueError('runtime profile changed')
            if stopping: return
            destination = directory/attempt; files.private_directory(destination, 0o700)
            enrollment.create(destination/'intent.json', enrollment.encode({'schemaVersion': 1, 'profileSha256': expected, 'spec': intended}))
            identifier = docker(*arguments(intended), timeout=20).decode('ascii').strip()
            created(identifier, intended)
            enrollment.create(destination/'container.json', enrollment.encode({'schemaVersion': 1, 'containerId': identifier}))
            # An uncertain create preserves intent without adopting a name. Once
            # the exact ID is durable, failure recovery can safely stop that ID.
            try:
                with enrollment.exclusive(): repeated = placement.check(Path(value['placementFile']), value['placementSha256'])
                if repeated != ready or reviewed(path, expected) != value: raise ValueError('runtime admission changed')
                if not stopping:
                    created(identifier, intended)
                    docker('container', 'start', identifier, timeout=20)
                while not stopping:
                    actual = owned(identifier, intended)
                    if actual.get('State', {}).get('Running') is not True or actual['State'].get('Status') != 'running':
                        raise ValueError('controller exited unexpectedly')
                    time.sleep(1)
            finally:
                stop_attempt(destination, expected)
    finally:
        for signum, handler in old.items(): signal.signal(signum, handler)


def main() -> None:
    if sys.platform != 'linux' or os.geteuid() != 0: raise ValueError('root Linux controller runtime required')
    os.umask(0o077)
    if len(sys.argv) == 4 and sys.argv[1] == '--install':
        with enrollment.exclusive(): install(Path(sys.argv[2]), sys.argv[3])
    elif len(sys.argv) == 3 and sys.argv[1] == '--run': run(sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == '--stop': stop(sys.argv[2], sys.argv[3])
    else: raise ValueError('runtime arguments refused')


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Controller runtime refused or stopped; preserve ownership records for review.', file=sys.stderr)
        sys.exit(1)
