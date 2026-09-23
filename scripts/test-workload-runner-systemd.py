#!/usr/bin/env python3
"""Fresh hosted-VM fixture only: native runner/observer with a local test issuer.

Only this fixture substitutes join-token attestation and its exact generated node
ID into a newly hashed test bundle. Production GCP policy has no such switch.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
import uuid
from pathlib import Path
from lib.spire_host_bundle import prepare, selected_binary
from lib.spire_deployment import VERSION, deployment_bundle

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('native_fixture',ROOT/'scripts/test-workload-host-systemd.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
run,control,active,stopped=fixture.run,fixture.control,fixture.active,fixture.stopped
host=fixture.host
STATE=Path('/var/lib/spire');ALIAS=Path('/dev/disk/by-id/google-axiom-runner-state')
SERVICE='axiom-spire-runner.service';INITIAL='axiom-spire-enroll-runner.service';HEALTH='axiom-spire-health.service';MOUNT='var-lib-spire.mount'
IP='10.231.7.2/32'
ALPINE='alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8'


def wait_for(check, timeout=40):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if check():return
        time.sleep(0.5)
    raise ValueError('runner fixture observation timed out')


def health():
    try:return json.loads(Path('/run/spire-health/status.json').read_text())
    except (OSError,ValueError):return {}


def healthy():
    value=health();now=time.time_ns()//1000000
    return value.get('healthy') is True and now-10000<value.get('observedAtMs',0)<=now and now-30000<value.get('syncAtMs',0)<=now


def main():
    if sys.argv[1:]!=['--isolated-ci'] or sys.platform!='linux' or os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/proc/1/comm').read_text().strip()!='systemd':
        raise ValueError('dedicated hosted CI required')
    os.umask(0o077)
    destinations=[x[0] for x in host.layout('runner').values()]+[host.PREFIX/'manifest.json']
    if any(p.exists() or p.is_symlink() for p in destinations+[STATE,ALIAS,Path('/etc/axiom/spire'),Path('/opt/axiom/spire'),Path('/run/spire-admin'),Path('/run/workload'),Path('/run/spire-health')]):
        raise ValueError('existing host resources refused')
    interfaces=json.loads(run(['/usr/sbin/ip','-j','address','show']).stdout)
    if any(a.get('local')==IP.split('/')[0] for i in interfaces for a in i.get('addr_info',[])) or not active('docker.service'):
        raise ValueError('fresh fixture network and Docker required')
    root=Path(tempfile.mkdtemp(prefix='axiom-runner-',dir='/root'))
    prefix='axiom-runner-'+uuid.uuid4().hex[:12];image=prefix+':issuer'
    loop=None;installed=False;address_added=False;modes={};outcomes={};backing=root/'state.img'
    try:
        archive=(ROOT/f'.axiom-runtime/workload-host/spire-{VERSION}-linux-amd64-musl.tar.gz').read_bytes()
        server=selected_binary(archive,'amd64','issuer')[1]
        (root/'spire-server').write_bytes(server);(root/'spire-server').chmod(0o755)
        policy=json.loads((ROOT/'infra/workload/spire-policy.example.json').read_text())
        policy.update(trustDomain='runner.axiomproof.test',projectId='axiom-runner-test',issuerPrivateIp=IP.split('/')[0])
        configuration=deployment_bundle(policy)['server.conf'].replace('NodeAttestor "gcp_iit" { plugin_data { projectid_allow_list = ["axiom-runner-test"] use_instance_metadata = false } }','NodeAttestor "join_token" { plugin_data {} }')
        (root/'server.conf').write_text(configuration)
        (root/'Dockerfile').write_text(f'FROM {ALPINE}\nCOPY spire-server /usr/local/bin/spire-server\nCOPY server.conf /etc/spire/server.conf\nENTRYPOINT ["/bin/sh","-c","umask 077; exec /usr/local/bin/spire-server run -config /etc/spire/server.conf"]\n')
        run(['docker','build','-t',image,str(root)],timeout=300)
        run(['/usr/sbin/ip','address','add',IP,'dev','lo']);address_added=True
        run(['docker','run','-d','--name',prefix,'--network','host','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none','--tmpfs','/var/lib/spire:rw,nosuid,nodev,noexec,mode=700','--tmpfs','/run/spire-server:rw,nosuid,nodev,mode=700',image])
        cli=lambda *args:run(['docker','exec',prefix,'spire-server',*args,'-socketPath','/run/spire-server/api.sock'])
        wait_for(lambda:run(['docker','exec',prefix,'spire-server','healthcheck','-socketPath','/run/spire-server/api.sock'],check=False).returncode==0)
        ca=cli('bundle','show','-format','pem').stdout
        token=json.loads(cli('token','generate','-output','json').stdout)['value']
        expected=f"spiffe://{policy['trustDomain']}/spire/agent/join_token/{token}"
        identifier=str(uuid.uuid4())
        metadata,payload=prepare({'schemaVersion':1,'platform':'ubuntu-24.04','architecture':'amd64','role':'runner','filesystemUuid':identifier,'spirePolicy':policy,'bootstrapCaSha256':hashlib.sha256(ca).hexdigest()},archive,ca)
        outcomes['production-gcp-bundle-prepared-before-test-substitution']=True
        original_node=json.loads(payload['state.json'])['nodeId']
        payload['state.json']=payload['state.json'].replace(original_node.encode(),expected.encode())
        payload['health.service']=payload['health.service'].replace(original_node.encode(),expected.encode())
        payload['spire.conf']=payload['spire.conf'].replace(b'NodeAttestor "gcp_iit"',b'NodeAttestor "join_token"')
        # Narrow fixture-only node predicate. All mount/file/state guards remain.
        source=payload['spire_state.py'].decode();start=source.index("    elif not isinstance(value['nodeId']");end=source.index("    return value",start)
        source=source[:start]+f"    elif value['nodeId'] != {expected!r}:\n        raise ValueError('fixture node binding refused')\n"+source[end:]
        payload['spire_state.py']=source.encode()
        payload['enroll.service']=payload['enroll.service'].replace(b'run -config /etc/axiom/spire/agent.conf\n',b'run -config /etc/axiom/spire/agent.conf -joinTokenFile /etc/axiom/spire/fixture-token\n')
        manifest=json.loads(metadata);manifest['files']={name:hashlib.sha256(data).hexdigest() for name,data in payload.items()};metadata=(json.dumps(manifest,sort_keys=True,indent=2)+'\n').encode()
        reviewed=root/'reviewed';reviewed.mkdir(mode=0o700)
        for name,data in {**payload,'manifest.json':metadata}.items():(reviewed/name).write_bytes(data);(reviewed/name).chmod(0o600)
        with backing.open('xb') as stream:stream.truncate(256*1024*1024)
        loop=run(['/usr/sbin/losetup','--find','--show','--nooverlap',str(backing)]).stdout.decode().strip()
        if not fixture.backing_matches(loop,backing):raise ValueError('loop ownership refused')
        run(['/usr/sbin/mkfs.ext4','-q','-U',identifier,loop]);run(['/usr/bin/udevadm','trigger','--action=change','--sysname-match='+Path(loop).name]);run(['/usr/bin/udevadm','settle'])
        if (Path('/dev/disk/by-uuid')/identifier).resolve(strict=True)!=Path(loop):raise ValueError('UUID binding refused')
        ALIAS.parent.mkdir(parents=True,exist_ok=True);host.protected_directory(ALIAS.parent);ALIAS.symlink_to(loop)
        for path in (Path('/usr/local/bin'),Path('/opt')):
            meta=path.lstat()
            if path.resolve(strict=True)!=path or meta.st_uid!=0:raise ValueError('fixture ancestry refused')
            if meta.st_mode&0o7777==0o777:modes[path]=(meta.st_ino,0o777);path.chmod(0o755)
        host.install(reviewed,hashlib.sha256(metadata).hexdigest());installed=True
        token_path=Path('/etc/axiom/spire/fixture-token');token_path.write_text(token);token_path.chmod(0o600)
        control('daemon-reload');control('start',MOUNT);STATE.chmod(0o700)
        assert control('start',SERVICE,check=False).returncode!=0
        control('stop',SERVICE);control('reset-failed',SERVICE)
        assert not (STATE/'agent').exists()
        outcomes['blank-runner-state-refused-before-launch']=True
        assert control('start',INITIAL,check=False).returncode!=0
        control('stop',INITIAL);control('reset-failed',INITIAL)
        outcomes['direct-runner-enrollment-without-permit-refused']=True
        enrollment=['/usr/bin/python3','-I','-B',str(host.PREFIX/'spire_enrollment.py')]
        run([*enrollment,'--initialize','runner',hashlib.sha256(metadata).hexdigest()],timeout=90)
        token_path.unlink()
        receipt_path=Path('/etc/axiom/spire/initialization-receipt.json');receipt_raw=receipt_path.read_bytes();receipt=json.loads(receipt_raw);receipt_sha=hashlib.sha256(receipt_raw).hexdigest()
        assert receipt['trust']['nodeId']==expected and receipt['trust']['healthy'] is True
        assert stopped(SERVICE) and stopped(INITIAL) and stopped(HEALTH) and not (STATE/'.axiom-state.json').exists()
        outcomes['exact-node-initialization-stops-unmarked-without-observer']=True
        run([*enrollment,'--seal','runner',receipt_sha],timeout=90)
        assert stopped(SERVICE) and stopped(HEALTH)
        assert run([*enrollment,'--initialize','runner',hashlib.sha256(metadata).hexdigest()],check=False).returncode!=0
        outcomes['reviewed-node-marker-without-activation-or-reenrollment']=True
        control('start',SERVICE);wait_for(healthy)
        inode=Path('/run/workload').stat().st_ino
        assert active(SERVICE) and active(HEALTH) and health()['nodeId']==expected
        outcomes['native-runner-and-observer-start-with-exact-node']=True
        before_restart=health()['observedAtMs']
        control('restart',SERVICE);wait_for(lambda:healthy() and health()['observedAtMs']>before_restart)
        assert Path('/run/workload').stat().st_ino==inode and health()['nodeId']==expected
        outcomes['normal-restart-preserves-socket-directory-and-node']=True
        prior_pid=control('show','--property=MainPID','--value',HEALTH).stdout.strip()
        prior_observation=health()['observedAtMs']
        control('kill','--signal=KILL',HEALTH)
        wait_for(lambda:active(HEALTH) and healthy() and health()['observedAtMs']>prior_observation and control('show','--property=MainPID','--value',HEALTH).stdout.strip() not in (b'0',prior_pid))
        outcomes['observer-crash-recovers-under-supervision']=True
        control('stop',HEALTH);observed=health()['observedAtMs']
        wait_for(lambda:time.time_ns()//1000000>=observed+10000)
        assert not healthy() and active(SERVICE)
        outcomes['stopped-observer-metadata-expires-with-live-node']=True
        assert control('start',HEALTH,check=False).returncode!=0
        assert control('show','--property=Result','--value',HEALTH).stdout.strip()==b'start-limit-hit'
        outcomes['observer-restart-storm-is-rate-limited']=True
        # Deliberate fault scenarios exhausted the production start budget.
        # Reset only this disposable fixture before the independent outage test.
        control('reset-failed',HEALTH);control('start',HEALTH);wait_for(healthy)
        run(['docker','pause',prefix]);wait_for(lambda:health().get('healthy') is False,timeout=45)
        assert active(SERVICE)
        outcomes['issuer-outage-invalidates-health-despite-live-node']=True
        run(['docker','unpause',prefix]);wait_for(healthy)
        outcomes['issuer-recovery-restores-fresh-observation']=True
        control('stop',MOUNT);wait_for(lambda:stopped(SERVICE) and stopped(HEALTH))
        assert not (STATE/'agent').exists()
        outcomes['mount-loss-stops-runner-and-observer']=True
        control('start',SERVICE);wait_for(healthy)
        assert Path('/run/workload').stat().st_ino==inode
        outcomes['remount-recovers-original-node-and-directory']=True
        control('stop',SERVICE);control('reset-failed',SERVICE)
        keys=STATE/'agent/keys.json';saved=STATE/'agent/keys.fixture';original=keys.read_bytes();keys.rename(saved)
        assert control('start',SERVICE,check=False).returncode!=0
        control('stop',SERVICE);control('reset-failed',SERVICE)
        assert not keys.exists() and saved.read_bytes()==original
        outcomes['missing-node-key-refused-without-regeneration']=True
        saved.rename(keys);control('start',SERVICE);wait_for(healthy)
        control('stop','docker.socket');control('stop','docker.service')
        wait_for(lambda:stopped(SERVICE) and stopped(HEALTH))
        outcomes['docker-loss-stops-node-and-observer']=True
        control('start','docker.service');control('start','docker.socket')
        # Stopping the daemon discards the throwaway issuer tmpfs state. This
        # fixture ends here rather than pretending new issuer trust is recovery.
        revision=run(['git','-c','safe.directory='+str(ROOT),'-C',str(ROOT),'rev-parse','HEAD']).stdout.decode().strip()
        dirty=bool(run(['git','-c','safe.directory='+str(ROOT),'-C',str(ROOT),'status','--porcelain']).stdout.strip())
        out=ROOT/'.axiom-runtime/workload-runner-systemd';out.mkdir(mode=0o755,exist_ok=True);out.chmod(0o755)
        report=out/'results.json';report.write_text(json.dumps({'revision':revision,'dirty':dirty,'passed':True,'platform':'ubuntu-24.04','systemd_major':255,'spire_version':VERSION,'attestation':'local-join-token-not-gcp','outcomes':outcomes},indent=2)+'\n');report.chmod(0o644)
        print(f'Native runner acceptance: {len(outcomes)} outcomes passed.')
    finally:
        control('start','docker.service',check=False);control('start','docker.socket',check=False)
        run(['docker','unpause',prefix],check=False);run(['docker','rm','-f',prefix],check=False);run(['docker','image','rm',image],check=False)
        if installed:
            control('stop',INITIAL,HEALTH,SERVICE,check=False);control('stop',MOUNT,check=False)
            for path in destinations:path.unlink(missing_ok=True)
            control('daemon-reload')
        if address_added:run(['/usr/sbin/ip','address','del',IP,'dev','lo'],check=False)
        if ALIAS.is_symlink() and loop and str(ALIAS.resolve())==loop:ALIAS.unlink()
        if loop and fixture.backing_matches(loop,backing):run(['/usr/sbin/losetup','--detach',loop])
        for path,(inode,mode) in modes.items():
            if path.lstat().st_ino!=inode:raise ValueError('fixture ancestry changed')
            path.chmod(mode)
        shutil.rmtree(root)


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=[f'{f.name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__) if Path(f.filename).name in ('test-workload-runner-systemd.py','test-workload-host-systemd.py','spire_host.py')]
        print('Native runner acceptance refused at '+' / '.join(frames)+'. Private diagnostics withheld.',file=sys.stderr);sys.exit(1)
