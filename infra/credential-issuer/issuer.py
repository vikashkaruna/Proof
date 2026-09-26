#!/usr/bin/env python3
"""Explicit reviewed deployment administration, never an application/runner service.

The approval reference is an operator change-record reference, not proof of a
human signature. This tool trusts protected operator input and separately
provisioned issuer DB membership. It grants no application action approval.
"""
from __future__ import annotations

import base64
import configparser
import contextlib
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import selectors
import ssl
import stat
import subprocess  # nosec B404 - fixed psql CLI with a validated settings path; list argv, never a shell
import sys
import time
import urllib.request
from urllib.parse import urlsplit
import uuid

ROLE = 'axiom_assessment_controller'
SERVICE = 'axiom-controller-issuer'
PHASE = 'input'


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value: raise ValueError('duplicate field refused')
        value[key] = item
    return value


def encode(value) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def digest(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value): raise ValueError('digest refused')
    return value


def identifier(value):
    if not isinstance(value,str) or str(uuid.UUID(value))!=value or uuid.UUID(value).int==0: raise ValueError('identifier refused')
    return value


def ancestry(path: Path):
    if not path.is_absolute() or path.resolve(strict=True)!=path: raise ValueError('path refused')
    for parent in (path,*path.parents):
        s=parent.stat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid not in (0,os.geteuid()) or s.st_mode&0o022: raise ValueError('ancestry refused')


def read(path: Path, maximum=8192) -> bytes:
    ancestry(path.parent)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.geteuid() or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or not 0<s.st_size<=maximum: raise ValueError('file refused')
        with os.fdopen(os.dup(fd),'rb') as stream: data=stream.read(maximum+1)
        if len(data)!=s.st_size: raise ValueError('file changed')
        return data
    finally:os.close(fd)


def sync(path: Path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)


def create(path: Path,data: bytes):
    ancestry(path.parent)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:
        stream.write(data);stream.flush();os.fchmod(stream.fileno(),0o600);os.fsync(stream.fileno())
    sync(path.parent)


def request(raw: bytes,expected: str,kind: str):
    if len(raw)>4096 or sha(raw)!=digest(expected):raise ValueError('review refused')
    v=json.loads(raw,object_pairs_hook=unique)
    keys={'schemaVersion','purpose','credentialId','tenantId','configurationSha256','approvalReference'}
    keys |= {'predecessorId','issuedAt','expiresAt'} if kind=='issue' else {'issuanceSha256'}
    if not isinstance(v,dict) or set(v)!=keys or type(v['schemaVersion']) is not int or v['schemaVersion']!=1 or v['purpose']!='controller-backend-'+kind:raise ValueError('request refused')
    for key in ('credentialId','tenantId','approvalReference'):identifier(v[key])
    digest(v['configurationSha256'])
    if kind=='issue':
        if v['predecessorId'] is not None:
            identifier(v['predecessorId'])
            if v['predecessorId']==v['credentialId']:raise ValueError('predecessor refused')
        start,end=v['issuedAt'],v['expiresAt']
        if type(start) is not int or type(end) is not int or start<0 or not 300<=end-start<=3600:raise ValueError('lifetime refused')
    else:digest(v['issuanceSha256'])
    return v


def source(value,maximum=8192):
    if not isinstance(value,dict) or set(value)!={'path','sha256'} or not isinstance(value['path'],str):raise ValueError('protected source refused')
    data=read(Path(value['path']),maximum)
    if sha(data)!=digest(value['sha256']):raise ValueError('source changed')
    return data


def configuration(path: Path,expected: str):
    raw=read(path,16384)
    if sha(raw)!=digest(expected):raise ValueError('configuration review refused')
    v=json.loads(raw,object_pairs_hook=unique)
    if not isinstance(v,dict) or set(v)!={'schemaVersion','psql','service','apiKey','signingKey','backendCa','databaseCa','backendOrigin'} or type(v['schemaVersion']) is not int or v['schemaVersion']!=1:raise ValueError('configuration refused')
    executable=Path(v['psql']);ancestry(executable.parent)
    s=executable.lstat()
    if executable.resolve(strict=True)!=executable or not stat.S_ISREG(s.st_mode) or s.st_uid not in (0,os.geteuid()) or s.st_mode&0o022 or not s.st_mode&0o100:raise ValueError('psql executable refused')
    origin=v['backendOrigin']
    if not isinstance(origin,str) or len(origin)>2048 or any(ord(c)<33 or ord(c)>126 for c in origin):raise ValueError('backend origin refused')
    url=urlsplit(origin)
    if url.scheme!='https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path or (url.port is not None and not 1<=url.port<=65535):raise ValueError('backend origin refused')
    service=source(v['service']).decode('utf8')
    ini=configparser.ConfigParser(interpolation=None,strict=True);ini.read_string(service)
    fields={'host','port','dbname','user','password','sslmode','sslrootcert','connect_timeout'}
    if ini.defaults() or ini.sections()!=[SERVICE] or set(ini[SERVICE])!=fields or ini[SERVICE]['sslmode']!='verify-full' or ini[SERVICE]['connect_timeout']!='5':raise ValueError('database TLS service refused')
    for field in fields:
        if not ini[SERVICE][field] or '\n' in ini[SERVICE][field] or '\r' in ini[SERVICE][field]:raise ValueError('database setting refused')
    if not ini[SERVICE]['port'].isdigit() or not 1<=int(ini[SERVICE]['port'])<=65535:raise ValueError('database port refused')
    hostname=ini[SERVICE]['host']
    try:
        if str(ipaddress.ip_address(hostname))!=hostname:raise ValueError('database host refused')
    except ValueError:
        if len(hostname)>253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',hostname) or any(not label or len(label)>63 or label.startswith('-') or label.endswith('-') for label in hostname.split('.')):raise ValueError('database TCP host refused')
    # Database and private HTTPS trust roots are reviewed independently.
    if ini[SERVICE]['sslrootcert']!=v['databaseCa']['path']:raise ValueError('database CA binding refused')
    for name in ('backendCa','databaseCa'):
        ssl.create_default_context(cadata=source(v[name],65536).decode('ascii'))
    return v


def database(settings: dict,operation: str,raw: bytes,expected: str,v: dict):
    # All variable SQL is validated UUID/hex or base64. No token, API key,
    # password or signing key enters SQL, argv or environment.
    if operation=='status':
        stmt=f"controller_security.credential_status('{v['credentialId']}','{v['tenantId']}','{expected}')"
    else:
        if operation not in ('issue','revoke'):raise ValueError('database operation refused')
        body=base64.b64encode(raw).decode('ascii')
        stmt=f"controller_security.{operation}_credential(convert_from(decode('{body}','base64'),'UTF8'),'{expected}')"
    sql=f"begin; set local role axiom_controller_issuer; set local statement_timeout='5s'; set local lock_timeout='3s'; select {stmt}; commit;"
    env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LC_ALL':'C','PGSERVICEFILE':settings['service']['path'],'PGSYSCONFDIR':'/nonexistent','PGPASSFILE':'/nonexistent','PGGSSENCMODE':'disable'}
    args=[settings['psql'],'-X','-q','-w','-A','-t','-v','ON_ERROR_STOP=1','--dbname=service='+SERVICE]
    # Input is <8KiB metadata, output is bounded even if the server/CLI misbehaves.
    payload=sql.encode()
    if len(payload)>8192:raise ValueError('database input refused')
    with subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env) as child:  # nosec B603 - psql path from validated settings, all flags constant, no shell
        try:
            data=bytearray();offset=0;end=time.monotonic()+10
            if child.stdin is None or child.stdout is None:
                raise ValueError('database operation refused')
            os.set_blocking(child.stdin.fileno(),False)
            with selectors.DefaultSelector() as poll:
                poll.register(child.stdin,selectors.EVENT_WRITE);poll.register(child.stdout,selectors.EVENT_READ)
                while poll.get_map():
                    remaining=end-time.monotonic()
                    if remaining<=0:raise TimeoutError('database deadline')
                    events=poll.select(remaining)
                    if not events:raise TimeoutError('database deadline')
                    for key,_ in events:
                        if key.fileobj is child.stdin:
                            offset+=os.write(child.stdin.fileno(),payload[offset:])
                            if offset==len(payload):poll.unregister(child.stdin);child.stdin.close()
                        else:
                            chunk=os.read(child.stdout.fileno(),4096)
                            if not chunk:poll.unregister(child.stdout)
                            data.extend(chunk)
                            if len(data)>4096:raise ValueError('database output refused')
            remaining=end-time.monotonic()
            if remaining<=0 or child.wait(timeout=remaining)!=0 or not data:raise ValueError('database operation refused or uncertain')
            return json.loads(data,object_pairs_hook=unique)
        finally:
            if child.poll() is None:child.kill()
            child.wait()


def jwt_parts(value: str):
    parts=value.split('.')
    if len(parts)!=3 or any(not re.fullmatch('[A-Za-z0-9_-]+',p) for p in parts):raise ValueError('token refused')
    def decode(part):return base64.urlsafe_b64decode(part+'='*((-len(part))%4))
    return parts,json.loads(decode(parts[0]),object_pairs_hook=unique),json.loads(decode(parts[1]),object_pairs_hook=unique),decode(parts[2])


def credential(v: dict,settings: dict) -> bytes:
    key=source(settings['signingKey']).removesuffix(b'\n').removesuffix(b'\r')
    if not 32<=len(key)<=8192 or any(c<33 or c>126 for c in key):raise ValueError('signing key refused')
    api=source(settings['apiKey'],4096).decode('ascii').removesuffix('\n').removesuffix('\r')
    parts,header,claims,signature=jwt_parts(api)
    if header!={'alg':'HS256','typ':'JWT'} or claims.get('role')!='anon' or type(claims.get('exp')) is not int or claims['exp']<=time.time():raise ValueError('anonymous gateway key refused')
    if not hmac.compare_digest(signature,hmac.digest(key,('.'.join(parts[:2])).encode(),'sha256')):raise ValueError('gateway signing authority mismatch')
    claims={'role':ROLE,'sub':v['credentialId'],'tenant_id':v['tenantId'],'iat':v['issuedAt'],'exp':v['expiresAt']}
    def b64(data):return base64.urlsafe_b64encode(data).decode().rstrip('=')
    unsigned='.'.join(b64(encode(x).rstrip(b'\n')) for x in ({'alg':'HS256','typ':'JWT'},claims))
    token=unsigned+'.'+b64(hmac.digest(key,unsigned.encode(),'sha256'))
    return encode({'schemaVersion':1,'apiKey':api,'accessToken':token})


@contextlib.contextmanager
def deadline(seconds):
    def expired(*_):raise TimeoutError('backend deadline')
    if signal.getitimer(signal.ITIMER_REAL)!=(0.0,0.0):raise ValueError('existing deadline refused')
    previous=signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,seconds)
    try:yield
    finally:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)


def probe(settings: dict,data: bytes,tenant: str):
    value=json.loads(data,object_pairs_hook=unique)
    context=ssl.create_default_context(cadata=source(settings['backendCa'],65536).decode('ascii'))
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):raise ValueError('backend redirect refused')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPSHandler(context=context))
    req=urllib.request.Request(settings['backendOrigin']+'/rest/v1/rpc/current_assessment_controller_tenant',headers={'apikey':value['apiKey'],'Authorization':'Bearer '+value['accessToken']})
    with deadline(10):
        with opener.open(req,timeout=5) as response:
            result=response.read(4097)
            if response.status!=200 or len(result)>4096 or json.loads(result)!=tenant:raise ValueError('backend scope refused')


def checked_receipt(result):
    fields={'schemaVersion','credentialId','tenantId','requestSha256','predecessorId','issuedAt','expiresAt','status'}
    if not isinstance(result,dict) or set(result)!=fields or type(result['schemaVersion']) is not int or result['schemaVersion']!=1:raise ValueError('receipt schema refused')
    identifier(result['credentialId']);identifier(result['tenantId']);digest(result['requestSha256'])
    if result['predecessorId'] is not None:identifier(result['predecessorId'])
    if type(result['issuedAt']) is not int or type(result['expiresAt']) is not int or result['issuedAt']<0 or not 300<=result['expiresAt']-result['issuedAt']<=3600 or result['status'] not in ('active','expired','revoked'):raise ValueError('receipt lifetime refused')
    return result


def receipt(result,v,expected,status):
    checked_receipt(result)
    wanted={'schemaVersion':1,'credentialId':v['credentialId'],'tenantId':v['tenantId'],'requestSha256':expected,'predecessorId':v['predecessorId'],'issuedAt':v['issuedAt'],'expiresAt':v['expiresAt'],'status':status}
    if result!=wanted:raise ValueError('database receipt refused')
    return wanted


@contextlib.contextmanager
def directory(path: Path,fresh: bool):
    ancestry(path.parent)
    if fresh:path.mkdir(mode=0o700);sync(path.parent)
    ancestry(path)
    if path.stat().st_uid!=os.geteuid() or stat.S_IMODE(path.stat().st_mode)!=0o700:raise ValueError('output directory refused')
    flags=os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_CREAT|os.O_EXCL if fresh else 0)
    fd=os.open(path/'lock',flags,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600:raise ValueError('output lock refused')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield
    finally:os.close(fd)


def issue(review: Path,expected: str,config: Path,target: Path,resume=False,db=database,backend=probe):
    global PHASE
    PHASE='configuration'
    raw=read(review,4096);v=request(raw,expected,'issue');settings=configuration(config,v['configurationSha256'])
    now=time.time()
    if v['issuedAt']>now or v['expiresAt']<=now+60:raise ValueError('credential issue window refused')
    PHASE='signing'
    data=credential(v,settings)
    PHASE='protected-intent'
    intent={'schemaVersion':1,'requestSha256':expected,'configurationSha256':v['configurationSha256'],'credentialSha256':sha(data)}
    with directory(target,not resume):
        if not resume:
            create(target/'request.json',raw);create(target/'candidate.key',data);create(target/'intent.json',encode(intent))
        names={p.name for p in target.iterdir()}
        if names not in ({'lock','request.json','candidate.key','intent.json'},{'lock','request.json','backend.key','intent.json'},{'lock','request.json','backend.key','intent.json','ready.json'}):raise ValueError('partial or unknown issuance output refused')
        saved='candidate.key' if 'candidate.key' in names else 'backend.key'
        if read(target/'request.json',4096)!=raw or read(target/'intent.json')!=encode(intent) or read(target/saved)!=data:raise ValueError('issuance output changed')
        PHASE='registry'
        result=receipt(db(settings,'issue',raw,expected,v),v,expected,'active')
        PHASE='backend-probe'
        backend(settings,data,v['tenantId'])
        # Recheck live registry after the network probe, then inputs, before
        # publishing. Revocation can still happen afterward; every DB request
        # continues to enforce it. No readiness lease is asserted here.
        PHASE='registry-recheck'
        receipt(db(settings,'status',raw,expected,v),v,expected,'active')
        PHASE='input-recheck'
        if configuration(config,v['configurationSha256'])!=settings or credential(v,settings)!=data or read(review,4096)!=raw:raise ValueError('issuer input changed')
        PHASE='publication'
        if saved=='candidate.key':os.rename(target/saved,target/'backend.key');sync(target)
        ready=encode(result)
        if 'ready.json' in names:
            if read(target/'ready.json')!=ready:raise ValueError('completion receipt changed')
        else:create(target/'ready.json',ready)
    return result


def revoke(review: Path,expected: str,config: Path,target: Path,resume=False,db=database):
    global PHASE
    PHASE='revocation-configuration'
    raw=read(review,4096);v=request(raw,expected,'revoke');settings=configuration(config,v['configurationSha256'])
    intent={'schemaVersion':1,'requestSha256':expected,'configurationSha256':v['configurationSha256']}
    with directory(target,not resume):
        if not resume:create(target/'request.json',raw);create(target/'intent.json',encode(intent))
        names={p.name for p in target.iterdir()}
        if names not in ({'lock','request.json','intent.json'},{'lock','request.json','intent.json','ready.json'}):raise ValueError('revocation output refused')
        if read(target/'request.json',4096)!=raw or read(target/'intent.json')!=encode(intent):raise ValueError('revocation intent changed')
        PHASE='revocation-registry'
        result=checked_receipt(db(settings,'revoke',raw,expected,v))
        if not isinstance(result,dict) or result.get('credentialId')!=v['credentialId'] or result.get('tenantId')!=v['tenantId'] or result.get('requestSha256')!=v['issuanceSha256'] or result.get('status')!='revoked':raise ValueError('revocation receipt refused')
        if configuration(config,v['configurationSha256'])!=settings or read(review,4096)!=raw:raise ValueError('revocation input changed')
        ready=encode(result)
        if 'ready.json' in names:
            if read(target/'ready.json')!=ready:raise ValueError('revocation receipt changed')
        else:create(target/'ready.json',ready)
    return result


def main():
    if not sys.flags.isolated or sys.platform not in ('linux','darwin') or len(sys.argv)!=6 or sys.argv[1] not in ('--issue','--resume-issue','--revoke','--resume-revoke'):raise ValueError('explicit issuer command required')
    os.umask(0o077)
    mode,review,expected,config,target=sys.argv[1:]
    fn=issue if mode.endswith('issue') else revoke
    fn(Path(review),expected,Path(config),Path(target),resume=mode.startswith('--resume'))
    print('Reviewed credential operation verified; protected output retained. No host, service or cloud secret changed.')


if __name__=='__main__':
    try:main()
    except Exception:
        print('Credential operation refused or uncertain at '+PHASE+'; preserve private output and reconcile the same reviewed request. No automatic retry.',file=sys.stderr)
        sys.exit(1)
