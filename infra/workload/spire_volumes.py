#!/usr/bin/env python3
"""Reviewed root-only Docker volume mapping; never launches or repairs containers."""
from __future__ import annotations
import json
import os
import stat
import sys
import time
import traceback
from pathlib import Path
sys.path.insert(0,'/opt/axiom/spire/1.15.3')
import spire_host as host
import spire_state as state
import spire_enrollment as enrollment

RECORD=Path('/etc/axiom/spire/runtime-volumes.json')
SOCKET=Path('/run/docker.sock')
SOURCES={'workload':Path('/run/workload'),'health':Path('/run/spire-health')}
OPTIONS='bind,ro,nosuid,nodev,noexec'


def daemon_namespace() -> None:
    raw=enrollment.control('show','--property=MainPID','--value','docker.service').decode('ascii').strip()
    if not raw.isdigit() or int(raw)<=0:
        raise ValueError('Docker daemon process refused')
    process=Path('/proc')/raw
    if process.stat().st_uid!=0:
        raise ValueError('Docker daemon owner refused')
    daemon=(process/'ns/mnt').stat();caller=Path('/proc/self/ns/mnt').stat()
    if (daemon.st_dev,daemon.st_ino)!=(caller.st_dev,caller.st_ino):
        raise ValueError('Docker mount namespace is not observable')


def docker(*args: str) -> bytes:
    daemon_namespace()
    host.protected_directory(SOCKET.parent)
    meta=SOCKET.lstat()
    if not stat.S_ISSOCK(meta.st_mode) or meta.st_uid!=0 or meta.st_mode&0o002:
        raise ValueError('local Docker socket refused')
    return enrollment.command(['/usr/bin/docker','--host','unix:///run/docker.sock','--config','/nonexistent/axiom-docker-config',*args],timeout=5)


def active(unit: str) -> None:
    properties=('ActiveState','SubState','MainPID','FragmentPath','DropInPaths','NeedDaemonReload','Transient')
    fields=dict(line.split('=',1) for line in enrollment.control('show',*('--property='+key for key in properties),unit).decode('ascii').splitlines())
    if set(fields)!=set(properties) or fields['ActiveState']!='active' or fields['SubState']!='running' or not fields['MainPID'].isdigit() or int(fields['MainPID'])<=0 or fields['FragmentPath']!='/etc/systemd/system/'+unit or fields['DropInPaths'] or fields['NeedDaemonReload']!='no' or fields['Transient']!='no':
        raise ValueError('live reviewed runner required')


def sources() -> dict:
    result={}
    for kind,path in SOURCES.items():
        host.protected_directory(path)
        meta=path.lstat()
        if stat.S_IMODE(meta.st_mode)!=0o755:
            raise ValueError('protected runtime directory required')
        result[kind]={'device':meta.st_dev,'inode':meta.st_ino}
    api=(SOURCES['workload']/'api.sock').lstat()
    if not stat.S_ISSOCK(api.st_mode) or api.st_uid!=0:
        raise ValueError('workload socket required')
    return result


def live(expected: str) -> tuple[dict,dict]:
    binding=enrollment.installed(expected,'runner')
    state.check('--ready','runner')
    active('axiom-spire-runner.service');active('axiom-spire-health.service')
    identity=sources()
    raw=host.read_file(SOURCES['health']/'status.json',4096,0o644)
    value=json.loads(raw,object_pairs_hook=host.unique);now=time.time_ns()//1000000
    fields={'schemaVersion','healthy','nodeId','observedAtMs','syncAtMs','certificateExpiresAtMs'}
    if not isinstance(value,dict) or set(value)!=fields or type(value['schemaVersion']) is not int or value['schemaVersion']!=1 or value['healthy'] is not True or value['nodeId']!=binding['nodeId']:
        raise ValueError('node health refused')
    if any(type(value[key]) is not int for key in ('observedAtMs','syncAtMs','certificateExpiresAtMs')) or not now-10000<value['observedAtMs']<=now or not now-30000<value['syncAtMs']<=value['observedAtMs'] or value['certificateExpiresAtMs']<=now:
        raise ValueError('node health expired')
    if sources()!=identity:
        raise ValueError('runtime directory changed')
    return binding,identity


def mapping(binding: dict, expected: str) -> dict:
    value=state.policy(binding);enrollment.sha(expected)
    if value['role']!='runner':raise ValueError('runner binding required')
    names={'workload':'axiom-workload-api-','health':'axiom-spire-health-'}
    return {'schemaVersion':1,'manifestSha256':expected,'binding':value,'volumes':{
        kind:{'Name':prefix+value['filesystemUuid'],'Driver':'local','Scope':'local',
              'Options':{'type':'none','device':str(SOURCES[kind]),'o':OPTIONS},
              'Labels':{'ai.axiomproof.manifest':expected,'ai.axiomproof.state':value['filesystemUuid'],'ai.axiomproof.kind':kind}}
        for kind,prefix in names.items()}}


def listed() -> set[str]:
    names=docker('volume','ls','--format','{{.Name}}').decode('ascii').splitlines()
    if len(names)!=len(set(names)) or any(not name or name.strip()!=name for name in names):
        raise ValueError('volume inventory refused')
    return set(names)


def inspect(expected: dict) -> None:
    values=json.loads(docker('volume','inspect',expected['Name']),object_pairs_hook=host.unique)
    if not isinstance(values,list) or len(values)!=1 or not isinstance(values[0],dict):
        raise ValueError('volume observation refused')
    value=values[0]
    if any(value.get(key)!=item for key,item in expected.items()):
        raise ValueError('existing volume binding refused')
    target=Path('/var/lib/docker/volumes')/expected['Name']/'_data'
    if value.get('Mountpoint')!=str(target):
        raise ValueError('Docker data root refused')
    host.protected_directory(target)
    with open('/proc/self/mountinfo',encoding='ascii') as stream:
        mounts=state.parse_mounts(stream.read(4*1024*1024+1))
    attached=[entry for entry in mounts if entry['path']==str(target)]
    if len(attached)>1 or any(entry['path'].startswith(str(target)+'/') for entry in mounts):
        raise ValueError('stacked or nested volume mount refused')
    if attached:
        actual=target.stat();source=Path(expected['Options']['device']).stat()
        if (actual.st_dev,actual.st_ino)!=(source.st_dev,source.st_ino) or not {'ro','nosuid','nodev','noexec'}<=attached[0]['options']:
            raise ValueError('mounted volume source refused')



def prepare(expected: str, check: bool=False) -> dict:
    binding,identity=live(expected);review=mapping(binding,expected)
    names=listed()
    # Validate every conflict before creating either volume or recording review.
    for volume in review['volumes'].values():
        if volume['Name'] in names:inspect(volume)
        elif check:raise ValueError('reviewed volume missing')
    if RECORD.exists() or RECORD.is_symlink():
        if enrollment.load(RECORD)!=review:raise ValueError('volume review changed')
    elif check:raise ValueError('volume review missing')
    else:enrollment.create(RECORD,enrollment.encode(review))
    if live(expected)!=(binding,identity):raise ValueError('runtime binding changed')
    if not check:
        for volume in review['volumes'].values():
            if volume['Name'] not in names:
                args=['volume','create','--driver','local']
                for key,value in volume['Options'].items():args+=['--opt',key+'='+value]
                for key,value in volume['Labels'].items():args+=['--label',key+'='+value]
                output=docker(*args,volume['Name'])
                if output!=(volume['Name']+'\n').encode():raise ValueError('volume creation unconfirmed')
            inspect(volume)
    if live(expected)!=(binding,identity):raise ValueError('runtime binding changed')
    return review


def main():
    if sys.platform!='linux' or os.geteuid()!=0 or len(sys.argv)!=3 or sys.argv[1] not in ('--prepare','--check'):
        raise ValueError('root Linux volume operation required')
    os.umask(0o077)
    with enrollment.exclusive():
        result=prepare(sys.argv[2],check=sys.argv[1]=='--check')
    print(json.dumps({'workloadApiVolume':result['volumes']['workload']['Name'],'healthVolume':result['volumes']['health']['Name']},sort_keys=True))


if __name__=='__main__':
    try:main()
    except Exception as error:
        frames=[f'{frame.name}:{frame.lineno}' for frame in traceback.extract_tb(error.__traceback__) if Path(frame.filename).name in ('spire_volumes.py','spire_enrollment.py','spire_host.py','spire_state.py')]
        print('SPIRE runtime volume operation refused at '+' / '.join(frames)+'; existing mappings and review record require inspection.',file=sys.stderr);sys.exit(1)
