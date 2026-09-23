#!/usr/bin/env python3
"""Root delivery in disposable, capability-less Ubuntu containers. No host mounts."""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import traceback
import urllib.request
import uuid
from pathlib import Path

from lib.spire_deployment import VERSION
from lib.spire_host_bundle import prepare

ROOT=Path(__file__).resolve().parents[1]
UBUNTU='ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3'
OUT=ROOT/'.axiom-runtime/workload-host'
VERIFY='''import hashlib,json,os,subprocess,sys
from pathlib import Path
sys.path.insert(0,'/fixture')
import spire_host as host
os.umask(0o077)
role=sys.argv[1];source=Path('/bundles')/role
raw=(source/'manifest.json').read_bytes();digest=hashlib.sha256(raw).hexdigest()
outcomes={}
assert os.geteuid()==0
host.install(source,digest)
metadata=host.installed(role)
outcomes['protected-delivery-and-installed-integrity']=True
paths=[item[0] for item in host.layout(role).values()]+[host.PREFIX/'manifest.json']
before={str(p):p.stat().st_ino for p in paths}
host.install(source,digest)
assert {str(p):p.stat().st_ino for p in paths}==before
outcomes['identical-retry-does-not-replace-files']=True
assert not Path('/var/lib/spire').exists()
assert not list(Path('/etc/systemd/system').glob('*.wants/*'))
outcomes['no-state-initialization-or-service-enable']=True
unit=host.layout(role)['spire.service'][0]
units=[str(host.layout(role)['state.mount'][0]),str(unit)]
if role=='runner':units.append(str(host.layout(role)['health.service'][0]))
else:units.append(str(host.layout(role)['enroll.service'][0]))
checked=subprocess.run(['systemd-analyze','verify','--man=no',*units],capture_output=True)
if checked.returncode:
 # Unit diagnostics contain only generated fixture paths; record a fixed
 # failure here so CI never forwards arbitrary subprocess diagnostics.
 sys.stderr.buffer.write(checked.stderr)
 raise ValueError('unit verification refused')
outcomes['systemd-255-verifies-generated-units']=True
result=subprocess.run(['systemctl','is-enabled',unit.name],capture_output=True)
assert result.returncode!=0 and b'enabled' not in result.stdout
outcomes['services-remain-disabled']=True
try:host.bundle(source,'0'*64)
except ValueError:pass
else:raise ValueError('unreviewed manifest admitted')
outcomes['unreviewed-manifest-refused']=True
config=Path('/etc/axiom/spire/state.json');original=config.read_bytes()
config.write_bytes(original+b' ')
for operation in (lambda:host.installed(role),lambda:host.install(source,digest)):
 try:operation()
 except ValueError:pass
 else:raise ValueError('altered configuration admitted')
assert config.read_bytes()==original+b' '
config.write_bytes(original)
outcomes['tampering-refused-without-repair']=True
binary='spire-server' if role=='issuer' else 'spire-agent'
version=subprocess.run(['/usr/local/bin/'+binary,'--version'],capture_output=True)
if version.returncode!=0 or (version.stdout+version.stderr).strip()!=b'1.15.3':
 sys.stderr.buffer.write(version.stdout+version.stderr)
 raise ValueError('pinned binary version refused')
if role=='runner':
 host.runtime('runner')
 assert all(Path(p).stat().st_mode & 511==493 for p in ('/run/workload','/run/spire-health'))
 before=Path('/run/workload').stat().st_ino
 host.runtime('runner');assert Path('/run/workload').stat().st_ino==before
 Path('/run/workload').chmod(448)
 try:host.runtime('runner')
 except ValueError:pass
 else:raise ValueError('unsafe runtime repaired')
 assert Path('/run/workload').stat().st_mode & 511==448
outcomes['pinned-binary-and-runtime-contract']=True
print(json.dumps(outcomes))
'''


def run(args,**kwargs):
    result=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,timeout=kwargs.pop('timeout',300),**kwargs)
    if result.returncode:
        diagnostic=OUT/'private-diagnostic.txt'
        diagnostic.write_text(result.stderr[-16384:]);diagnostic.chmod(0o600)
        raise RuntimeError('host acceptance operation refused')
    return result.stdout


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    arch={'arm64':'arm64','aarch64':'arm64','x86_64':'amd64'}[platform.machine()]
    archive=OUT/f'spire-{VERSION}-linux-{arch}-musl.tar.gz'
    if not archive.exists():
        urllib.request.urlretrieve(f'https://github.com/spiffe/spire/releases/download/v{VERSION}/{archive.name}',archive)
    raw_archive=archive.read_bytes()
    root=Path(tempfile.mkdtemp(prefix='axiom-host-review-'));image='axiom-workload-host:'+uuid.uuid4().hex[:12]
    containers=[]
    try:
        # Public CA fixture only; its throwaway signing key never enters the image.
        run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'ca.key'),'-out',str(root/'ca.pem'),'-days','1','-subj','/CN=workload-host-fixture'])
        ca=(root/'ca.pem').read_bytes();(root/'ca.key').unlink();(root/'ca.pem').unlink()
        spire=json.loads((ROOT/'infra/workload/spire-policy.example.json').read_text())
        spire.update(trustDomain='host.axiomproof.test',projectId='axiom-host-test',issuerPrivateIp='10.231.7.1')
        for role in ('issuer','runner'):
            config={'schemaVersion':1,'platform':'ubuntu-24.04','architecture':arch,'role':role,'filesystemUuid':'de6a77f6-27ae-4c42-b302-8a98d243ed9b','spirePolicy':spire,'bootstrapCaSha256':hashlib.sha256(ca).hexdigest() if role=='runner' else None}
            metadata,files=prepare(config,raw_archive,ca if role=='runner' else None)
            directory=root/'bundles'/role;directory.mkdir(parents=True,mode=0o700)
            for name,data in {**files,'manifest.json':metadata}.items():
                path=directory/name;path.write_bytes(data);path.chmod(0o600)
        fixture=root/'fixture';fixture.mkdir()
        shutil.copyfile(ROOT/'infra/workload/spire_host.py',fixture/'spire_host.py')
        (fixture/'verify.py').write_text(VERIFY)
        (root/'Dockerfile').write_text(f'''FROM {UBUNTU}
RUN printf '#!/bin/sh\\nexit 101\\n' > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d && apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 systemd util-linux docker.io ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /etc/axiom /opt/axiom
COPY --chown=0:0 bundles /bundles
COPY --chown=0:0 fixture /fixture
ENTRYPOINT ["/usr/bin/python3", "-I", "-B", "/fixture/verify.py"]
''')
        print('Workload host acceptance: pinned Ubuntu delivery image.',flush=True)
        run(['docker','build','-t',image,str(root)],timeout=600)
        outcomes={}
        for role in ('issuer','runner'):
            name='axiom-host-test-'+uuid.uuid4().hex[:12];containers.append(name)
            print(f'Workload host acceptance: {role} delivery and unit verification.',flush=True)
            output=run(['docker','run','--rm','--name',name,'--read-only','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none','--tmpfs','/tmp:rw,nosuid,nodev,noexec,mode=1777','--tmpfs','/run:rw,nosuid,nodev,mode=755','--tmpfs','/etc/axiom:rw,nosuid,nodev,mode=755','--tmpfs','/etc/systemd/system:rw,nosuid,nodev,mode=755','--tmpfs','/opt/axiom:rw,nosuid,nodev,mode=755','--tmpfs','/usr/local/bin:rw,exec,nosuid,nodev,mode=755',image,role])
            values=json.loads(output)
            if len(values)!=8 or any(v is not True for v in values.values()):raise ValueError('host outcomes refused')
            outcomes.update({role+'-'+key:value for key,value in values.items()})
        report={'revision':run(['git','rev-parse','HEAD']).strip(),'dirty':bool(run(['git','status','--porcelain']).strip()),'passed':True,'platform':'ubuntu-24.04','systemd_major':255,'spire_version':VERSION,'outcomes':outcomes}
        (OUT/'results.json').write_text(json.dumps(report,indent=2)+'\n')
        print(f'Workload host acceptance: {len(outcomes)} outcomes passed.',flush=True)
    finally:
        for name in containers:subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['docker','image','rm',image],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        shutil.rmtree(root,ignore_errors=True)


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=[f'{f.name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__) if f.filename==__file__]
        print('Workload host acceptance refused at '+' / '.join(frames)+'. Private diagnostics withheld.',file=sys.stderr)
        sys.exit(1)
