#!/usr/bin/env python3
"""Explicit issuer/runner initialization and separate receipt-bound marker publication.

Root-reviewed host administration, not application agent approval. Never repairs,
formats, mounts, reenrolls, enables services or overwrites earlier decisions.
"""
from __future__ import annotations

import contextlib
import base64
import ssl
import fcntl
import hashlib
import json
import os
import re
import selectors
import stat
import subprocess  # nosec B404 - fixed systemctl/enrollment CLIs; argv lists are built from constant paths, never a shell
import sys
import time
import traceback
import uuid
from pathlib import Path

# -I excludes the script directory. Only the fixed protected installation is
# admitted for sibling imports; no cwd/PYTHONPATH/plugin search is required.
sys.path.insert(0, '/opt/axiom/spire/1.15.3')
import spire_host as host
import spire_state as state

DIRECTORY = Path('/etc/axiom/spire')
REQUEST = DIRECTORY/'initialization-request.json'
RECEIPT = DIRECTORY/'initialization-receipt.json'
APPROVAL = DIRECTORY/'initialization-approval.json'
BUNDLE = DIRECTORY/'initialization-bundle.json'
CA = DIRECTORY/'initialization-ca.pem'
PERMIT = Path('/run/axiom-spire-enrollment.json')
LOCK = Path('/run/axiom-spire-enrollment.lock')
NORMAL = 'axiom-spire-issuer.service'
INITIAL = 'axiom-spire-enroll-issuer.service'
ENV = {'PATH':'/usr/local/bin:/usr/bin:/usr/sbin', 'HOME':'/nonexistent', 'LC_ALL':'C'}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value):
        raise ValueError('review digest refused')
    return value


def encode(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(',', ':'))+'\n').encode()


def load(path: Path, maximum=16384) -> dict:
    value = json.loads(host.read_file(path, maximum, 0o600), object_pairs_hook=host.unique)
    if not isinstance(value, dict):
        raise ValueError('record refused')
    return value


def absent(path: Path) -> None:
    if path.exists() or path.is_symlink():
        raise ValueError('existing record refused')


def create(path: Path, data: bytes) -> None:
    host.protected_directory(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


@contextlib.contextmanager
def exclusive():
    host.protected_directory(LOCK.parent)
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_nlink != 1 or stat.S_IMODE(meta.st_mode) != 0o600:
            raise ValueError('enrollment lock refused')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def command(args: list[str], timeout=3, maximum=65536) -> bytes:
    # Bounded stdout and fixed diagnostics: even a misbehaving subprocess cannot
    # dump certificates, tokens or arbitrary private output into host logs.
    with subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=ENV) as process:  # nosec B603 - argv comes from fixed internal caller paths, no shell, bounded output
        try:
            with selectors.DefaultSelector() as selector:
                if process.stdout is None:
                    raise ValueError('enrollment command refused')
                selector.register(process.stdout, selectors.EVENT_READ)
                data = bytearray(); deadline = time.monotonic()+timeout
                while True:
                    remaining = deadline-time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise ValueError('enrollment command timed out')
                    chunk = os.read(process.stdout.fileno(), 4096)
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > maximum:
                        raise ValueError('enrollment output refused')
                remaining = deadline-time.monotonic()
                if remaining <= 0 or process.wait(timeout=remaining) != 0:
                    raise ValueError('enrollment command refused')
                return bytes(data)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def control(*args: str) -> bytes:
    return command(['/usr/bin/systemctl', *args], timeout=40)


def idle(unit: str) -> None:
    properties = ('ActiveState','MainPID','Job','UnitFileState','FragmentPath','DropInPaths','NeedDaemonReload','Transient')
    fields = dict(line.split('=', 1) for line in control('show', *('--property='+key for key in properties), unit).decode('ascii').splitlines())
    if set(fields) != set(properties) or fields['ActiveState'] not in ('inactive','failed') or fields['MainPID'] != '0' or fields['Job'] not in ('','0') or fields['UnitFileState'] != ('disabled' if unit in (NORMAL, 'axiom-spire-runner.service') else 'static'):
        raise ValueError('running queued or enabled service refused')
    if fields['FragmentPath'] != '/etc/systemd/system/'+unit or fields['DropInPaths'] or fields['NeedDaemonReload'] != 'no' or fields['Transient'] != 'no':
        raise ValueError('loaded service configuration refused')


def installed(expected: str, role: str = 'issuer') -> dict:
    sha(expected)
    host.installed(role)
    if digest(host.read_file(host.PREFIX/'manifest.json', 16384, 0o600)) != expected:
        raise ValueError('installation review refused')
    value = state.policy(load(state.CONFIG, 4096))
    if value['role'] != role:
        raise ValueError('enrollment role refused')
    return value


def process_start(pid: int) -> str:
    if type(pid) is not int or pid <= 0:
        raise ValueError('permit process refused')
    path = Path('/proc')/str(pid)/'stat'
    if path.stat().st_uid != 0:
        raise ValueError('permit owner refused')
    raw = path.read_text()  # Kernel-generated one-line record, not operator input.
    if len(raw) > 4096:
        raise ValueError('permit process refused')
    parts = raw[raw.rfind(')')+2:].split()
    return parts[19]


def permit(role: str = 'issuer') -> None:
    value = load(PERMIT)
    if set(value) != {'schemaVersion','requestSha256','manifestSha256','pid','processStart','createdAtMs','expiresAtMs'} or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('permit refused')
    now = time.time_ns()//1000000
    created, expiry = value['createdAtMs'], value['expiresAtMs']
    if type(created) is not int or type(expiry) is not int or not created <= now < expiry or expiry-created != 60000:
        raise ValueError('permit expired')
    if process_start(value['pid']) != value['processStart']:
        raise ValueError('permit process changed')
    request_raw = host.read_file(REQUEST, 16384, 0o600)
    request = json.loads(request_raw, object_pairs_hook=host.unique)
    if digest(request_raw) != sha(value['requestSha256']) or request.get('manifestSha256') != value['manifestSha256']:
        raise ValueError('permit request changed')
    if installed(value['manifestSha256'], role) != request.get('binding'):
        raise ValueError('permit binding changed')
    # Unit starts only while the explicit CLI still owns its exclusive lock.
    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(exclusive())
        except BlockingIOError:
            return
        raise ValueError('permit owner absent')


def normalized(value: object) -> object:
    if isinstance(value, dict):
        return {key:normalized(item) for key,item in value.items()}
    if isinstance(value, list):
        return sorted((normalized(item) for item in value), key=lambda item:json.dumps(item,sort_keys=True))
    return value


def bootstrap(value: dict) -> bytes:
    certificates = []
    for key in value['keys']:
        if key.get('use') != 'x509-svid':
            continue
        chain = key.get('x5c')
        if not isinstance(chain, list) or len(chain) != 1 or not isinstance(chain[0], str):
            raise ValueError('initial CA encoding refused')
        der = base64.b64decode(chain[0], validate=True)
        if not 32 <= len(der) <= 16384 or der[0] != 0x30:
            raise ValueError('initial CA encoding refused')
        certificates.append(der)
    if len(set(certificates)) != len(certificates):
        raise ValueError('duplicate initial CA refused')
    # The pinned SPIRE issuer supplies these certificates. This conversion is
    # byte-preserving export for review, not an independent crypto validator.
    return ''.join(ssl.DER_cert_to_PEM_cert(der) for der in sorted(certificates)).encode('ascii')


def trust_summary(raw: bytes) -> dict:
    value = json.loads(raw, object_pairs_hook=host.unique)
    if not isinstance(value, dict) or not isinstance(value.get('keys'), list) or not 2 <= len(value['keys']) <= 64:
        raise ValueError('initial issuer bundle refused')
    counts = {'x509-svid':0, 'jwt-svid':0}
    for key in value['keys']:
        if not isinstance(key, dict) or key.get('use') not in counts or key.get('kty') not in ('EC','RSA') or set(key) & {'d','p','q','dp','dq','qi','oth','k'}:
            raise ValueError('initial issuer authority refused')
        counts[key['use']] += 1
    if any(number == 0 for number in counts.values()):
        raise ValueError('initial issuer authorities incomplete')
    return {'bundleSha256':digest(encode(normalized(value))), 'bootstrapCaSha256':digest(bootstrap(value)), 'x509Authorities':counts['x509-svid'], 'jwtAuthorities':counts['jwt-svid']}


def trust() -> tuple[dict, bytes, bytes]:
    raw = command(['/usr/local/bin/spire-server','bundle','show','-socketPath','/run/spire-server/api.sock','-format','spiffe'])
    summary = trust_summary(raw)
    value = json.loads(raw, object_pairs_hook=host.unique)
    return summary, encode(normalized(value)), bootstrap(value)


def fingerprint(role: str = 'issuer') -> dict:
    state.check('--unsealed',role)
    data = state.STATE/('server' if role == 'issuer' else 'agent')
    storage = 'db.sqlite3' if role == 'issuer' else 'agent-data.json'
    # A stopped, fresh SQLite store must have no uncheckpointed side files.
    if {p.name for p in data.iterdir()} != {'keys.json',storage}:
        raise ValueError('initial state inventory refused')
    result = {'keysSha256':digest(state.private_file(data/'keys.json', 1024*1024)),
              ('registrySha256' if role == 'issuer' else 'nodeStateSha256'):digest(state.private_file(data/storage, (64 if role == 'issuer' else 1)*1024*1024))}
    state.check('--unsealed',role)
    return result


def services(role: str) -> tuple[str, str]:
    if role not in ('issuer', 'runner'):
        raise ValueError('enrollment role refused')
    return f'axiom-spire-{role}.service', f'axiom-spire-enroll-{role}.service'


def quiescent(role: str) -> None:
    for unit in services(role):
        idle(unit)
    if role == 'runner':
        idle('axiom-spire-health.service')


def node_observation(binding: dict) -> dict:
    # Import only the fixed protected sibling, checked by host.installed.
    import spire_health
    observed = spire_health.snapshot(spire_health.query(), binding['nodeId'], time.time_ns()//1000000)
    return {**observed, 'bootstrapCaSha256':digest(host.read_file(DIRECTORY/'bootstrap.pem', 65536, 0o600))}


def initialize(expected: str, role: str = 'issuer') -> str:
    _, initial = services(role)
    binding = installed(expected, role)
    quiescent(role)
    for path in (REQUEST, RECEIPT, APPROVAL, PERMIT, BUNDLE, CA):
        absent(path)
    state.check('--empty',role)
    now = time.time_ns()//1000000
    request = {'schemaVersion':1, 'operationId':str(uuid.uuid4()), 'action':'initialize-'+role, 'manifestSha256':expected, 'binding':binding, 'requestedAtMs':now}
    request_raw = encode(request)
    # The reviewed request is durable BEFORE starting the mutating process.
    create(REQUEST, request_raw)
    authorization = {'schemaVersion':1, 'requestSha256':digest(request_raw), 'manifestSha256':expected, 'pid':os.getpid(), 'processStart':process_start(os.getpid()), 'createdAtMs':now, 'expiresAtMs':now+60000}
    create(PERMIT, encode(authorization))
    try:
        control('start', initial)
        if role == 'issuer':
            observation, public_bundle, ca = trust()
            if (observation, public_bundle, ca) != trust():
                raise ValueError('initial trust changed during observation')
        else:
            observation = node_observation(binding)
            second = node_observation(binding)
            if second['syncAtMs'] < observation['syncAtMs'] or second['bootstrapCaSha256'] != observation['bootstrapCaSha256']:
                raise ValueError('initial node observation changed')
            observation = second
    finally:
        try:
            control('stop', initial)
            idle(initial)
        finally:
            PERMIT.unlink(missing_ok=True)
    quiescent(role)
    if installed(expected, role) != binding:
        raise ValueError('initial binding changed')
    evidence = {'schemaVersion':1, 'requestSha256':digest(request_raw), 'manifestSha256':expected,
                'binding':binding, 'trust':observation, 'state':fingerprint(role), 'completedAtMs':time.time_ns()//1000000}
    if role == 'issuer':
        create(BUNDLE, public_bundle); create(CA, ca)
    raw = encode(evidence); create(RECEIPT, raw)
    return digest(raw)


def reviewed_node(observation: object, binding: dict) -> None:
    now = time.time_ns()//1000000
    if not isinstance(observation, dict) or observation.get('nodeId') != binding['nodeId'] or observation.get('healthy') is not True or type(observation.get('certificateExpiresAtMs')) is not int or observation['certificateExpiresAtMs'] <= now:
        raise ValueError('reviewed node identity expired or changed')
    if digest(host.read_file(DIRECTORY/'bootstrap.pem', 65536, 0o600)) != observation.get('bootstrapCaSha256'):
        raise ValueError('reviewed node bootstrap changed')


def seal(expected_receipt: str, role: str = 'issuer') -> None:
    services(role)
    sha(expected_receipt)
    raw = host.read_file(RECEIPT, 16384, 0o600)
    if digest(raw) != expected_receipt:
        raise ValueError('receipt review refused')
    value = json.loads(raw, object_pairs_hook=host.unique)
    if not isinstance(value, dict) or set(value) != {'schemaVersion','requestSha256','manifestSha256','binding','trust','state','completedAtMs'} or type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        raise ValueError('receipt refused')
    binding = installed(value['manifestSha256'], role)
    request = host.read_file(REQUEST, 16384, 0o600)
    requested = json.loads(request, object_pairs_hook=host.unique)
    if digest(request) != sha(value['requestSha256']) or requested.get('manifestSha256') != value['manifestSha256'] or requested.get('binding') != binding or value['binding'] != binding:
        raise ValueError('receipt binding changed')
    if role == 'issuer':
        public = host.read_file(BUNDLE, 65536, 0o600)
        ca = host.read_file(CA, 65536, 0o600)
        if not isinstance(value['trust'], dict) or digest(public) != value['trust'].get('bundleSha256') or digest(ca) != value['trust'].get('bootstrapCaSha256'):
            raise ValueError('reviewed public trust changed')
    else:
        reviewed_node(value['trust'], binding)
    quiescent(role)
    absent(PERMIT); absent(APPROVAL); absent(state.STATE/'.axiom-state.json')
    if fingerprint(role) != value['state']:
        raise ValueError('stopped state changed after review')
    # Persist the separate review before publishing the marker. Partial writes
    # stay fail-closed for explicit recovery; no retry overwrites prior records.
    approval = {'schemaVersion':1, 'action':'seal-'+role+'-initialization', 'receiptSha256':expected_receipt, 'manifestSha256':value['manifestSha256'], 'binding':binding, 'approvedAtMs':time.time_ns()//1000000}
    create(APPROVAL, encode(approval))
    if installed(value['manifestSha256'], role) != binding or fingerprint(role) != value['state']:
        raise ValueError('state changed before publication')
    quiescent(role)
    if role == 'runner':
        reviewed_node(value['trust'], binding)
    create(state.STATE/'.axiom-state.json', encode(binding))
    state.check('--ready',role)


def main() -> None:
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ValueError('root Linux enrollment required')
    os.umask(0o077)
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == '--permit' and args[1] in ('issuer', 'runner'):
        permit(args[1]); return
    if len(args) != 3 or args[1] not in ('issuer', 'runner') or args[0] not in ('--initialize','--seal'):
        raise ValueError('enrollment invocation refused')
    with exclusive():
        if args[0] == '--initialize':
            result = initialize(args[2], args[1])
            print('SPIRE stopped with unmarked state. Review receipt SHA256 '+result+' before separate marker publication.')
        else:
            seal(args[2], args[1]); print('Reviewed SPIRE marker published. Normal services remain disabled and stopped.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        frames = [f'{frame.name}:{frame.lineno}' for frame in traceback.extract_tb(error.__traceback__) if Path(frame.filename).name in ('spire_enrollment.py','spire_host.py','spire_state.py')]
        print('SPIRE enrollment refused at '+' / '.join(frames)+'; existing state and review records require inspection.', file=sys.stderr)
        sys.exit(1)
