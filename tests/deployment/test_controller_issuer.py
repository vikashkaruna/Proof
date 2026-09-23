"""Real protected file transitions; injected DB/network side effects are explicit."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('controller_issuer',ROOT/'infra/credential-issuer/issuer.py')
issuer=importlib.util.module_from_spec(spec);spec.loader.exec_module(issuer)

class ControllerIssuerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parent=ROOT/'.axiom-runtime';parent.mkdir(exist_ok=True,mode=0o700)
        cls.base=tempfile.TemporaryDirectory(dir=parent);cls.parent=Path(cls.base.name).resolve()
        cls.cert=cls.parent/'cert.pem';cls.key=cls.parent/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(cls.key),'-out',str(cls.cert),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    @classmethod
    def tearDownClass(cls):cls.base.cleanup()
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=self.parent);self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.target=self.root/'issued';self.config=self.root/'configuration.json';self.review=self.root/'review.json';self.now=int(time.time())
        self.calls=[];self.probes=[];self.active=True
        self.secret=b'synthetic-issuer-hmac-'+b'x'*48
        import base64,hmac
        def b64(v):return base64.urlsafe_b64encode(issuer.encode(v).rstrip(b'\n')).decode().rstrip('=')
        raw=b64({'alg':'HS256','typ':'JWT'})+'.'+b64({'role':'anon','exp':self.now+3600})
        api=raw+'.'+base64.urlsafe_b64encode(hmac.digest(self.secret,raw.encode(),'sha256')).decode().rstrip('=')
        def source(name,data):
            p=self.root/name;p.write_bytes(data);p.chmod(0o600);return {'path':str(p),'sha256':issuer.sha(data)}
        ca=source('ca.pem',self.cert.read_bytes())
        service=f"[axiom-controller-issuer]\nhost=localhost\nport=5432\ndbname=postgres\nuser=issuer\npassword=synthetic-only\nsslmode=verify-full\nsslrootcert={ca['path']}\nconnect_timeout=5\n".encode()
        self.settings={'schemaVersion':1,'psql':str(Path(shutil.which('true')).resolve()),'service':source('pg-service.conf',service),'apiKey':source('anon.key',api.encode()),'signingKey':source('signer.key',self.secret),'backendCa':ca,'databaseCa':ca,'backendOrigin':'https://localhost'}
        self.config.write_bytes(issuer.encode(self.settings));self.config.chmod(0o600)
        self.value={'schemaVersion':1,'purpose':'controller-backend-issue','credentialId':str(uuid.uuid4()),'tenantId':str(uuid.uuid4()),'configurationSha256':issuer.sha(self.config.read_bytes()),'approvalReference':str(uuid.uuid4()),'predecessorId':None,'issuedAt':self.now,'expiresAt':self.now+3600}
        self.save()
    def save(self):
        self.review.write_bytes(issuer.encode(self.value));self.review.chmod(0o600);self.expected=issuer.sha(self.review.read_bytes())
    def db(self,settings,op,raw,expected,v):
        self.calls.append(op)
        return {'schemaVersion':1,'credentialId':v['credentialId'],'tenantId':v['tenantId'],'requestSha256':expected,'predecessorId':v['predecessorId'],'issuedAt':v['issuedAt'],'expiresAt':v['expiresAt'],'status':'active' if self.active else 'revoked'}
    def probe(self,settings,data,tenant):self.probes.append(tenant)
    def issue(self,**kwargs):return issuer.issue(self.review,self.expected,self.config,self.target,db=self.db,backend=self.probe,**kwargs)
    def test_completed_private_bundle_is_explicitly_resumable_without_changing_bytes(self):
        self.issue();self.assertEqual(self.calls,['issue','status']);self.assertEqual(self.probes,[self.value['tenantId']])
        self.assertEqual({p.name for p in self.target.iterdir()},{'lock','request.json','intent.json','backend.key','ready.json'})
        before={p.name:(p.stat().st_ino,p.read_bytes()) for p in self.target.iterdir()}
        self.issue(resume=True);self.assertEqual(before,{p.name:(p.stat().st_ino,p.read_bytes()) for p in self.target.iterdir()})
        self.assertEqual({p.stat().st_mode&511 for p in self.target.iterdir()},{0o600});self.assertEqual(self.target.stat().st_mode&511,0o700)
        token=json.loads((self.target/'backend.key').read_bytes())['accessToken'];claims=issuer.jwt_parts(token)[2]
        self.assertEqual(claims,{'role':issuer.ROLE,'sub':self.value['credentialId'],'tenant_id':self.value['tenantId'],'iat':self.now,'exp':self.now+3600})
        with self.assertRaises(FileExistsError):self.issue()
    def test_unknown_database_outcome_preserves_intent_for_explicit_same_request_resume(self):
        with patch.object(self,'db',side_effect=TimeoutError()):
            with self.assertRaises(TimeoutError):self.issue()
        self.assertTrue((self.target/'candidate.key').exists());self.assertFalse((self.target/'ready.json').exists())
        self.issue(resume=True);self.assertTrue((self.target/'ready.json').exists())
    def test_backend_denial_or_post_probe_revocation_does_not_publish(self):
        with patch.object(self,'probe',side_effect=ValueError()):
            with self.assertRaises(ValueError):self.issue()
        self.assertFalse((self.target/'backend.key').exists())
        def revoke_during_probe(*args):self.active=False
        with patch.object(self,'probe',side_effect=revoke_during_probe):
            with self.assertRaises(ValueError):self.issue(resume=True)
        self.assertFalse((self.target/'ready.json').exists())
    def test_resume_never_changes_lease_or_repairs_partial_files(self):
        with patch.object(self,'db',side_effect=TimeoutError()):
            with self.assertRaises(TimeoutError):self.issue()
        before=(self.target/'candidate.key').read_bytes();self.value['expiresAt']-=1;self.save()
        with self.assertRaises(ValueError):self.issue(resume=True)
        self.assertEqual(before,(self.target/'candidate.key').read_bytes())
        (self.target/'intent.json').unlink()
        with self.assertRaises(ValueError):self.issue(resume=True)
    def test_publication_crash_is_resumable_only_with_unchanged_complete_preparation(self):
        original=issuer.create
        def fail(path,data):
            if path.name=='ready.json':raise OSError('interrupted')
            original(path,data)
        with patch.object(issuer,'create',side_effect=fail):
            with self.assertRaises(OSError):self.issue()
        self.assertTrue((self.target/'backend.key').exists());self.assertFalse((self.target/'ready.json').exists())
        self.issue(resume=True)
        self.assertTrue((self.target/'ready.json').exists())
    def test_foreign_or_changed_database_receipt_refused(self):
        original=self.db
        def wrong(*args):return {**original(*args),'tenantId':str(uuid.uuid4())}
        with patch.object(self,'db',side_effect=wrong):
            with self.assertRaises(ValueError):self.issue()
        self.assertEqual(self.probes,[])
    def test_input_change_after_probe_refuses_publication(self):
        def changed(*args):Path(self.settings['signingKey']['path']).write_bytes(b'changed')
        with patch.object(self,'probe',side_effect=changed):
            with self.assertRaises(ValueError):self.issue()
        self.assertFalse((self.target/'ready.json').exists())
    def test_strict_review_time_fields_and_digest(self):
        mutations=[lambda v:v.update(issuedAt=True),lambda v:v.update(expiresAt=v['issuedAt']+3601),lambda v:v.update(credentialId='00000000-0000-0000-0000-000000000000'),lambda v:v.update(extra='unknown'),lambda v:v.update(predecessorId=v['credentialId']),lambda v:v.update(configurationSha256='x')]
        for mutation in mutations:
            value=copy.deepcopy(self.value);mutation(value);raw=issuer.encode(value)
            with self.assertRaises((ValueError,TypeError)):issuer.request(raw,issuer.sha(raw),'issue')
        with self.assertRaises(ValueError):issuer.request(self.review.read_bytes(),'0'*64,'issue')
        raw=self.review.read_bytes().replace(b'"schemaVersion":1',b'"schemaVersion":1,"schemaVersion":1')
        with self.assertRaises(ValueError):issuer.request(raw,issuer.sha(raw),'issue')
        self.value['issuedAt']+=3601;self.value['expiresAt']+=3601;self.save()
        with self.assertRaises(ValueError):self.issue()
        self.assertFalse(self.target.exists());self.assertEqual(self.calls,[])
    def test_symlink_hardlink_and_file_modes_refused_before_mutation(self):
        key=Path(self.settings['signingKey']['path']);key.chmod(0o644)
        with self.assertRaises(ValueError):self.issue()
        key.chmod(0o600);link=self.root/'duplicate';os.link(key,link)
        with self.assertRaises(ValueError):self.issue()
        link.unlink();key.rename(link);key.symlink_to(link)
        with self.assertRaises(OSError):self.issue()
        self.assertEqual(self.calls,[]);self.assertFalse(self.target.exists())
    def test_configuration_tls_protection_and_signing_authority_mismatch(self):
        file=Path(self.settings['service']['path']);file.write_text(file.read_text().replace('verify-full','prefer'));self.settings['service']['sha256']=issuer.sha(file.read_bytes());self.config.write_bytes(issuer.encode(self.settings));self.value['configurationSha256']=issuer.sha(self.config.read_bytes());self.save()
        with self.assertRaises(ValueError):self.issue()
        self.assertEqual(self.calls,[])
    def test_wrong_signer_refused(self):
        p=Path(self.settings['signingKey']['path']);p.write_bytes(b'y'*64);self.settings['signingKey']['sha256']=issuer.sha(p.read_bytes());self.config.write_bytes(issuer.encode(self.settings));self.value['configurationSha256']=issuer.sha(self.config.read_bytes());self.save()
        with self.assertRaises(ValueError):self.issue()
        self.assertEqual(self.calls,[])
    def test_receipt_strict_types_and_fields(self):
        good=self.db(self.settings,'issue',b'',self.expected,self.value)
        for change in ({'schemaVersion':True},{'issuedAt':True},{'expiresAt':0},{'extra':1},{'status':'unknown'}):
            with self.assertRaises(ValueError):issuer.checked_receipt({**good,**change})
    def test_revoke_needs_no_signing_or_gateway_key_access_and_resumes(self):
        good=self.db(self.settings,'issue',b'',self.expected,self.value);good['status']='revoked'
        issuance=self.expected
        self.value={k:v for k,v in self.value.items() if k not in ('predecessorId','issuedAt','expiresAt')}
        self.value.update(purpose='controller-backend-revoke',issuanceSha256=issuance);self.save()
        Path(self.settings['signingKey']['path']).unlink();Path(self.settings['apiKey']['path']).unlink()
        def db(*args):return good
        issuer.revoke(self.review,self.expected,self.config,self.target,db=db)
        issuer.revoke(self.review,self.expected,self.config,self.target,resume=True,db=db)
        self.assertEqual(json.loads((self.target/'ready.json').read_bytes()),good)
        self.assertFalse((self.target/'backend.key').exists())
    def test_service_rejects_socket_multihost_and_tls_bypass(self):
        file=Path(self.settings['service']['path']);original=file.read_text()
        for host in ('/var/run/postgresql','localhost,attacker','localhost hostaddr=127.0.0.1'):
            file.write_text(original.replace('host=localhost','host='+host));self.settings['service']['sha256']=issuer.sha(file.read_bytes());self.config.write_bytes(issuer.encode(self.settings))
            with self.assertRaises(ValueError):issuer.configuration(self.config,issuer.sha(self.config.read_bytes()))
    def test_database_subprocess_uses_only_fixed_environment_and_bounded_output(self):
        script=self.root/'fake-psql';script.write_text('#!'+str(Path(sys.executable).resolve())+'\nimport os,sys,json\nassert set(os.environ) <= {"PATH","HOME","LC_ALL","PGSERVICEFILE","PGSYSCONFDIR","PGPASSFILE","PGGSSENCMODE","LC_CTYPE","__CF_USER_TEXT_ENCODING"}\nassert os.environ["PGGSSENCMODE"]=="disable"\nassert "set local role axiom_controller_issuer" in sys.stdin.read()\nprint(json.dumps({"ok":True}))\n');script.chmod(0o700)
        settings={**self.settings,'psql':str(script)}
        self.assertEqual(issuer.database(settings,'issue',self.review.read_bytes(),self.expected,self.value),{'ok':True})
        script.write_text('#!'+str(Path(sys.executable).resolve())+'\nimport sys\nsys.stdin.read()\nprint("x"*4097)\n')
        with self.assertRaises(ValueError):issuer.database(settings,'issue',self.review.read_bytes(),self.expected,self.value)
    def test_expired_resume_does_not_contact_database_or_change_saved_bundle(self):
        self.issue();before={p.name:p.read_bytes() for p in self.target.iterdir()};self.calls.clear()
        with patch.object(issuer.time,'time',return_value=self.value['expiresAt']):
            with self.assertRaises(ValueError):self.issue(resume=True)
        self.assertEqual(self.calls,[]);self.assertEqual(before,{p.name:p.read_bytes() for p in self.target.iterdir()})
    def test_real_https_probe_rejects_redirect_foreign_scope_and_oversized_response(self):
        import http.server,ssl,threading,urllib.error
        mode=['ok'];tenant=self.value['tenantId']
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                data=issuer.encode(tenant if mode[0]=='ok' else str(uuid.uuid4()))
                if mode[0]=='large':data=b'x'*4097
                self.send_response(302 if mode[0]=='redirect' else 200)
                if mode[0]=='redirect':self.send_header('Location','http://127.0.0.1:1/leak')
                self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(self.cert,self.key)
        server.socket=context.wrap_socket(server.socket,server_side=True)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        settings={**self.settings,'backendOrigin':f'https://localhost:{server.server_address[1]}'};data=issuer.credential(self.value,settings)
        try:
            issuer.probe(settings,data,tenant)
            for value in ('redirect','foreign','large'):
                mode[0]=value
                with self.assertRaises(ValueError):issuer.probe(settings,data,tenant)
            mode[0]='ok';settings['backendOrigin']=f'https://127.0.0.1:{server.server_address[1]}'
            with self.assertRaises(urllib.error.URLError) as failure:issuer.probe(settings,data,tenant)
            self.assertIsInstance(failure.exception.reason,ssl.SSLCertVerificationError)
        finally:server.shutdown();server.server_close();worker.join(timeout=2)
    def test_output_lock_refuses_parallel_mutation(self):
        self.issue()
        with issuer.directory(self.target,False):
            with self.assertRaises(BlockingIOError):self.issue(resume=True)
    def test_cli_fixed_error_never_echoes_private_input(self):
        result=subprocess.run([sys.executable,'-I',str(ROOT/'infra/credential-issuer/issuer.py'),'--issue',str(self.review),'0'*64,str(self.config),str(self.target)],capture_output=True,timeout=5)
        self.assertEqual(result.returncode,1);self.assertEqual(result.stdout,b'');self.assertNotIn(self.secret,result.stderr);self.assertNotIn(str(self.review).encode(),result.stderr)

if __name__=='__main__':unittest.main()
