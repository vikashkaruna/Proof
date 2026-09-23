#!/usr/bin/env python3
"""Explicit root-reviewed generation publication and separate loaded-unit confirmation.

This is deployment administration, not application action approval. The external
change-record UUID and protected request hash do not authenticate a human.
Never starts, stops, enables, reloads, removes or adopts a service/container.
"""
from __future__ import annotations
import os
from pathlib import Path
import stat
import sys

sys.path.insert(0, '/opt/axiom/spire/1.15.3')
import controller_runtime as runtime
import controller_files as files
import spire_enrollment as enrollment
import spire_host as host

ROOT = Path('/var/lib/axiom-controller-transitions')
MAX_PREPARATION = 1048576


def request(value: dict) -> dict:
    fields = {'schemaVersion','tenantId','approvalReference','previousTransitionSha256','previousProfileSha256','nextProfileFile','nextProfileSha256','previousGenerationSha256','nextGenerationSha256'}
    if not isinstance(value,dict) or set(value)!=fields or type(value['schemaVersion']) is not int or value['schemaVersion']!=1: raise ValueError('transition request refused')
    runtime.tenant(value['tenantId']); runtime.tenant(value['approvalReference'])
    for key in ('previousProfileSha256','nextProfileSha256','previousGenerationSha256','nextGenerationSha256'): enrollment.sha(value[key])
    if value['previousTransitionSha256'] is not None: enrollment.sha(value['previousTransitionSha256'])
    if value['previousProfileSha256']==value['nextProfileSha256'] or value['previousGenerationSha256']==value['nextGenerationSha256']: raise ValueError('unchanged generation refused')
    path=value['nextProfileFile']
    if not isinstance(path,str) or not Path(path).is_absolute() or str(Path(path))!=path or '..' in Path(path).parts: raise ValueError('profile path refused')
    return value


def reviewed(path: Path, expected: str) -> tuple[dict,bytes]:
    enrollment.sha(expected); raw=host.read_file(path,8192,0o600)
    if enrollment.digest(raw)!=expected: raise ValueError('transition review changed')
    import json
    return request(json.loads(raw,object_pairs_hook=host.unique)),raw


def private(path: Path) -> None:
    host.protected_directory(path)
    if stat.S_IMODE(path.stat().st_mode)!=0o700: raise ValueError('transition directory refused')


def unit_path(tenant: str) -> Path:
    return runtime.UNITS/('axiom-controller-'+runtime.tenant(tenant)+'.service')


def receipt(value: dict, expected: str) -> dict:
    return {'schemaVersion':1,'requestSha256':expected,'tenantId':value['tenantId'],'profileSha256':value['nextProfileSha256']}


def history(tenant: str, own: str | None = None) -> list[tuple[str,dict]]:
    """One immutable ordered chain; partial publication blocks every startup."""
    if not ROOT.exists() and not ROOT.is_symlink(): return []
    private(ROOT); parent=ROOT/runtime.tenant(tenant)
    if not parent.exists() and not parent.is_symlink(): return []
    private(parent); entries={}; successors={}
    for path in parent.iterdir():
        enrollment.sha(path.name); private(path)
        if path.name==own: continue
        names={p.name for p in path.iterdir()}
        if names!={'request.json','previous.unit','next.unit','prepared.json','published.json','confirmed.json'}: raise ValueError('incomplete transition requires review')
        value,_=reviewed(path/'request.json',path.name)
        if value['tenantId']!=tenant: raise ValueError('transition tenant refused')
        prepared=enrollment.load(path/'prepared.json',MAX_PREPARATION); expected=receipt(value,path.name)
        if enrollment.encode(prepared.get('receipt'))!=enrollment.encode(expected) or set(prepared)!={'receipt','attempts'} or not isinstance(prepared['attempts'],dict): raise ValueError('transition preparation refused')
        for name in ('published.json','confirmed.json'):
            if host.read_file(path/name,8192,0o600)!=enrollment.encode(expected): raise ValueError('transition receipt refused')
        for side,key in (('previous','previousProfileSha256'),('next','nextProfileSha256')):
            profile=runtime.reviewed(runtime.PROFILES/(value[key]+'.json'),value[key])
            if profile['tenantId']!=tenant or host.read_file(path/(side+'.unit'),8192,0o600)!=runtime.unit(profile,value[key]): raise ValueError('transition history changed')
        prior=value['previousTransitionSha256']
        if prior in successors: raise ValueError('branched transition history refused')
        successors[prior]=path.name; entries[path.name]=value
    ordered=[]; prior=None
    while prior in successors:
        current=successors[prior]
        if len(ordered)>=len(entries): raise ValueError('transition history cycle refused')
        value=entries[current]
        if ordered and value['previousProfileSha256']!=ordered[-1][1]['nextProfileSha256']: raise ValueError('transition profile chain refused')
        ordered.append((current,value));prior=current
    if len(ordered)!=len(entries): raise ValueError('disconnected transition history refused')
    return ordered


def idle(tenant: str, allow_reload: bool = False) -> None:
    keys=('LoadState','ActiveState','MainPID','Job','UnitFileState','FragmentPath','DropInPaths','NeedDaemonReload','Transient')
    lines=enrollment.control('show',*('--property='+key for key in keys),unit_path(tenant).name).decode('ascii').splitlines()
    pairs=[line.split('=',1) for line in lines]
    if any(len(pair)!=2 for pair in pairs): raise ValueError('service observation refused')
    values=host.unique(pairs)
    expected={'LoadState':'loaded','MainPID':'0','UnitFileState':'disabled','FragmentPath':str(unit_path(tenant)),'DropInPaths':'','Transient':'no'}
    if set(values)!=set(keys) or any(values[k]!=v for k,v in expected.items()) or values['ActiveState'] not in ('inactive','failed') or values['Job'] not in ('','0') or values['NeedDaemonReload'] not in (('yes','no') if allow_reload else ('no',)):
        raise ValueError('service must be reviewed, stopped and disabled')


def inputs(value: dict) -> tuple[bytes,bytes,bytes]:
    old,_,previous=runtime.delivery(runtime.PROFILES/(value['previousProfileSha256']+'.json'),value['previousProfileSha256'])
    new,raw,next_placed=runtime.delivery(Path(value['nextProfileFile']),value['nextProfileSha256'])
    if old['tenantId']!=value['tenantId'] or new['tenantId']!=value['tenantId'] or previous['controllerManifestSha256']!=value['previousGenerationSha256'] or next_placed['controllerManifestSha256']!=value['nextGenerationSha256']:
        raise ValueError('transition binding refused')
    return runtime.unit(old,value['previousProfileSha256']),runtime.unit(new,value['nextProfileSha256']),raw


def sync(path: Path) -> None:
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def admit(tenant: str, expected: str, attempts: Path) -> None:
    chain=history(tenant)
    if not chain: return
    sha,value=chain[-1]
    if value['nextProfileSha256']!=expected or host.read_file(unit_path(tenant),8192,0o600)!=host.read_file(ROOT/tenant/sha/'next.unit',8192,0o600): raise ValueError('retired or unconfirmed generation refused')
    runtime.settled(attempts)


def transition(source: Path, expected: str, mode: str) -> None:
    if mode not in ('publish','resume','confirm'): raise ValueError('transition mode refused')
    value,raw=reviewed(source,expected); tenant=value['tenantId']
    # Same order as runtime.run. Stop the service separately, before taking its
    # lifetime lock; asking systemd to stop while holding it would deadlock.
    with runtime.locked(tenant) as attempts, enrollment.exclusive():
        chain=history(tenant,expected if mode!='publish' else None)
        if value['previousTransitionSha256']!=(chain[-1][0] if chain else None) or (chain and value['previousProfileSha256']!=chain[-1][1]['nextProfileSha256']): raise ValueError('transition predecessor changed')
        old,new,profile_raw=inputs(value); target=unit_path(tenant)
        current=host.read_file(target,8192,0o600)
        if current not in (old,new) or mode=='publish' and current!=old: raise ValueError('existing unit conflict preserved')
        idle(tenant,allow_reload=current==new and mode=='resume')
        observed=runtime.settled(attempts)
        journal=ROOT/tenant/expected
        wanted=receipt(value,expected); prepared={'receipt':wanted,'attempts':observed}
        prepared_raw=enrollment.encode(prepared)
        if len(prepared_raw)>MAX_PREPARATION: raise ValueError('transition snapshot exceeds reviewed limit')
        profile=runtime.PROFILES/(value['nextProfileSha256']+'.json')
        if mode=='publish':
            files.private_directory(ROOT,0o700);files.private_directory(ROOT/tenant,0o700)
            enrollment.absent(journal);files.private_directory(journal,0o700)
            enrollment.create(journal/'request.json',raw);enrollment.create(journal/'previous.unit',old);enrollment.create(journal/'next.unit',new)
            if profile.exists() or profile.is_symlink():
                if host.read_file(profile,8192,0o600)!=profile_raw: raise ValueError('profile conflict preserved')
            else: enrollment.create(profile,profile_raw)
            enrollment.create(journal/'prepared.json',prepared_raw)
        private(journal)
        names={p.name for p in journal.iterdir()}
        required={'request.json','previous.unit','next.unit','prepared.json'}
        if not required<=names<=required|{'published.json','confirmed.json'}: raise ValueError('partial transition preserved')
        for name,data in (('request.json',raw),('previous.unit',old),('next.unit',new),('prepared.json',prepared_raw)):
            if host.read_file(journal/name,MAX_PREPARATION if name=='prepared.json' else 16384,0o600)!=data: raise ValueError('transition preparation changed')
        if host.read_file(profile,8192,0o600)!=profile_raw: raise ValueError('installed profile changed')
        for name in ('published.json','confirmed.json'):
            if name in names and host.read_file(journal/name,8192,0o600)!=enrollment.encode(wanted): raise ValueError('transition receipt changed')
        temporary=target.parent/('.'+target.name+'.'+expected+'.pending')
        if mode=='confirm':
            if current!=new or 'published.json' not in names or temporary.exists() or temporary.is_symlink(): raise ValueError('unit not durably published')
            if reviewed(source,expected)!=(value,raw) or inputs(value)!=(old,new,profile_raw) or runtime.settled(attempts)!=observed or host.read_file(target,8192,0o600)!=new: raise ValueError('confirmation inputs changed')
            idle(tenant)
            if 'confirmed.json' not in names: enrollment.create(journal/'confirmed.json',enrollment.encode(wanted))
            return
        if 'confirmed.json' in names:
            if current!=new or temporary.exists() or temporary.is_symlink(): raise ValueError('confirmed unit changed')
            return
        if current==old:
            if 'published.json' in names: raise ValueError('published unit reverted outside review')
            if temporary.exists() or temporary.is_symlink():
                if host.read_file(temporary,8192,0o600)!=new: raise ValueError('publication staging conflict')
            else: enrollment.create(temporary,new)
            # Check all input and stopped-state bindings again immediately before
            # replacing only the exact reviewed previous unit. Root is trusted.
            if reviewed(source,expected)!=(value,raw) or inputs(value)!=(old,new,profile_raw) or runtime.settled(attempts)!=observed or host.read_file(target,8192,0o600)!=old: raise ValueError('transition inputs changed')
            idle(tenant)
            os.replace(temporary,target);sync(target.parent)
        elif temporary.exists() or temporary.is_symlink(): raise ValueError('unexpected publication staging retained')
        if host.read_file(target,8192,0o600)!=new: raise ValueError('unit publication uncertain')
        if 'published.json' not in names: enrollment.create(journal/'published.json',enrollment.encode(wanted))
        # No reload/start: loaded-unit confirmation is a separate explicit step.


def main() -> None:
    if not sys.flags.isolated or sys.platform!='linux' or os.geteuid()!=0 or len(sys.argv)!=4 or sys.argv[1] not in ('--publish','--resume','--confirm'): raise ValueError('root isolated transition CLI required')
    os.umask(0o077)
    transition(Path(sys.argv[2]),sys.argv[3],sys.argv[1][2:])
    print('Reviewed transition step recorded; no service activation or application readiness claimed.')


if __name__=='__main__':
    try: main()
    except Exception:
        print('Controller transition refused or uncertain; preserve journal and use the same reviewed request for recovery.',file=sys.stderr)
        sys.exit(1)
