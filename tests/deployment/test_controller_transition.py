"""Real private journals/files; systemd, Docker and installed SPIRE are injected.

Only fixture ancestry above the temporary directory is excluded from host checks.
Native hosted acceptance separately uses actual root/systemd/Docker boundaries.
"""
import contextlib
import copy
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'infra/workload'))
import controller_transition as transition
runtime=transition.runtime
e=transition.enrollment
h=transition.host
TENANT='11111111-1111-4111-8111-111111111111'

class ControllerTransitionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.profiles=self.root/'profiles';self.profiles.mkdir(mode=0o700)
        self.units=self.root/'units';self.units.mkdir(mode=0o700)
        self.journals=self.root/'transitions';self.state=self.root/'state'
        self.responses={};self.system={};self.commands=[]
        def protected(path):
            for parent in (path,*path.parents):
                if parent==self.root.parent:break
                info=parent.lstat()
                if parent.resolve(strict=True)!=parent or not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o022:raise ValueError('fixture directory refused')
        for replacement in (patch.object(h,'OWNER',os.geteuid()),patch.object(h,'protected_directory',side_effect=protected),patch.object(runtime,'PROFILES',self.profiles),patch.object(runtime,'STATE',self.state),patch.object(runtime,'UNITS',self.units),patch.object(transition,'ROOT',self.journals),patch.object(e,'exclusive',side_effect=contextlib.nullcontext),patch.object(runtime.files,'check',return_value=self.root),patch.object(e,'control',side_effect=self.control),patch.object(runtime,'observation',side_effect=self.observe)):
            replacement.start();self.addCleanup(replacement.stop)
        self.old,self.old_sha=self.make_profile('old','a'*64)
        self.new,self.new_sha=self.make_profile('next','b'*64)
        self.profiles.joinpath(self.old_sha+'.json').write_bytes(self.old.read_bytes());self.profiles.joinpath(self.old_sha+'.json').chmod(0o600)
        self.unit=transition.unit_path(TENANT);self.loaded=runtime.unit(json.loads(self.old.read_bytes()),self.old_sha);self.save(self.unit,self.loaded)
        self.value={'schemaVersion':1,'tenantId':TENANT,'approvalReference':str(uuid.uuid4()),'previousTransitionSha256':None,'previousProfileSha256':self.old_sha,'nextProfileFile':str(self.new),'nextProfileSha256':self.new_sha,'previousGenerationSha256':'a'*64,'nextGenerationSha256':'b'*64}
        self.review=self.root/'review.json';self.save_review()
        with runtime.locked(TENANT):pass
        self.attempt=self.make_attempt()
    def save(self,path,data):path.write_bytes(data);path.chmod(0o600)
    def make_profile(self,name,generation):
        placed=self.root/(name+'-placement.json');self.save(placed,e.encode({'schemaVersion':1,'tenantId':TENANT,'controllerManifestSha256':generation,'zone':'asia-south1-a','privateIp':'10.0.0.11'}))
        value={'schemaVersion':1,'tenantId':TENANT,'placementFile':str(placed),'placementSha256':e.digest(placed.read_bytes()),'backendUrl':'https://backend.example.test'}
        path=self.root/(name+'.json');self.save(path,e.encode(value));return path,e.digest(path.read_bytes())
    def save_review(self):self.save(self.review,e.encode(self.value));self.sha=e.digest(self.review.read_bytes())
    def make_attempt(self):
        identifier=str(uuid.uuid4());container=e.digest(identifier.encode());directory=self.state/TENANT/identifier;directory.mkdir(mode=0o700)
        spec={'name':'axiom-controller-'+identifier,'image':'sha256:'+'c'*64,'labels':{runtime.LABEL+'attempt':identifier,runtime.LABEL+'tenant':TENANT,runtime.LABEL+'profile':self.old_sha}}
        self.save(directory/'intent.json',e.encode({'schemaVersion':1,'profileSha256':self.old_sha,'spec':spec}))
        for name in ('container.json','start.json','stopped.json'):self.save(directory/name,e.encode({'schemaVersion':1,'containerId':container}))
        self.responses[container]={'Id':container,'Name':'/'+spec['name'],'Image':spec['image'],'Config':{'Labels':spec['labels']},'State':{'Running':False,'Status':'exited'}}
        return directory
    def observe(self,*args):
        self.assertEqual(args[:2],('container','inspect'));return self.responses[args[2]]
    def control(self,*args):
        self.commands.append(args);self.assertEqual(args[0],'show');self.assertEqual(args[-1],self.unit.name)
        values={'LoadState':'loaded','ActiveState':'inactive','MainPID':'0','Job':'','UnitFileState':'disabled','FragmentPath':str(self.unit),'DropInPaths':'','NeedDaemonReload':'no' if self.loaded==self.unit.read_bytes() else 'yes','Transient':'no',**self.system}
        return '\n'.join(k+'='+v for k,v in values.items()).encode()
    def step(self,mode='publish'):transition.transition(self.review,self.sha,mode)
    @property
    def journal(self):return self.journals/TENANT/self.sha
    def confirm(self):self.loaded=self.unit.read_bytes();self.step('confirm')
    def admit(self,sha):transition.admit(TENANT,sha,self.state/TENANT)
    def test_publish_blocks_both_generations_until_explicit_reload_and_confirmation(self):
        self.step();self.assertFalse((self.journal/'confirmed.json').exists())
        with self.assertRaises(ValueError):self.step('confirm')
        for sha in (self.old_sha,self.new_sha):
            with self.assertRaises(ValueError):self.admit(sha)
        self.confirm();self.admit(self.new_sha)
        with self.assertRaises(ValueError):self.admit(self.old_sha)
        self.assertEqual(len(transition.history(TENANT)),1)
        self.assertTrue(all(p.stat().st_mode&511==0o600 for p in self.journal.iterdir()))
        self.assertTrue(all(c[0]=='show' for c in self.commands))
        before={p.name:(p.stat().st_ino,p.read_bytes()) for p in self.journal.iterdir()};self.step('confirm');self.step('resume')
        self.assertEqual(before,{p.name:(p.stat().st_ino,p.read_bytes()) for p in self.journal.iterdir()})
    def test_active_enabled_queued_overridden_and_stale_loaded_unit_refused_before_mutation(self):
        for key,value in [('ActiveState','active'),('MainPID','42'),('Job','7'),('UnitFileState','enabled'),('FragmentPath','/run/foreign.service'),('DropInPaths','/etc/override.conf'),('NeedDaemonReload','yes'),('Transient','yes'),('LoadState','masked')]:
            with self.subTest(key=key):
                self.system={key:value}
                with self.assertRaises(ValueError):self.step()
                self.assertFalse(self.journals.exists());self.assertEqual(self.unit.read_bytes(),self.loaded)
    def test_saved_stop_receipt_does_not_hide_live_foreign_or_uncertain_container(self):
        container=next(iter(self.responses));original=copy.deepcopy(self.responses[container])
        for change in ({'State':{'Running':True,'Status':'running'}},{'State':{'Running':False,'Status':'created'}},{'Config':{'Labels':{}}},{'Id':'d'*64}):
            self.responses[container]={**original,**change}
            with self.assertRaises(ValueError):self.step()
            self.assertFalse(self.journals.exists())
        self.responses.clear()
        with self.assertRaises(KeyError):self.step()
    def test_missing_stop_and_incomplete_container_journals_refuse_without_cleanup(self):
        (self.attempt/'stopped.json').unlink()
        with self.assertRaises(ValueError):self.step()
        self.assertTrue((self.attempt/'intent.json').exists());self.assertFalse(self.journals.exists())
        (self.attempt/'container.json').unlink()
        with self.assertRaises(ValueError):self.step()
    def test_interrupted_atomic_replace_resumes_only_exact_prepared_request(self):
        with patch.object(transition.os,'replace',side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):self.step()
        self.assertEqual(self.unit.read_bytes(),self.loaded);self.assertTrue((self.journal/'prepared.json').exists())
        self.step('resume');self.confirm();self.admit(self.new_sha)
    def test_crash_after_replace_is_reconciled_without_overwriting_unit(self):
        original=e.create
        def fail(path,data):
            if path.name=='published.json':raise OSError('interrupted')
            original(path,data)
        with patch.object(e,'create',side_effect=fail):
            with self.assertRaises(OSError):self.step()
        self.assertNotEqual(self.unit.read_bytes(),self.loaded)
        with patch.object(transition.os,'replace',side_effect=AssertionError('must not overwrite')):self.step('resume')
        self.confirm()
    def test_partial_preparation_preserved_and_cannot_be_repaired_or_started(self):
        original=e.create
        def fail(path,data):
            if path.name=='prepared.json':raise OSError('interrupted')
            original(path,data)
        with patch.object(e,'create',side_effect=fail):
            with self.assertRaises(OSError):self.step()
        before={p.name:p.read_bytes() for p in self.journal.iterdir()}
        with self.assertRaises(ValueError):self.step('resume')
        with self.assertRaises(ValueError):self.admit(self.old_sha)
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.journal.iterdir()})
    def test_competing_branch_stale_review_and_explicit_reverse_transition(self):
        self.step();self.confirm();first=self.sha
        with self.assertRaises(ValueError):self.step('publish')
        self.value.update(previousTransitionSha256=first,previousProfileSha256=self.new_sha,nextProfileFile=str(self.old),nextProfileSha256=self.old_sha,previousGenerationSha256='b'*64,nextGenerationSha256='a'*64,approvalReference=str(uuid.uuid4()));self.save_review()
        self.step();self.confirm();self.admit(self.old_sha)
        with self.assertRaises(ValueError):self.admit(self.new_sha)
        self.assertEqual(len(transition.history(TENANT)),2)
        self.value['previousTransitionSha256']=first;self.value['approvalReference']=str(uuid.uuid4());self.save_review()
        with self.assertRaises(ValueError):self.step()
    def test_runtime_guard_rechecks_stopped_ids_even_after_confirmation(self):
        self.step();self.confirm();container=next(iter(self.responses));self.responses[container]['State']={'Running':True,'Status':'running'}
        with self.assertRaises(ValueError):self.admit(self.new_sha)
    def test_conflicting_unit_input_or_history_is_never_overwritten(self):
        original=self.unit.read_bytes();self.save(self.unit,original+b'#changed\n')
        with self.assertRaises(ValueError):self.step()
        self.assertTrue(self.unit.read_bytes().endswith(b'#changed\n'))
        self.save(self.unit,original);self.step();self.save(self.new,self.new.read_bytes()+b' ')
        with self.assertRaises(ValueError):self.step('resume')
        self.assertFalse((self.journal/'confirmed.json').exists())
    def test_private_file_permissions_links_and_extra_journal_files_refused(self):
        self.review.chmod(0o644)
        with self.assertRaises(ValueError):self.step()
        self.review.chmod(0o600);os.link(self.review,self.root/'linked')
        with self.assertRaises(ValueError):self.step()
        (self.root/'linked').unlink();self.step();self.confirm()
        self.save(self.journal/'extra.json',b'{}')
        with self.assertRaises(ValueError):self.admit(self.new_sha)
    def test_request_tenant_generation_chain_and_duplicate_service_observation(self):
        original=copy.deepcopy(self.value)
        for key,value in [('schemaVersion',True),('tenantId','00000000-0000-0000-0000-000000000000'),('nextProfileFile','relative.json'),('previousGenerationSha256','d'*64),('previousTransitionSha256','e'*64),('extra',1)]:
            self.value={**original,key:value};self.save_review()
            with self.assertRaises(ValueError):self.step()
            self.assertFalse(self.journals.exists())
        self.value=original;self.save_review()
        with patch.object(e,'control',return_value=self.control('show',self.unit.name)+b'\nJob='):
            with self.assertRaises(ValueError):self.step()
    def test_runtime_lock_prevents_transition_during_owned_lifetime(self):
        with runtime.locked(TENANT):
            with self.assertRaises(BlockingIOError):self.step()
        self.assertFalse(self.journals.exists())

    def test_preparation_snapshot_limit_refuses_before_journal_or_unit_mutation(self):
        with patch.object(transition,'MAX_PREPARATION',100):
            with self.assertRaises(ValueError):self.step()
        self.assertFalse(self.journals.exists());self.assertEqual(self.unit.read_bytes(),self.loaded)
    def test_interrupted_confirmation_resumes_without_republishing_unit(self):
        self.step();self.loaded=self.unit.read_bytes();original=e.create
        def fail(path,data):
            if path.name=='confirmed.json':raise OSError('interrupted confirmation')
            original(path,data)
        with patch.object(e,'create',side_effect=fail):
            with self.assertRaises(OSError):self.step('confirm')
        with self.assertRaises(ValueError):self.admit(self.new_sha)
        inode=self.unit.stat().st_ino;self.step('confirm');self.admit(self.new_sha)
        self.assertEqual(self.unit.stat().st_ino,inode)
    def test_confirmation_rechecks_live_state_before_receipt(self):
        self.step();self.loaded=self.unit.read_bytes();original=runtime.settled;calls=0
        def change(directory):
            nonlocal calls
            calls+=1
            if calls==2:next(iter(self.responses.values()))['State']={'Running':True,'Status':'running'}
            return original(directory)
        with patch.object(runtime,'settled',side_effect=change):
            with self.assertRaises(ValueError):self.step('confirm')
        self.assertFalse((self.journal/'confirmed.json').exists())
    def test_completed_history_refuses_changed_unit_or_disconnected_chain(self):
        self.step();self.confirm();new=self.unit.read_bytes();self.save(self.unit,new+b'#unexpected\n')
        with self.assertRaises(ValueError):self.admit(self.new_sha)
        self.save(self.unit,new)
        self.value['previousTransitionSha256']='e'*64;raw=e.encode(self.value);changed=e.digest(raw)
        self.save(self.journal/'request.json',raw);self.journal.rename(self.journal.parent/changed)
        with self.assertRaises(ValueError):self.admit(self.new_sha)

if __name__=='__main__':unittest.main()
