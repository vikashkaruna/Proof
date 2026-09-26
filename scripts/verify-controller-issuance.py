#!/usr/bin/env python3
"""Actual issuer CLI through fixture TLS to existing isolated Postgres/PostgREST.

The TLS bridges are local fixture transports, never production fallbacks. They
terminate synthetic TLS then use the already isolated stack's loopback ports.
Only synthetic tenant IDs/keys are used; private output never enters reports.
"""
import base64
import hashlib
import http.server
import importlib.util
import json
import os
import re
from pathlib import Path
import selectors
import shutil
import socket
import socketserver
import ssl
import struct
import subprocess  # nosec B404 - fixed fixture CLIs with list argv, no shell
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('controller_issuer',ROOT/'infra/credential-issuer/issuer.py')
issuer=importlib.util.module_from_spec(spec);spec.loader.exec_module(issuer)
phase='setup'
DOCKER=shutil.which('docker');OPENSSL=shutil.which('openssl');PNPM=shutil.which('pnpm')


def sql(statement):
    result=subprocess.run([DOCKER,'exec','-i','supabase_db_axiom-w0-parity','psql','-X','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-q','-A','-t'],input=statement.encode(),capture_output=True,timeout=10)  # nosec B603 - DOCKER resolved via PATH above, fixed fixture container, no shell
    if result.returncode:raise RuntimeError('fixture SQL refused')
    return result.stdout.decode().strip()


class ThreadedTCP(socketserver.ThreadingTCPServer):
    daemon_threads=True


def main():
    global phase
    if not (DOCKER and OPENSSL and PNPM):
        raise RuntimeError('docker, openssl and pnpm are required')
    args=json.load(sys.stdin)
    if set(args)!={'tenantId','foreignTenantId'}:raise RuntimeError('unexpected acceptance input')
    tenant=issuer.identifier(args['tenantId']);foreign=issuer.identifier(args['foreignTenantId'])
    status=json.loads((ROOT/'.axiom-runtime/parity/status.json').read_text())
    if status['API_URL']!='http://127.0.0.1:56321':raise RuntimeError('isolated loopback target required')
    os.umask(0o077)
    outcome={};reviews=[];issued=[];servers=[]
    username='axiom_issuer_fixture_'+uuid.uuid4().hex[:20];password=uuid.uuid4().hex+uuid.uuid4().hex
    temporary=tempfile.TemporaryDirectory(prefix='axiom-controller-issuer-',dir=Path.home());root=Path(temporary.name).resolve()
    role_created=False
    try:
        cert=root/'cert.pem';key=root/'tls.key'
        subprocess.run([OPENSSL,'req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)  # nosec B603 - OPENSSL resolved via PATH, fixed fixture arguments, no shell
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key)
        class DatabaseProxy(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.settimeout(5)
                wire=b''
                while len(wire)<8:
                    chunk=self.request.recv(8-len(wire))
                    if not chunk:return
                    wire+=chunk
                if wire!=struct.pack('!II',8,80877103):return
                self.request.sendall(b'S')
                try:
                    with context.wrap_socket(self.request,server_side=True) as client, socket.create_connection(('127.0.0.1',56322),timeout=5) as backend:
                        # TLS may buffer a full record beyond select's FD readiness.
                        client.settimeout(5);backend.settimeout(5)
                        with selectors.DefaultSelector() as ready:
                            ready.register(client,selectors.EVENT_READ,backend);ready.register(backend,selectors.EVENT_READ,client)
                            while True:
                                events=ready.select(5)
                                if not events:return
                                for event,_ in events:
                                    data=event.fileobj.recv(65536)
                                    if not data:return
                                    event.data.sendall(data)
                except (OSError,ssl.SSLError):return
        dbserver=ThreadedTCP(('127.0.0.1',0),DatabaseProxy);servers.append(dbserver)
        class BackendProxy(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                target='/rest/v1/rpc/current_assessment_controller_tenant'
                if self.path!=target:self.send_error(404);return
                req=urllib.request.Request('http://127.0.0.1:56321'+target,headers={'apikey':self.headers.get('apikey',''),'Authorization':self.headers.get('Authorization','')})
                try:
                    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=5) as response:code=response.status;data=response.read(4096)
                except urllib.error.HTTPError as error:code=error.code;data=b'null'
                self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        backendserver=http.server.ThreadingHTTPServer(('127.0.0.1',0),BackendProxy);backendserver.socket=context.wrap_socket(backendserver.socket,server_side=True);servers.append(backendserver)
        for server in servers:threading.Thread(target=server.serve_forever,daemon=True).start()
        phase='scoped-login'
        sql(f"create role {username} login noinherit password '{password}'; grant axiom_controller_issuer to {username};")
        role_created=True
        def save(name,data):
            path=root/name;path.write_bytes(data);path.chmod(0o600);return {'path':str(path),'sha256':issuer.sha(data)}
        ca=save('ca.pem',cert.read_bytes())
        service=f"[axiom-controller-issuer]\nhost=127.0.0.1\nport={dbserver.server_address[1]}\ndbname=postgres\nuser={username}\npassword={password}\nsslmode=verify-full\nsslrootcert={ca['path']}\nconnect_timeout=5\n".encode()
        # Homebrew's Cellar can be group-writable. Preserve production ancestry
        # admission and stage the exact installed CLI bytes into this private fixture.
        psql=root/'psql';shutil.copyfile(Path(shutil.which('psql')).resolve(),psql);psql.chmod(0o700)
        settings={'schemaVersion':1,'psql':str(psql),'service':save('pg-service.conf',service),'apiKey':save('anon.key',status['ANON_KEY'].encode()),'signingKey':save('signer.key',status['JWT_SECRET'].encode()),'backendCa':ca,'databaseCa':ca,'backendOrigin':f'https://127.0.0.1:{backendserver.server_address[1]}'}
        config=root/'configuration.json';save(config.name,issuer.encode(settings));configsha=issuer.sha(config.read_bytes())
        def review(predecessor=None,selected=tenant):
            now=int(time.time());value={'schemaVersion':1,'purpose':'controller-backend-issue','credentialId':str(uuid.uuid4()),'tenantId':selected,'configurationSha256':configsha,'approvalReference':str(uuid.uuid4()),'predecessorId':predecessor,'issuedAt':now,'expiresAt':now+900}
            path=root/(value['credentialId']+'.json');save(path.name,issuer.encode(value));reviews.append(value)
            return value,path,issuer.sha(path.read_bytes())
        def command(mode,path,expected,directory,success=True):
            result=subprocess.run([sys.executable,'-I',str(ROOT/'infra/credential-issuer/issuer.py'),mode,str(path),expected,str(config),str(directory)],capture_output=True,timeout=30,env={'PATH':os.environ['PATH'],'HOME':str(Path.home())})  # nosec B603 - argv is sys.executable plus reviewed repo paths and fixture digests, no shell
            if (result.returncode==0)!=success:
                stage=re.search(rb'uncertain at ([a-z-]+);',result.stderr)
                if stage:print('Issuer fixture diagnostic stage: '+stage[1].decode(),file=sys.stderr)
                raise RuntimeError('issuer command outcome refused')
            for secret in (password,status['JWT_SECRET'],status['ANON_KEY']):
                if secret.encode() in result.stdout+result.stderr:raise RuntimeError('credential leak refused')
            return result
        def consumer(directory,selected=tenant,success=True):
            result=subprocess.run([PNPM,'exec','tsx','scripts/lib/controller-issued-file-check.ts',str(directory/'backend.key'),settings['backendOrigin'],selected],capture_output=True,timeout=20,cwd=ROOT,env={'PATH':os.environ['PATH'],'HOME':str(Path.home()),'NODE_EXTRA_CA_CERTS':ca['path']})  # nosec B603 - PNPM resolved via PATH, repo-owned script, no shell
            if (result.returncode==0)!=success:raise RuntimeError('production credential consumer outcome refused')
            if success and result.stdout!=b'issued-file-accepted\n':raise RuntimeError('unexpected consumer output')
        phase='first-issuance'
        first,path,expected=review();firstdir=root/'first';command('--issue',path,expected,firstdir);issued.append((first,path,expected));consumer(firstdir)
        result=json.loads((firstdir/'ready.json').read_bytes())
        if result['status']!='active':raise RuntimeError('issuance did not activate')
        # credentialId is an internally generated UUID from this fixture process.
        if sql(f"select count(*) from controller_security.credentials where id='{first['credentialId']}';")!='1':raise RuntimeError('issued credential record missing')  # nosec B608 - internal UUID constant, no external input
        outcome['controller-issuance-real-cli-scoped-db-tls-and-backend-consumer']=True
        phase='idempotent-resume'
        before={p.name:(p.stat().st_ino,p.read_bytes()) for p in firstdir.iterdir()};command('--resume-issue',path,expected,firstdir)
        if before!={p.name:(p.stat().st_ino,p.read_bytes()) for p in firstdir.iterdir()}:raise RuntimeError('idempotent resume replaced files')
        command('--issue',path,expected,firstdir,False)
        if sql(f"select count(*) from controller_security.issuances where credential_id='{first['credentialId']}';")!='1':raise RuntimeError('duplicate issuance record')  # nosec B608 - internal UUID constant, no external input
        outcome['controller-issuance-explicit-resume-preserves-token-and-single-record']=True
        phase='foreign-consumer'
        consumer(firstdir,foreign,False)
        bad,reviewpath,badhash=review(first['credentialId'],foreign);command('--issue',reviewpath,badhash,root/'foreign',False)
        if sql(f"select count(*) from controller_security.credentials where id='{bad['credentialId']}';")!='0':raise RuntimeError('foreign tenant credential issued')  # nosec B608 - internal UUID constant, no external input
        outcome['controller-issuance-foreign-tenant-and-predecessor-refused']=True
        phase='renewal'
        nextvalue,nextpath,nexthash=review(first['credentialId']);nextdir=root/'next';command('--issue',nextpath,nexthash,nextdir);issued.append((nextvalue,nextpath,nexthash));consumer(nextdir);consumer(firstdir)
        if json.loads((nextdir/'ready.json').read_bytes())['predecessorId']!=first['credentialId']:raise RuntimeError('renewal predecessor mismatch')
        outcome['controller-renewal-fresh-subject-keeps-predecessor-for-reviewed-rollout']=True
        branch,branchpath,branchhash=review(first['credentialId']);command('--issue',branchpath,branchhash,root/'branch',False)
        if sql(f"select count(*) from controller_security.credentials where id='{branch['credentialId']}';")!='0':raise RuntimeError('second successor issued')  # nosec B608 - internal UUID constant, no external input
        outcome['controller-renewal-second-successor-refused-atomically']=True
        phase='retirement'
        def retirement(value,issuehash,name):
            v={'schemaVersion':1,'purpose':'controller-backend-revoke','credentialId':value['credentialId'],'tenantId':value['tenantId'],'configurationSha256':configsha,'approvalReference':str(uuid.uuid4()),'issuanceSha256':issuehash}
            path=root/(name+'.json');save(path.name,issuer.encode(v));return path,issuer.sha(path.read_bytes()),root/name
        retired,retiredhash,retireddir=retirement(first,expected,'retired');command('--revoke',retired,retiredhash,retireddir);command('--resume-revoke',retired,retiredhash,retireddir)
        consumer(firstdir,success=False);consumer(nextdir)
        command('--resume-issue',path,expected,firstdir,False)
        outcome['controller-retirement-real-revocation-blocks-old-token-and-remint']=True
        phase='private-output'
        allbytes=b'\n'.join(p.read_bytes() for directory in (firstdir,nextdir) for p in directory.iterdir())
        if password.encode() in allbytes or status['JWT_SECRET'].encode() in allbytes:raise RuntimeError('private output leaked')
        if not all(p.stat().st_mode&0o777==0o600 for directory in (firstdir,nextdir) for p in directory.iterdir()):raise RuntimeError('delivered file permissions widened')
        outcome['controller-issuance-signing-and-db-secrets-excluded-from-delivery']=True
        last,lasthash,lastdir=retirement(nextvalue,nexthash,'retired-next');command('--revoke',last,lasthash,lastdir);consumer(nextdir,success=False)
        outcome['controller-issuance-all-fixture-authority-revoked']=True
        print(json.dumps({'passed':True,'outcomes':outcome}))
    finally:
        # Emergency fixture cleanup uses existing DB administration, never
        # changes or deletes immutable reviews. No production authority here.
        for value in reviews:
            sql(f"update controller_security.credentials set revoked_at=clock_timestamp() where id='{value['credentialId']}' and revoked_at is null;")  # nosec B608 - internal UUID constants from this fixture's own reviews
        if role_created:sql(f"revoke axiom_controller_issuer from {username}; drop role {username};")
        for server in servers:server.shutdown();server.server_close()
        temporary.cleanup()

if __name__=='__main__':
    try:main()
    except Exception:
        print('Controller issuance acceptance refused at '+phase+'. Private output withheld.',file=sys.stderr);sys.exit(1)
