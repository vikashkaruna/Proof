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
from lib.controller_runtime_acceptance import accept as controller_runtime_acceptance

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('native_fixture',ROOT/'scripts/test-workload-host-systemd.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
run,control,active,stopped=fixture.run,fixture.control,fixture.active,fixture.stopped
host=fixture.host
STATE=Path('/var/lib/spire');ALIAS=Path('/dev/disk/by-id/google-axiom-runner-state')
SERVICE='axiom-spire-runner.service';INITIAL='axiom-spire-enroll-runner.service';HEALTH='axiom-spire-health.service';MOUNT='var-lib-spire.mount'
IP='10.231.7.2/32'
ALPINE='alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8'


def check(condition, message):
    # Explicit refusal: survives `python -O`, unlike `assert`.
    if not condition:
        raise ValueError('runner fixture acceptance refused: '+message)


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
    if any(p.exists() or p.is_symlink() for p in destinations+[STATE,ALIAS,Path('/etc/axiom/spire'),Path('/opt/axiom/spire'),Path('/run/spire-admin'),Path('/run/workload'),Path('/run/spire-health'),Path('/etc/axiom/controllers')]):
        raise ValueError('existing host resources refused')
    interfaces=json.loads(run(['/usr/sbin/ip','-j','address','show']).stdout)
    if any(a.get('local')==IP.split('/')[0] for i in interfaces for a in i.get('addr_info',[])) or not active('docker.service'):
        raise ValueError('fresh fixture network and Docker required')
    root=Path(tempfile.mkdtemp(prefix='axiom-runner-',dir='/root'))
    prefix='axiom-runner-'+uuid.uuid4().hex[:12];image=prefix+':issuer'
    loop=None;installed=False;address_added=False;modes={};outcomes={};backing=root/'state.img';consumer=prefix+'-consumer';wrong_image=prefix+':foreign';volume_names=[];controller_base=None
    try:
        archive=(ROOT/f'.axiom-runtime/workload-host/spire-{VERSION}-linux-amd64-musl.tar.gz').read_bytes()
        server=selected_binary(archive,'amd64','issuer')[1]
        (root/'spire-server').write_bytes(server);(root/'spire-server').chmod(0o755)
        (root/'spire-agent').write_bytes(selected_binary(archive,'amd64','runner')[1]);(root/'spire-agent').chmod(0o755)
        policy=json.loads((ROOT/'infra/workload/spire-policy.example.json').read_text())
        policy.update(trustDomain='runner.axiomproof.test',projectId='axiom-runner-test',issuerPrivateIp=IP.split('/')[0])
        configuration=deployment_bundle(policy)['server.conf'].replace('NodeAttestor "gcp_iit" { plugin_data { projectid_allow_list = ["axiom-runner-test"] use_instance_metadata = false } }','NodeAttestor "join_token" { plugin_data {} }')
        (root/'server.conf').write_text(configuration)
        (root/'Dockerfile').write_text(f'FROM {ALPINE}\nCOPY spire-server /usr/local/bin/spire-server\nCOPY spire-agent /usr/local/bin/spire-agent\nCOPY server.conf /etc/spire/server.conf\nENTRYPOINT ["/bin/sh","-c","umask 077; exec /usr/local/bin/spire-server run -config /etc/spire/server.conf"]\n')
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
        check(control('start',SERVICE,check=False).returncode!=0,'runner start accepted on blank state')
        control('stop',SERVICE);control('reset-failed',SERVICE)
        check(not (STATE/'agent').exists(),'agent state created on blank state')
        outcomes['blank-runner-state-refused-before-launch']=True
        check(control('start',INITIAL,check=False).returncode!=0,'initial enrollment started without permit')
        control('stop',INITIAL);control('reset-failed',INITIAL)
        outcomes['direct-runner-enrollment-without-permit-refused']=True
        enrollment=['/usr/bin/python3','-I','-B',str(host.PREFIX/'spire_enrollment.py')]
        run([*enrollment,'--initialize','runner',hashlib.sha256(metadata).hexdigest()],timeout=90)
        token_path.unlink()
        receipt_path=Path('/etc/axiom/spire/initialization-receipt.json');receipt_raw=receipt_path.read_bytes();receipt=json.loads(receipt_raw);receipt_sha=hashlib.sha256(receipt_raw).hexdigest()
        check(receipt['trust']['nodeId']==expected and receipt['trust']['healthy'] is True,'receipt node binding or health mismatch')
        check(stopped(SERVICE) and stopped(INITIAL) and stopped(HEALTH) and not (STATE/'.axiom-state.json').exists(),'initialization left units running or published a marker')
        outcomes['exact-node-initialization-stops-unmarked-without-observer']=True
        run([*enrollment,'--seal','runner',receipt_sha],timeout=90)
        check(stopped(SERVICE) and stopped(HEALTH),'seal left units running')
        check(run([*enrollment,'--initialize','runner',hashlib.sha256(metadata).hexdigest()],check=False).returncode!=0,'reviewed node reinitialized')
        outcomes['reviewed-node-marker-without-activation-or-reenrollment']=True
        control('start',SERVICE);wait_for(healthy)
        inode=Path('/run/workload').stat().st_ino
        check(active(SERVICE) and active(HEALTH) and health()['nodeId']==expected,'runner or observer not healthy with exact node')
        outcomes['native-runner-and-observer-start-with-exact-node']=True
        volume_cli=['/usr/bin/python3','-I','-B',str(host.PREFIX/'spire_volumes.py')]
        manifest_sha=hashlib.sha256(metadata).hexdigest()
        api_volume='axiom-workload-api-'+identifier;health_volume='axiom-spire-health-'+identifier
        volume_names=[api_volume,health_volume]
        run(['docker','volume','create',health_volume])  # Deliberately foreign fixture mapping.
        check(run([*volume_cli,'--prepare',manifest_sha],check=False).returncode!=0,'foreign volume accepted')
        check(not Path('/etc/axiom/spire/runtime-volumes.json').exists(),'foreign volume wrote a mapping record')
        check(run(['docker','volume','inspect',api_volume],check=False).returncode!=0,'workload API volume created before review')
        run(['docker','volume','rm',health_volume])  # Only this fixture's own unused volume.
        outcomes['foreign-volume-refused-before-record-or-peer-creation']=True
        result=json.loads(run([*volume_cli,'--prepare',manifest_sha]).stdout)
        check(result=={'workloadApiVolume':api_volume,'healthVolume':health_volume},'volume mapping diverges from reviewed inventory')
        before_volume=run(['docker','volume','inspect',api_volume,health_volume]).stdout
        run([*volume_cli,'--prepare',manifest_sha]);run([*volume_cli,'--check',manifest_sha])
        check(run(['docker','volume','inspect',api_volume,health_volume]).stdout==before_volume,'volume mapping replaced on retry')
        outcomes['reviewed-volume-mapping-is-idempotent-without-replacement']=True
        run(['docker','run','-d','--name',consumer,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none','--user','20000:20000','--mount',f'type=volume,src={api_volume},dst=/run/workload,readonly,volume-nocopy','--mount',f'type=volume,src={health_volume},dst=/run/spire-health,readonly,volume-nocopy','--entrypoint','/bin/sleep',image,'600'])
        run([*volume_cli,'--check',manifest_sha])
        check(run(['docker','exec',consumer,'stat','-c','%d:%i','/run/workload']).stdout.strip()==f"{Path('/run/workload').stat().st_dev}:{inode}".encode(),'consumer lost the original workload directory')
        check(run(['docker','exec',consumer,'touch','/run/workload/forbidden'],check=False).returncode!=0,'consumer wrote to read-only workload mount')
        check(run(['docker','exec',consumer,'test','-e','/run/docker.sock'],check=False).returncode!=0,'docker socket exposed to consumer')
        check(run(['docker','exec',consumer,'test','-e','/run/spire-admin/api.sock'],check=False).returncode!=0,'admin socket exposed to consumer')
        outcomes['consumer-has-original-read-only-directory-without-admin-or-docker']=True
        image_id=run(['docker','image','inspect','--format','{{.Id}}',image]).stdout.decode().strip()
        workload=f"spiffe://{policy['trustDomain']}/controller/assessment"
        cli('entry','create','-parentID',expected,'-spiffeID',workload,'-selector','unix:uid:20000','-selector','docker:image_config_digest:'+image_id,'-jwtSVIDTTL','300')
        fetch=['/usr/local/bin/spire-agent','api','fetch','jwt','-socketPath','/run/workload/api.sock','-audience','axiom-native-volume-fixture','-spiffeID',workload,'-output','json']
        def admitted():
            result=run(['docker','exec',consumer,*fetch],check=False,timeout=10)
            if result.returncode!=0:return False
            response=json.loads(result.stdout)
            if not isinstance(response,list):raise ValueError('identity response refused')
            groups=[part['svids'] for part in response if isinstance(part,dict) and 'svids' in part]
            if len(groups)!=1 or not isinstance(groups[0],list) or len(groups[0])!=1 or groups[0][0].get('spiffe_id')!=workload:
                raise ValueError('unexpected admitted identity')
            return True
        wait_for(admitted)
        outcomes['native-node-admits-exact-container-image-and-uid']=True
        check(run(['docker','exec','--user','20003:20003',consumer,*fetch],check=False,timeout=10).returncode!=0,'wrong consumer uid admitted')
        outcomes['native-node-refuses-wrong-consumer-uid']=True
        foreign_context=root/'foreign-image';foreign_context.mkdir(mode=0o700)
        (foreign_context/'Dockerfile').write_text(f'FROM {image}\nLABEL axiom.fixture.variant="foreign"\n')
        run(['docker','build','-t',wrong_image,str(foreign_context)],timeout=120)
        check(run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none','--user','20000:20000','--mount',f'type=volume,src={api_volume},dst=/run/workload,readonly,volume-nocopy','--entrypoint',fetch[0],wrong_image,*fetch[1:]],check=False,timeout=15).returncode!=0,'wrong consumer image admitted')
        outcomes['native-node-refuses-wrong-consumer-image']=True
        # Protected controller files are delivered separately from activation.
        helper=root/'controller_files.py';helper.write_bytes((ROOT/'infra/workload/controller_files.py').read_bytes());helper.chmod(0o600)
        tenant=str(uuid.uuid4());controller_base=Path('/etc/axiom/controllers')/tenant
        private=root/'controller-source';private.mkdir(mode=0o700)
        service_config={'controller':{'schemaVersion':1,'tenantId':tenant,'trustDomain':policy['trustDomain'],'workloadSocket':'/run/workload/api.sock','issuerNodeId':expected,'namespace':'native-file-fixture','launcher':{'executable':'/usr/bin/docker','dockerHost':'unix:///run/docker.sock','image':image_id,'workloadApiVolume':api_volume},'keys':{'provider':'aws','primary':'fixture-not-runtime-ready','retiring':[]},'scheduler':{'audience':'https://controller.fixture.test:8443','subject':'123','email':'fixture@example.test'}},'listen':{'host':'0.0.0.0','port':8443},'tls':{'keyFile':'/run/controller-secrets/tls.key','certFile':'/run/controller-secrets/tls.crt'},'backendServiceKeyFile':'/run/controller-secrets/backend.key'}  # nosec B104 - reviewed listen-contract value for the isolated fixture controller, not a bind call
        def controller_bundle(config):
            data={'service.json':json.dumps(config).encode(),'backend.key':b'synthetic-native-private-not-real-00000000','tls.key':b'synthetic-native-tls-not-real','tls.crt':b'synthetic-native-certificate-not-real'}
            review={'schemaVersion':1,'tenantId':tenant,'spireManifestSha256':manifest_sha,'controllerImage':image_id,'files':{k:hashlib.sha256(v).hexdigest() for k,v in data.items()}}
            raw=(json.dumps(review,sort_keys=True,separators=(',', ':'))+'\n').encode()
            for key,value in {'manifest.json':raw,**data}.items():(private/key).write_bytes(value);(private/key).chmod(0o600)
            return hashlib.sha256(raw).hexdigest()
        file_sha=controller_bundle(service_config)
        source_files=root/'controller-input';source_files.mkdir(mode=0o700)
        for filename in ('service.json','backend.key','tls.key','tls.crt'):
            (source_files/filename).write_bytes((private/filename).read_bytes());(source_files/filename).chmod(0o600)
        review_input=json.loads((private/'manifest.json').read_text());review_input.pop('files')
        review_file=root/'controller-review.json';review_file.write_text(json.dumps(review_input));review_file.chmod(0o600)
        prepared=root/'controller-prepared'
        preparer=['/usr/bin/python3','-I','-B',str(ROOT/'scripts/prepare-controller-files.py'),str(review_file),str(source_files),str(prepared)]
        result=run(preparer)
        check(result.stdout==('Controller review bundle prepared: '+file_sha+'; no host or service changed.\n').encode(),'preparer output diverges from reviewed bundle')
        check((prepared/'manifest.json').read_bytes()==(private/'manifest.json').read_bytes(),'preparer rewrote the reviewed manifest')
        check(run(preparer,check=False).returncode!=0,'preparer retried over an existing bundle')
        check(not controller_base.exists(),'preparer installed to the host')
        outcomes['controller-review-preparer-is-fresh-only-and-does-not-install']=True
        delivery=['/usr/bin/python3','-I','-B',str(helper)]
        run([*delivery,'--install',str(private),file_sha]);run([*delivery,'--check',tenant,file_sha])
        delivered=controller_base/file_sha/'files'
        check(all(p.stat().st_uid==20000 and p.stat().st_gid==20000 and p.stat().st_mode&511==0o400 for p in delivered.iterdir()),'delivered files ownership or mode changed')
        check(all(p.stat().st_uid==0 and p.stat().st_mode&511==0o700 for p in (controller_base.parent,controller_base,controller_base/file_sha)),'delivery ancestry protection refused')
        outcomes['controller-private-files-bind-reviewed-node-and-manifest']=True
        before_files={p.name:p.stat().st_ino for p in delivered.iterdir()}
        run([*delivery,'--install',str(private),file_sha])
        check(before_files=={p.name:p.stat().st_ino for p in delivered.iterdir()},'identical retry replaced delivered files')
        outcomes['controller-file-identical-retry-preserves-inodes']=True
        def file_consumer(uid,command):
            return run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none','--user',str(uid)+':'+str(uid),'--mount',f'type=bind,src={delivered},dst=/run/controller-secrets,readonly','--entrypoint','/bin/sh',image,'-c',command],check=False,timeout=15)
        check(file_consumer(20000,'cat /run/controller-secrets/backend.key').stdout==b'synthetic-native-private-not-real-00000000','consumer cannot read its own delivered key')
        check(file_consumer(20000,'chmod 600 /run/controller-secrets/backend.key').returncode!=0,'consumer modified a delivered file')
        check(file_consumer(20000,'test ! -e /run/docker.sock && test ! -e /run/spire-admin/api.sock').returncode==0,'file consumer sees admin or docker socket')
        outcomes['controller-file-consumer-has-read-only-files-without-daemon']=True
        check(file_consumer(20003,'cat /run/controller-secrets/backend.key').returncode!=0,'worker uid read controller credentials')
        outcomes['controller-private-files-refuse-worker-uid']=True
        outcomes.update(controller_runtime_acceptance(root,prefix,ALPINE,tenant,service_config,manifest_sha,api_volume,health_volume,consumer,run,control,active,wait_for))
        saved=(delivered/'backend.key').read_bytes();(delivered/'backend.key').write_bytes(b'changed-by-test-root')
        check(run([*delivery,'--check',tenant,file_sha],check=False).returncode!=0,'tampered delivery accepted by check')
        check(run([*delivery,'--install',str(private),file_sha],check=False).returncode!=0,'tampered delivery repaired in place')
        check((delivered/'backend.key').read_bytes()==b'changed-by-test-root','tampering silently repaired')
        (delivered/'backend.key').write_bytes(saved)
        outcomes['controller-file-tampering-refused-without-repair']=True
        service_config['controller']['issuerNodeId']=expected+'-foreign';foreign_sha=controller_bundle(service_config)
        check(run([*delivery,'--install',str(private),foreign_sha],check=False).returncode!=0,'foreign node file delivery accepted')
        check(not (controller_base/foreign_sha).exists(),'foreign node delivery created a generation')
        outcomes['controller-foreign-node-file-delivery-refused-before-writes']=True
        service_config['controller']['issuerNodeId']=expected;service_config['controller']['namespace']='incomplete-fixture';partial_sha=controller_bundle(service_config)
        partial=controller_base/partial_sha;partial.mkdir(mode=0o700);(partial/'manifest.json').write_bytes((private/'manifest.json').read_bytes());(partial/'manifest.json').chmod(0o600)
        partial_inode=(partial/'manifest.json').stat().st_ino
        check(run([*delivery,'--install',str(private),partial_sha],check=False).returncode!=0,'partial generation accepted')
        check((partial/'manifest.json').stat().st_ino==partial_inode and {p.name for p in partial.iterdir()}=={'manifest.json'},'partial generation repaired or extended')
        outcomes['controller-partial-generation-preserved-for-review']=True
        run([*delivery,'--check',tenant,file_sha])
        outcomes['controller-delivery-does-not-require-or-claim-runtime-activation']=True
        before_restart=health()['observedAtMs']
        control('restart',SERVICE);wait_for(lambda:healthy() and health()['observedAtMs']>before_restart)
        check(Path('/run/workload').stat().st_ino==inode and health()['nodeId']==expected,'restart lost the socket directory or node binding')
        outcomes['normal-restart-preserves-socket-directory-and-node']=True
        run([*volume_cli,'--check',manifest_sha])
        wait_for(admitted)
        check(run(['docker','exec',consumer,'stat','-c','%i','/run/workload/api.sock']).stdout.strip()==str(Path('/run/workload/api.sock').stat().st_ino).encode(),'consumer lost the replaced workload socket')
        outcomes['consumer-reconnects-through-replaced-socket-in-same-directory']=True
        prior_pid=control('show','--property=MainPID','--value',HEALTH).stdout.strip()
        prior_observation=health()['observedAtMs']
        control('kill','--signal=KILL',HEALTH)
        wait_for(lambda:active(HEALTH) and healthy() and health()['observedAtMs']>prior_observation and control('show','--property=MainPID','--value',HEALTH).stdout.strip() not in (b'0',prior_pid))
        outcomes['observer-crash-recovers-under-supervision']=True
        observed=json.loads(run(['docker','exec',consumer,'cat','/run/spire-health/status.json']).stdout)
        check(observed['nodeId']==expected and observed['observedAtMs']>prior_observation,'consumer observed stale health publication')
        outcomes['consumer-observes-atomic-health-replacement']=True
        control('stop',HEALTH);observed=health()['observedAtMs']
        wait_for(lambda:time.time_ns()//1000000>=observed+10000)
        check(not healthy() and active(SERVICE),'stopped observer metadata stayed healthy')
        outcomes['stopped-observer-metadata-expires-with-live-node']=True
        # Isolate the rate-limit case from time spent in container admission.
        control('reset-failed',HEALTH)
        for _ in range(3):
            control('start',HEALTH);control('stop',HEALTH)
        check(control('start',HEALTH,check=False).returncode!=0,'restart storm not rate limited')
        check(control('show','--property=Result','--value',HEALTH).stdout.strip()==b'start-limit-hit','start limit not recorded')
        outcomes['observer-restart-storm-is-rate-limited']=True
        # Deliberate fault scenarios exhausted the production start budget.
        # Reset only this disposable fixture before the independent outage test.
        control('reset-failed',HEALTH);control('start',HEALTH);wait_for(healthy)
        run(['docker','pause',prefix]);wait_for(lambda:health().get('healthy') is False,timeout=45)
        check(active(SERVICE),'issuer outage stopped the live node')
        outcomes['issuer-outage-invalidates-health-despite-live-node']=True
        run(['docker','unpause',prefix]);wait_for(healthy)
        outcomes['issuer-recovery-restores-fresh-observation']=True
        control('stop',MOUNT);wait_for(lambda:stopped(SERVICE) and stopped(HEALTH))
        check(not (STATE/'agent').exists(),'mount loss left agent state')
        outcomes['mount-loss-stops-runner-and-observer']=True
        control('start',SERVICE);wait_for(healthy)
        check(Path('/run/workload').stat().st_ino==inode,'remount lost the original socket directory')
        outcomes['remount-recovers-original-node-and-directory']=True
        control('stop',SERVICE);control('reset-failed',SERVICE)
        keys=STATE/'agent/keys.json';saved=STATE/'agent/keys.fixture';original=keys.read_bytes();keys.rename(saved)
        check(control('start',SERVICE,check=False).returncode!=0,'missing node key start accepted')
        control('stop',SERVICE);control('reset-failed',SERVICE)
        check(not keys.exists() and saved.read_bytes()==original,'node key regenerated or altered')
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
        run(['docker','unpause',prefix],check=False);run(['docker','rm','-f',consumer,prefix],check=False)
        for name in volume_names:run(['docker','volume','rm',name],check=False)
        run(['docker','image','rm',wrong_image,image],check=False)
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
        if controller_base is not None and controller_base.parent==Path('/etc/axiom/controllers'):
            shutil.rmtree(controller_base,ignore_errors=True)
        shutil.rmtree(root)


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=[f'{f.name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__) if Path(f.filename).name in ('test-workload-runner-systemd.py','test-workload-host-systemd.py','controller_runtime_acceptance.py','controller_transition_acceptance.py','spire_host.py')]
        print('Native runner acceptance refused at '+' / '.join(frames)+'. Private diagnostics withheld.',file=sys.stderr);sys.exit(1)
