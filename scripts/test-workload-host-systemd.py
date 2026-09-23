#!/usr/bin/env python3
"""Destructive fixture ONLY on a fresh GitHub-hosted Ubuntu VM, never user hosts.

Formats only a newly allocated, backing-file-verified loop device. Product code
never formats, enrolls, mounts or enables anything. Fixture resources are private.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from pathlib import Path

from lib.spire_host_bundle import prepare
from lib.spire_deployment import VERSION

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'infra/workload'))
import spire_host as host

SERVICE = 'axiom-spire-issuer.service'
MOUNT = 'var-lib-spire.mount'
STATE = Path('/var/lib/spire')
ALIAS = Path('/dev/disk/by-id/google-axiom-issuer-state')
IP = '10.231.7.1/32'
ENV = {'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME':'/root', 'LC_ALL':'C'}


def run(argv, check=True, timeout=45):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env=ENV)
    if check and result.returncode:
        raise RuntimeError('isolated systemd fixture operation refused')
    return result


def control(*args, **kwargs):
    return run(['/usr/bin/systemctl', *args], **kwargs)


def active(name):
    return control('is-active', '--quiet', name, check=False).returncode == 0


def stopped(name):
    state = control('show', '--property=ActiveState', '--value', name).stdout.strip()
    pid = control('show', '--property=MainPID', '--value', name).stdout.strip()
    return state in (b'inactive', b'failed') and pid == b'0'


def cli(*args):
    return run(['/usr/local/bin/spire-server', *args, '-socketPath', '/run/spire-server/api.sock'])


def normalized(value):
    if isinstance(value, dict):
        return {key:normalized(item) for key,item in value.items()}
    if isinstance(value, list):
        return sorted((normalized(item) for item in value), key=lambda item:json.dumps(item,sort_keys=True))
    return value


def trust():
    # Include JWT signing keys as well as X.509 roots; output order is not state.
    return normalized(json.loads(cli('bundle', 'show', '-format', 'spiffe').stdout))


def registry():
    return normalized(json.loads(cli('entry', 'show', '-output', 'json').stdout))


def backing_matches(loop, backing):
    result = run(['/usr/sbin/losetup', '--json', '--output', 'NAME,BACK-FILE', loop])
    devices = json.loads(result.stdout)['loopdevices']
    return len(devices) == 1 and devices[0]['name'] == loop and Path(devices[0]['back-file']).resolve() == backing.resolve()


def main():
    if sys.argv[1:] != ['--isolated-ci'] or sys.platform != 'linux' or os.geteuid() != 0 or os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise ValueError('dedicated hosted CI required')
    if Path('/proc/1/comm').read_text().strip() != 'systemd':
        raise ValueError('native systemd required')
    os.umask(0o077)
    # Refuse all existing product resources BEFORE any fixture mutation.
    destinations = [entry[0] for entry in host.layout('issuer').values()] + [host.PREFIX/'manifest.json']
    forbidden = destinations + [STATE, ALIAS, Path('/etc/axiom/spire'), Path('/opt/axiom/spire'), Path('/run/spire-server')]
    if any(p.exists() or p.is_symlink() for p in forbidden):
        raise ValueError('existing host resources refused')
    interfaces = json.loads(run(['/usr/sbin/ip', '-j', 'address', 'show']).stdout)
    if any(a.get('local') == IP.split('/')[0] for i in interfaces for a in i.get('addr_info', [])):
        raise ValueError('existing fixture address refused')
    root = Path(tempfile.mkdtemp(prefix='axiom-systemd-', dir='/root'))
    loop = None; address_added = False; installed = False; child = None; fixture_directory_modes = {}
    outcomes = {}; identifier = str(uuid.uuid4()); backing = root/'state.img'
    try:
        spire = json.loads((ROOT/'infra/workload/spire-policy.example.json').read_text())
        spire.update(trustDomain='host.axiomproof.test', projectId='axiom-host-test', issuerPrivateIp=IP.split('/')[0])
        policy = {'schemaVersion':1, 'platform':'ubuntu-24.04', 'architecture':'amd64', 'role':'issuer', 'filesystemUuid':identifier, 'spirePolicy':spire, 'bootstrapCaSha256':None}
        archive = ROOT/f'.axiom-runtime/workload-host/spire-{VERSION}-linux-amd64-musl.tar.gz'
        metadata, payload = prepare(policy, archive.read_bytes())
        directory = root/'reviewed'; directory.mkdir(mode=0o700)
        for name, data in {**payload, 'manifest.json':metadata}.items():
            (directory/name).write_bytes(data); (directory/name).chmod(0o600)
        host.host_profile(json.loads(metadata))
        # Only this freshly created regular file can become our format target.
        with backing.open('xb') as stream:
            stream.truncate(256*1024*1024)
        loop = run(['/usr/sbin/losetup', '--find', '--show', '--nooverlap', str(backing)]).stdout.decode().strip()
        if not backing_matches(loop, backing):
            raise ValueError('loop ownership refused')
        run(['/usr/sbin/mkfs.ext4', '-q', '-U', identifier, loop])
        run(['/usr/bin/udevadm', 'trigger', '--action=change', '--sysname-match='+Path(loop).name])
        run(['/usr/bin/udevadm', 'settle'])
        uuid_alias = Path('/dev/disk/by-uuid')/identifier
        if uuid_alias.resolve(strict=True) != Path(loop):
            raise ValueError('udev filesystem binding refused')
        ALIAS.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        host.protected_directory(ALIAS.parent)
        ALIAS.symlink_to(loop)
        # The hosted runner ships these two root-owned directories as 0777.
        # Prepare only this disposable image; production checks stay strict.
        for image_directory in (Path('/usr/local/bin'), Path('/opt')):
            meta = image_directory.lstat()
            if image_directory.resolve(strict=True) != image_directory or meta.st_uid != 0:
                raise ValueError('fixture image directory refused')
            if meta.st_mode & 0o7777 == 0o777:
                fixture_directory_modes[image_directory] = (meta.st_ino, 0o777)
                image_directory.chmod(0o755)
        for destination in destinations:
            for parent in destination.parents:
                if parent.exists():
                    try:
                        host.protected_directory(parent)
                    except ValueError:
                        meta = parent.lstat()
                        print(f'Fixture destination ancestry refused: {parent} uid={meta.st_uid} mode={oct(meta.st_mode & 0o7777)}', flush=True)
                        raise
        host.install(directory, hashlib.sha256(metadata).hexdigest()); installed = True
        assert not STATE.exists() and not active(SERVICE)
        outcomes['delivery-does-not-activate-or-initialize']=True
        run(['/usr/bin/systemd-analyze', 'verify', '--man=no', str(host.layout('issuer')['state.mount'][0]), str(host.layout('issuer')['spire.service'][0])])
        control('daemon-reload'); control('start', MOUNT)
        STATE.chmod(0o700)  # New disposable filesystem only; never product repair.
        guard = ['/usr/bin/python3', '-I', '-B', str(host.PREFIX/'spire_state.py')]
        run([*guard, '--empty', 'issuer'])
        assert control('start', SERVICE, check=False).returncode != 0
        control('stop', SERVICE); control('reset-failed', SERVICE)
        assert not (STATE/'server').exists()
        outcomes['blank-state-refused-before-launch']=True
        run(['/usr/sbin/ip', 'address', 'add', IP, 'dev', 'lo']); address_added = True
        Path('/run/spire-server').mkdir(mode=0o700, exist_ok=True)
        # Explicit fixture initialization is separate from normal installed unit.
        child = subprocess.Popen(['/usr/local/bin/spire-server', 'run', '-config', '/etc/axiom/spire/server.conf'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=ENV)
        host.wait_ready('issuer')
        cli('entry', 'create', '-parentID', 'spiffe://host.axiomproof.test/fixture-node', '-spiffeID', 'spiffe://host.axiomproof.test/fixture-workload', '-selector', 'unix:uid:20003')
        before_bundle = trust()
        before_registry = registry()
        child.terminate(); child.wait(timeout=30); child = None
        # Missing marker remains denied even after a real initialized issuer.
        assert run([*guard, '--ready', 'issuer'], check=False).returncode != 0
        (STATE/'.axiom-state.json').write_bytes(payload['state.json'])
        (STATE/'.axiom-state.json').chmod(0o600)
        run([*guard, '--ready', 'issuer'])
        outcomes['explicit-initialization-and-reviewed-marker-required']=True
        control('start', SERVICE); assert active(SERVICE)
        assert trust() == before_bundle
        assert registry() == before_registry
        outcomes['real-service-namespace-and-state-guard-pass']=True
        # Stop the mounted unit while SPIRE is live: BindsTo must stop its user.
        control('stop', MOUNT)
        assert stopped(SERVICE) and not active(MOUNT)
        assert not (STATE/'server').exists()
        outcomes['mount-loss-stops-live-issuer']=True
        control('start', SERVICE); assert active(SERVICE) and active(MOUNT)
        assert trust() == before_bundle
        assert registry() == before_registry
        outcomes['remount-restart-preserves-trust-and-registry']=True
        # Kernel mount disappearance, without asking systemd to stop SPIRE.
        run(['/usr/bin/umount', '--lazy', str(STATE)])
        deadline = time.monotonic()+30
        while not stopped(SERVICE) and time.monotonic()<deadline:
            time.sleep(0.25)
        assert stopped(SERVICE) and not active(MOUNT)
        control('start', SERVICE)
        assert trust() == before_bundle
        assert registry() == before_registry
        outcomes['external-mount-disappearance-stops-and-recovers']=True
        control('stop', SERVICE)
        keys = STATE/'server/keys.json'; original = keys.read_bytes()
        saved = STATE/'server/keys.fixture-saved'; keys.rename(saved)
        assert control('start', SERVICE, check=False).returncode != 0
        control('stop', SERVICE); control('reset-failed', SERVICE)
        assert not keys.exists() and saved.read_bytes() == original
        outcomes['missing-keys-refused-without-regeneration']=True
        saved.rename(keys); control('start', SERVICE)
        assert trust() == before_bundle
        assert registry() == before_registry
        outcomes['restored-original-state-recovers-original-trust']=True
        control('stop', SERVICE)
        config = Path('/etc/axiom/spire/server.conf'); original_config = config.read_bytes()
        config.write_bytes(original_config+b'\n')
        assert control('start', SERVICE, check=False).returncode != 0
        control('stop', SERVICE); control('reset-failed', SERVICE)
        assert config.read_bytes() == original_config+b'\n'
        outcomes['changed-installed-config-refused-without-repair']=True
        config.write_bytes(original_config); control('start', SERVICE)
        assert active(SERVICE)
        outcomes['reviewed-config-recovery-passes']=True
        revision = run(['git', '-c', 'safe.directory='+str(ROOT), '-C', str(ROOT), 'rev-parse', 'HEAD']).stdout.decode().strip()
        dirty = bool(run(['git', '-c', 'safe.directory='+str(ROOT), '-C', str(ROOT), 'status', '--porcelain']).stdout.strip())
        out = ROOT/'.axiom-runtime/workload-host-systemd'; out.mkdir(mode=0o755, exist_ok=True); out.chmod(0o755)
        report = out/'results.json'
        report.write_text(json.dumps({'revision':revision, 'dirty':dirty, 'passed':True, 'platform':'ubuntu-24.04', 'systemd_major':255, 'spire_version':VERSION, 'outcomes':outcomes}, indent=2)+'\n'); report.chmod(0o644)
        print(f'Native workload host acceptance: {len(outcomes)} outcomes passed.')
    finally:
        if child is not None:
            child.terminate(); child.wait(timeout=30)
        if installed:
            control('stop', SERVICE, check=False); control('stop', MOUNT, check=False)
            for path in destinations:
                path.unlink(missing_ok=True)
            control('daemon-reload'); control('reset-failed', SERVICE, MOUNT, check=False)
        if address_added:
            run(['/usr/sbin/ip', 'address', 'del', IP, 'dev', 'lo'], check=False)
        if ALIAS.is_symlink() and loop and str(ALIAS.resolve()) == loop:
            ALIAS.unlink()
        if loop and backing_matches(loop, backing):
            run(['/usr/sbin/losetup', '--detach', loop])
        for image_directory, (inode, mode) in fixture_directory_modes.items():
            if image_directory.lstat().st_ino != inode:
                raise ValueError('fixture image directory changed')
            image_directory.chmod(mode)
        shutil.rmtree(root)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        frames = [f'{f.name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__) if Path(f.filename).name in ('test-workload-host-systemd.py','spire_host.py','spire_state.py')]
        print('Native workload host acceptance refused at '+' / '.join(frames)+'. Private diagnostics withheld.', file=sys.stderr)
        sys.exit(1)
