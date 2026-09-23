"""Protected host-to-container mapping refuses conflicting or stale runtime state."""
import copy
import io
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'infra/workload'))
import spire_volumes as volumes

SHA='a'*64
BINDING={'schemaVersion':1,'role':'runner','filesystemUuid':'11111111-1111-4111-8111-111111111111','trustDomain':'test.axiomproof.test','nodeId':'spiffe://test.axiomproof.test/spire/agent/gcp_iit/axiom-test/123'}
IDENTITY={'workload':{'device':1,'inode':2},'health':{'device':1,'inode':3}}

class VolumesTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.record=Path(self.temp.name)/'review.json';self.present=set();self.created=[]
        for p in (patch.object(volumes,'RECORD',self.record),patch.object(volumes,'live',return_value=(BINDING,IDENTITY)),patch.object(volumes,'listed',side_effect=lambda:self.present),patch.object(volumes,'inspect'),patch.object(volumes,'docker',side_effect=self.docker),patch.object(volumes.host,'OWNER',os.geteuid()),patch.object(volumes.host,'protected_directory')):
            p.start();self.addCleanup(p.stop)

    def docker(self,*args):
        self.assertEqual(args[:2],('volume','create'))
        self.assertTrue(self.record.exists())
        self.present.add(args[-1]);self.created.append(args[-1]);return (args[-1]+'\n').encode()

    def test_review_precedes_creation_and_identical_retry_does_not_recreate(self):
        expected=volumes.prepare(SHA);inode=self.record.stat().st_ino
        self.assertEqual(len(self.created),2)
        self.assertEqual(expected,json.loads(self.record.read_text()))
        self.assertEqual(volumes.prepare(SHA),expected)
        self.assertEqual(len(self.created),2);self.assertEqual(self.record.stat().st_ino,inode)
        self.assertEqual(volumes.prepare(SHA,check=True),expected)
        self.assertEqual(len(self.created),2)

    def test_conflict_in_second_volume_refuses_all_writes(self):
        mapping=volumes.mapping(BINDING,SHA);self.present.add(mapping['volumes']['health']['Name'])
        with patch.object(volumes,'inspect',side_effect=ValueError('conflict')):
            with self.assertRaises(ValueError):volumes.prepare(SHA)
        self.assertFalse(self.record.exists());self.assertEqual(self.created,[])

    def test_check_never_creates_absent_volumes_or_review(self):
        with self.assertRaises(ValueError):volumes.prepare(SHA,check=True)
        self.assertFalse(self.record.exists());self.assertEqual(self.created,[])
        self.present.update(v['Name'] for v in volumes.mapping(BINDING,SHA)['volumes'].values())
        with self.assertRaises(ValueError):volumes.prepare(SHA,check=True)
        self.assertFalse(self.record.exists())

    def test_partial_creation_keeps_review_for_explicit_identical_retry(self):
        def partial(*args):
            if self.created:raise ValueError('daemon unavailable')
            return self.docker(*args)
        with patch.object(volumes,'docker',side_effect=partial):
            with self.assertRaises(ValueError):volumes.prepare(SHA)
        self.assertEqual(len(self.created),1);before=self.record.read_bytes()
        volumes.prepare(SHA)
        self.assertEqual(len(self.created),2);self.assertEqual(self.record.read_bytes(),before)

    def test_stale_or_changed_source_never_claims_success(self):
        changed=copy.deepcopy(IDENTITY);changed['workload']['inode']+=1
        with patch.object(volumes,'live',side_effect=[(BINDING,IDENTITY),(BINDING,IDENTITY),(BINDING,changed)]):
            with self.assertRaises(ValueError):volumes.prepare(SHA)
        self.assertTrue(self.record.exists());self.assertEqual(len(self.created),2)

    def test_foreign_review_is_preserved_without_mutation(self):
        self.record.write_text('{}');self.record.chmod(0o600)
        with self.assertRaises(ValueError):volumes.prepare(SHA)
        self.assertEqual(self.record.read_text(),'{}');self.assertEqual(self.created,[])

    def test_manifest_and_node_binding_are_not_arbitrary_paths(self):
        with self.assertRaises(ValueError):volumes.mapping({**BINDING,'role':'issuer'},SHA)
        with self.assertRaises(ValueError):volumes.mapping(BINDING,'../manifest')
        with self.assertRaises(ValueError):volumes.mapping({**BINDING,'filesystemUuid':'../state'},SHA)
        result=volumes.mapping(BINDING,SHA)
        self.assertEqual({v['Options']['device'] for v in result['volumes'].values()},{'/run/workload','/run/spire-health'})

class InspectTests(unittest.TestCase):
    def test_foreign_driver_options_labels_or_mount_root_are_refused(self):
        expected=volumes.mapping(BINDING,SHA)['volumes']['workload']
        correct={**expected,'Mountpoint':'/var/lib/docker/volumes/'+expected['Name']+'/_data'}
        for field,value in (('Driver','foreign'),('Scope','global'),('Options',{}),('Labels',{}),('Mountpoint','/other')):
            with patch.object(volumes,'docker',return_value=json.dumps([{**correct,field:value}]).encode()):
                with self.assertRaises(ValueError):volumes.inspect(expected)

    def test_unmounted_matching_mapping_is_read_only_inspection(self):
        expected=volumes.mapping(BINDING,SHA)['volumes']['workload']
        correct={**expected,'Mountpoint':'/var/lib/docker/volumes/'+expected['Name']+'/_data'}
        with patch.object(volumes,'docker',return_value=json.dumps([correct]).encode()) as docker,patch.object(volumes.host,'protected_directory'),patch('builtins.open',return_value=io.StringIO('')):
            volumes.inspect(expected)
            docker.assert_called_once_with('volume','inspect',expected['Name'])

class MountedMappingTests(unittest.TestCase):
    def test_foreign_daemon_namespace_cannot_hide_active_mounts(self):
        for inode,owner in ((2,0),(3,0),(2,99)):
            with patch.object(volumes.enrollment,'command',return_value=b'123\n'),patch.object(Path,'stat',side_effect=[SimpleNamespace(st_uid=owner),SimpleNamespace(st_dev=1,st_ino=inode),SimpleNamespace(st_dev=1,st_ino=2)]):
                if inode==2 and owner==0:volumes.daemon_namespace()
                else:
                    with self.assertRaises(ValueError):volumes.daemon_namespace()
        with patch.object(volumes.enrollment,'command',return_value=b'0\n'):
            with self.assertRaises(ValueError):volumes.daemon_namespace()

    def test_active_bind_requires_original_inode_and_read_only_flags(self):
        expected=volumes.mapping(BINDING,SHA)['volumes']['workload']
        target='/var/lib/docker/volumes/'+expected['Name']+'/_data'
        correct={**expected,'Mountpoint':target}
        def attempt(inode,options,nested=False):
            line=f'40 30 0:20 /workload {target} {options} - tmpfs tmpfs rw\n'
            if nested:line+=f'41 40 0:21 /api {target}/api.sock ro,nosuid,nodev,noexec - tmpfs tmpfs rw\n'
            with patch.object(volumes,'docker',return_value=json.dumps([correct]).encode()),patch.object(volumes.host,'protected_directory'),patch('builtins.open',return_value=io.StringIO(line)),patch.object(Path,'stat',side_effect=[SimpleNamespace(st_dev=1,st_ino=inode),SimpleNamespace(st_dev=1,st_ino=2)]):
                volumes.inspect(expected)
        attempt(2,'ro,nosuid,nodev,noexec')
        with self.assertRaises(ValueError):attempt(3,'ro,nosuid,nodev,noexec')
        with self.assertRaises(ValueError):attempt(2,'rw,nosuid,nodev,noexec')
        with self.assertRaises(ValueError):attempt(2,'ro,nosuid,nodev')
        with self.assertRaises(ValueError):attempt(2,'ro,nosuid,nodev,noexec',nested=True)

    def test_live_mapping_refuses_stale_future_or_foreign_health(self):
        now=100000
        correct={'schemaVersion':1,'healthy':True,'nodeId':BINDING['nodeId'],'observedAtMs':now-1000,'syncAtMs':now-2000,'certificateExpiresAtMs':now+60000}
        def attempt(value):
            with patch.object(volumes.enrollment,'installed',return_value=BINDING),patch.object(volumes.state,'check'),patch.object(volumes,'active'),patch.object(volumes,'sources',return_value=IDENTITY),patch.object(volumes.host,'read_file',return_value=json.dumps(value).encode()),patch.object(volumes.time,'time_ns',return_value=now*1000000):
                return volumes.live(SHA)
        self.assertEqual(attempt(correct),(BINDING,IDENTITY))
        for key,value in (('observedAtMs',now-10000),('observedAtMs',now+1),('syncAtMs',now-30000),('syncAtMs',now),('certificateExpiresAtMs',now),('nodeId',BINDING['nodeId']+'-other'),('healthy',False),('schemaVersion',True)):
            with self.subTest(field=key),self.assertRaises(ValueError):attempt({**correct,key:value})

if __name__=='__main__':unittest.main()
