"""Review-bound controller files: no startup authority, silent repair or disclosure."""
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'infra/workload'))
import controller_files as files

TENANT='11111111-1111-4111-8111-111111111111'
BINDING={'schemaVersion':1,'role':'runner','filesystemUuid':TENANT,'trustDomain':'local.axiomproof.test','nodeId':'spiffe://local.axiomproof.test/spire/agent/gcp_iit/axiom-test/123'}
SHA='a'*64

def configuration():
    return {'controller':{'schemaVersion':1,'tenantId':TENANT,'trustDomain':BINDING['trustDomain'],'workloadSocket':'/run/workload/api.sock','issuerNodeId':BINDING['nodeId'],'namespace':'fixture','launcher':{'executable':'/usr/bin/docker','dockerHost':'unix:///run/docker.sock','image':'sha256:'+'b'*64,'workloadApiVolume':'axiom-workload-api-'+TENANT},'keys':{'provider':'aws','primary':'fixture','retiring':[]},'scheduler':{'audience':'https://controller.fixture.test:8443','subject':'123','email':'fixture@example.test'}},'listen':{'host':'0.0.0.0','port':8443},'tls':{'keyFile':'/run/controller-secrets/tls.key','certFile':'/run/controller-secrets/tls.crt'},'backendServiceKeyFile':'/run/controller-secrets/backend.key'}

class ControllerFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.source=self.root/'source';self.source.mkdir()
        for p in (patch.object(files,'ROOT',self.root/'controllers'),patch.object(files,'UID',os.geteuid()),patch.object(files,'GID',os.getegid()),patch.object(files.host,'OWNER',os.geteuid()),patch.object(files.host,'protected_directory'),patch.object(files.enrollment,'installed',return_value=BINDING)):
            p.start();self.addCleanup(p.stop)
        self.root.chmod(0o755)
        self.config=configuration();self.rebuild()

    def rebuild(self):
        payload={'service.json':json.dumps(self.config).encode(),'backend.key':b'synthetic-private-key-not-real-00000000','tls.key':b'synthetic-tls-private-not-real','tls.crt':b'synthetic-certificate-not-real'}
        self.review={'schemaVersion':1,'tenantId':TENANT,'spireManifestSha256':SHA,'controllerImage':'sha256:'+'c'*64,'files':{name:files.digest(data) for name,data in payload.items()}}
        self.raw=files.enrollment.encode(self.review);self.expected=files.digest(self.raw)
        for name,data in {'manifest.json':self.raw,**payload}.items():
            (self.source/name).write_bytes(data);(self.source/name).chmod(0o600)
        self.directory=files.ROOT/TENANT/self.expected

    def install(self):return files.install(self.source,self.expected)

    def test_delivery_is_private_read_only_idempotent_and_checkable_without_source(self):
        path=self.install();before={p.name:p.stat().st_ino for p in path.iterdir()}
        self.assertEqual(path,self.directory/'files');self.assertEqual((self.directory/'manifest.json').read_bytes(),self.raw)
        self.assertEqual({p.stat().st_mode&511 for p in path.iterdir()},{0o400})
        self.assertEqual({p.stat().st_uid for p in path.iterdir()},{os.geteuid()})
        self.assertEqual(self.install(),path)
        self.assertEqual(before,{p.name:p.stat().st_ino for p in path.iterdir()})
        self.assertEqual(files.check(TENANT,self.expected),path)
        self.assertEqual(set(p.name for p in self.directory.iterdir()),{'manifest.json','ready.json','files'})

    def test_unreviewed_digest_and_altered_source_refuse_before_destination(self):
        with self.assertRaises(ValueError):files.install(self.source,'0'*64)
        (self.source/'backend.key').write_bytes(b'changed')
        with self.assertRaises(ValueError):self.install()
        self.assertFalse(files.ROOT.exists())

    def test_wrong_node_tenant_socket_volume_or_secret_path_refuses_all_writes(self):
        original=copy.deepcopy(self.config)
        mutations=[lambda c:c['controller'].update(tenantId='22222222-2222-4222-8222-222222222222'),lambda c:c['controller'].update(issuerNodeId=BINDING['nodeId']+'0'),lambda c:c['controller'].update(workloadSocket='/tmp/api.sock'),lambda c:c['controller']['launcher'].update(workloadApiVolume='other'),lambda c:c.update(backendServiceKeyFile='/tmp/key'),lambda c:c['tls'].update(keyFile='/tmp/tls.key'),lambda c:c['listen'].update(port=4444)]
        for change in mutations:
            self.config=copy.deepcopy(original);change(self.config);self.rebuild()
            with self.assertRaises(ValueError):self.install()
            self.assertFalse(files.ROOT.exists())

    def test_manifest_precedes_private_writes_and_receipt_is_last(self):
        original=files.enrollment.create;order=[]
        def create(path,data):
            order.append(path.name)
            if path.name=='manifest.json':self.assertFalse((self.directory/'files').exists())
            else:
                self.assertEqual(set(p.name for p in (self.directory/'files').iterdir()),set(files.FILES))
            original(path,data)
        with patch.object(files.enrollment,'create',side_effect=create):self.install()
        self.assertEqual(order,['manifest.json','ready.json'])

    def test_partial_generation_is_preserved_and_never_repaired(self):
        with patch.object(files.os,'fchown',side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):self.install()
        before={str(p):p.stat().st_ino for p in self.directory.rglob('*')}
        with self.assertRaises(ValueError):self.install()
        self.assertEqual(before,{str(p):p.stat().st_ino for p in self.directory.rglob('*')})
        self.assertFalse((self.directory/'ready.json').exists())

    def test_changed_binding_prevents_completion_receipt(self):
        with patch.object(files.enrollment,'installed',side_effect=[BINDING,{**BINDING,'nodeId':BINDING['nodeId']+'0'}]):
            with self.assertRaises(ValueError):self.install()
        self.assertFalse((self.directory/'ready.json').exists())

    def test_changed_file_mode_content_link_or_private_ancestry_refuses_check(self):
        path=self.install();key=path/'backend.key';before=key.read_bytes()
        key.chmod(0o600)
        with self.assertRaises(ValueError):files.check(TENANT,self.expected)
        key.write_bytes(b'changed');key.chmod(0o400)
        with self.assertRaises(ValueError):files.check(TENANT,self.expected)
        key.chmod(0o600);key.write_bytes(before);key.chmod(0o400);os.link(key,self.root/'link')
        with self.assertRaises(ValueError):files.check(TENANT,self.expected)
        (self.root/'link').unlink();files.ROOT.chmod(0o755)
        with self.assertRaises(ValueError):files.check(TENANT,self.expected)

    def test_unknown_inventory_and_manifest_duplicate_keys_refused(self):
        (self.source/'extra').write_text('unexpected')
        with self.assertRaises(ValueError):self.install()
        (self.source/'extra').unlink()
        bad=b'{"schemaVersion":1,"schemaVersion":1}'
        (self.source/'manifest.json').write_bytes(bad)
        with self.assertRaises(ValueError):files.install(self.source,files.digest(bad))

    def test_service_paths_are_fixed_and_foreign_image_format_refused(self):
        for field,value in [('tenantId','../tenant'),('controllerImage','controller:latest'),('spireManifestSha256','../manifest')]:
            review={**self.review,field:value}
            with self.assertRaises((ValueError,TypeError)):files.manifest(review)

    def test_source_symlink_and_hardlink_refused(self):
        key=self.source/'backend.key';key.rename(self.root/'saved');key.symlink_to(self.root/'saved')
        with self.assertRaises(OSError):files.bundle(self.source,self.expected)
        key.unlink();os.link(self.root/'saved',key)
        with self.assertRaises(ValueError):files.bundle(self.source,self.expected)

if __name__=='__main__':unittest.main()
