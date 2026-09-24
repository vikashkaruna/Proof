"""Pinned payload and service delivery cannot broaden authority or replace live state."""
import copy
import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from lib import spire_host_bundle as bundles
import spire_host as host

UUID='de6a77f6-27ae-4c42-b302-8a98d243ed9b'
CA=b'-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n'


def policy(role='issuer'):
    return {'schemaVersion':1,'platform':'ubuntu-24.04','architecture':'amd64','role':role,'filesystemUuid':UUID,'spirePolicy':json.loads((ROOT/'infra/workload/spire-policy.example.json').read_text()),'bootstrapCaSha256':hashlib.sha256(CA).hexdigest() if role=='runner' else None}


def archive(change=None):
    root='spire-1.15.3'
    names=[root,root+'/bin',root+'/conf',root+'/conf/server',root+'/conf/agent',root+'/LICENSE',root+'/README.md',root+'/conf/server/server.conf',root+'/conf/agent/agent.conf',root+'/bin/spire-server',root+'/bin/spire-agent']
    items=[]
    for name in names:
        item=tarfile.TarInfo(name);data=b'x'
        if name in names[:5]:item.type=tarfile.DIRTYPE;data=b''
        elif '/bin/' in name:
            data=b'\x7fELF\x02\x01'+b'\0'*12+(62).to_bytes(2,'little')+b'\0'*44
        item.size=len(data);items.append((item,data))
    if change:change(items)
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w:gz') as tar:
        for item,data in items:tar.addfile(item,io.BytesIO(data) if item.isfile() else None)
    return out.getvalue()


class BundleTests(unittest.TestCase):
    def prepare(self,value=None,raw=None,ca=None):
        raw=raw or archive();value=value or policy()
        with patch.dict(bundles.RELEASE_SHA256,{'amd64':hashlib.sha256(raw).hexdigest()}):
            return bundles.prepare(value,raw,ca)

    def test_role_payloads_and_ready_only_restart(self):
        for role in ('issuer','runner'):
            raw,files=self.prepare(policy(role),ca=CA if role=='runner' else None)
            meta=json.loads(raw);self.assertEqual(set(files),set(host.layout(role)))
            for name,data in files.items():self.assertEqual(meta['files'][name],hashlib.sha256(data).hexdigest())
            service=files['spire.service'].decode()
            self.assertIn('--ready '+role,service);self.assertNotIn('--empty',service)
            self.assertIn('BindsTo=var-lib-spire.mount',service)
            self.assertIn('After=var-lib-spire.mount',service)
            self.assertIn('ExecStartPre=',service);self.assertNotIn('ExecStartPre=-',service)
            self.assertNotIn('Condition',service);self.assertNotIn('mkfs',service)
            self.assertNotIn('PrivateDevices=yes',service)
            self.assertNotIn('ReadWritePaths=',service)
            if role=='runner':
                health=files['health.service'].decode();self.assertIn('PartOf=axiom-spire-runner.service',health)
                self.assertIn('BindsTo=axiom-spire-runner.service var-lib-spire.mount',health)
                self.assertIn('ReadWritePaths=/run/spire-health',health)
                self.assertIn('spiffe://preprod.axiomproof.test/spire/agent/gcp_iit/replace-project/1',health)

    def test_initialization_is_explicit_bounded_and_not_a_boot_unit(self):
        _,files=self.prepare()
        initial=files['enroll.service'].decode();normal=files['spire.service'].decode()
        self.assertIn('spire_enrollment.py --permit issuer',initial)
        self.assertLess(initial.index('--permit issuer'),initial.index('--empty issuer'))
        self.assertIn('Restart=no',initial);self.assertIn('RuntimeMaxSec=60',initial)
        self.assertNotIn('[Install]',initial);self.assertNotIn('--empty',normal)
        self.assertNotIn('--permit',normal);self.assertIn('--ready issuer',normal)

    def test_bad_checksum_precedes_archive_parsing(self):
        with patch.object(bundles.tarfile,'open') as parser:
            with self.assertRaises(ValueError):bundles.selected_binary(b'bad','amd64','issuer')
            parser.assert_not_called()

    def test_archive_rejects_extra_missing_duplicate_and_traversal(self):
        changes=[lambda xs:xs.pop(),lambda xs:xs.append(copy.deepcopy(xs[-1])),lambda xs:setattr(xs[-1][0],'name','../../escape'),lambda xs:setattr(xs[-1][0],'name','spire-1.15.3/bin/extra')]
        for change in changes:
            with self.subTest(change=change),self.assertRaises(ValueError):self.prepare(raw=archive(change))

    def test_archive_rejects_links_special_bits_and_pax(self):
        for kind in (tarfile.SYMTYPE,tarfile.LNKTYPE,tarfile.FIFOTYPE):
            def change(xs):xs[-1][0].type=kind;xs[-1][0].linkname='/etc/passwd';xs[-1][0].size=0
            with self.subTest(kind=kind),self.assertRaises(ValueError):self.prepare(raw=archive(change))
        for change in (lambda xs:setattr(xs[-1][0],'mode',0o4755),lambda xs:setattr(xs[-1][0],'pax_headers',{'comment':'extra'})):
            with self.assertRaises(ValueError):self.prepare(raw=archive(change))

    def test_wrong_architecture_is_not_installed(self):
        value=policy();value['architecture']='arm64';raw=archive()
        with patch.dict(bundles.RELEASE_SHA256,{'arm64':hashlib.sha256(raw).hexdigest()}),self.assertRaises(ValueError):bundles.prepare(value,raw)

    def test_strict_host_policy_and_uuid(self):
        for value in (None,{**policy(),'extra':True},{**policy(),'platform':'debian-12'},{**policy(),'schemaVersion':True},{**policy(),'filesystemUuid':'../disk'}):
            with self.assertRaises(ValueError):self.prepare(value=value) if value is not None else bundles.prepare(None,b'')

    def test_runner_initialization_keeps_normal_hardening_without_health_start(self):
        _,files=self.prepare(policy('runner'),ca=CA)
        initial=files['enroll.service'].decode();normal=files['spire.service'].decode()
        self.assertIn('--permit runner',initial);self.assertIn('--empty runner',initial)
        self.assertIn('--ready runner',normal);self.assertNotIn('--empty runner',normal)
        self.assertIn('BindsTo=var-lib-spire.mount docker.service',initial)
        self.assertIn('RuntimeMaxSec=60',initial);self.assertIn('Restart=no',initial)
        self.assertNotIn('Wants=axiom-spire-health.service',initial)
        self.assertNotIn('[Install]',initial);self.assertNotIn('joinToken',initial)
        self.assertIn('rebootstrap_mode = "never"',files['spire.conf'].decode())
        self.assertIn('NodeAttestor "gcp_iit"',files['spire.conf'].decode())

    def test_ca_requires_separate_reviewed_hash(self):
        for value,ca in ((policy('runner'),None),(policy('runner'),CA+b'changed'),(policy(),CA),({**policy(),'bootstrapCaSha256':'a'*64},None)):
            with self.subTest(role=value['role']),self.assertRaises(ValueError):self.prepare(value,ca=ca)

    def test_manifest_cannot_choose_destinations_or_executables(self):
        raw,_=self.prepare();meta=json.loads(raw)
        for changed in ({**meta,'files':{**meta['files'],'../../etc/passwd':'a'*64}},{**meta,'role':'other'},{**meta,'architecture':'other'},{**meta,'schemaVersion':True}):
            with self.assertRaises(ValueError):host.manifest(changed)

    def test_mount_device_is_uuid_bound_and_escaped(self):
        raw,files=self.prepare();mount=files['state.mount'].decode()
        self.assertIn('What=/dev/disk/by-uuid/'+UUID,mount)
        self.assertIn('BindsTo=dev-disk-by\\x2duuid-de6a77f6\\x2d',mount)
        self.assertIn('Options=rw,nosuid,nodev,noexec',mount)
        self.assertIn('DirectoryMode=0700',mount)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve();self.source=self.base/'bundle';self.source.mkdir(mode=0o700)
        self.dest=self.base/'destination';self.dest.mkdir(mode=0o700)
        self.role='issuer'
        source_layout=host.layout('issuer')
        self.paths={name:(self.dest/path.name,mode,maximum) for name,(path,mode,maximum) in source_layout.items()}
        self.files={name:b'test payload '+name.encode() for name in self.paths}
        self.meta={'schemaVersion':1,'spireVersion':host.VERSION,'platform':'ubuntu-24.04','architecture':'amd64','role':'issuer','files':{name:hashlib.sha256(data).hexdigest() for name,data in self.files.items()}}
        self.raw=json.dumps(self.meta).encode();self.digest=hashlib.sha256(self.raw).hexdigest()
        for name,data in {**self.files,'manifest.json':self.raw}.items():self.put(self.source/name,data,0o600)
        # Unit ports isolate root ownership and trusted ancestry. The Docker
        # acceptance executes the unmodified root/path checks on real files.
        for patcher in (patch.object(host,'OWNER',os.geteuid()),patch.object(host,'protected_directory'),patch.object(host,'PREFIX',self.dest),patch.object(host,'layout',return_value=self.paths),patch.object(host,'host_profile')):
            patcher.start();self.addCleanup(patcher.stop)

    def put(self,path,data,mode):path.write_bytes(data);path.chmod(mode)

    def test_install_delivers_exact_files_and_retry_is_idempotent(self):
        host.install(self.source,self.digest)
        before={p:(p.stat().st_ino,p.read_bytes()) for p in self.dest.iterdir()}
        host.install(self.source,self.digest)
        self.assertEqual(before,{p:(p.stat().st_ino,p.read_bytes()) for p in self.dest.iterdir()})
        for name,(path,mode,_) in self.paths.items():
            self.assertEqual(path.read_bytes(),self.files[name]);self.assertEqual(path.stat().st_mode & 0o777,mode)

    def test_conflict_is_detected_before_any_delivery(self):
        conflict=self.paths['spire.service'][0];self.put(conflict,b'foreign',0o644)
        with self.assertRaises(ValueError):host.install(self.source,self.digest)
        self.assertEqual(list(self.dest.iterdir()),[conflict]);self.assertEqual(conflict.read_bytes(),b'foreign')

    def test_altered_payload_manifest_or_inventory_refused(self):
        with self.assertRaises(ValueError):host.bundle(self.source,'a'*64)
        extra=self.source/'extra';self.put(extra,b'x',0o600)
        with self.assertRaises(ValueError):host.bundle(self.source,self.digest)
        extra.unlink();self.put(self.source/'state.json',b'tampered',0o600)
        with self.assertRaises(ValueError):host.install(self.source,self.digest)
        self.assertEqual(list(self.dest.iterdir()),[])

    def test_unsafe_file_permissions_symlink_and_hardlink_refused(self):
        path=self.source/'state.json';path.chmod(0o644)
        with self.assertRaises(ValueError):host.bundle(self.source,self.digest)
        path.chmod(0o600);data=path.read_bytes();path.unlink();path.symlink_to(self.source/'spire.conf')
        with self.assertRaises(OSError):host.bundle(self.source,self.digest)
        path.unlink();self.put(path,data,0o600);os.link(path,self.base/'alias')
        with self.assertRaises(ValueError):host.bundle(self.source,self.digest)

    def test_restart_refuses_changed_installed_binary(self):
        host.install(self.source,self.digest)
        self.put(self.paths['spire-server'][0],b'changed',0o755)
        with self.assertRaises(ValueError):host.installed('issuer')

    def test_restart_refuses_wrong_role(self):
        host.install(self.source,self.digest)
        with self.assertRaises(ValueError):host.installed('runner')


class HostRuntimeTests(unittest.TestCase):
    def test_wrong_runtime_or_image_is_refused_before_external_calls(self):
        for changes in ({'platform':'darwin'}, {'platform':'linux','version_info':(3,11)}):
            with patch.multiple(host.sys,**changes), patch.object(host.subprocess,'run') as run:
                with self.assertRaises(ValueError):host.host_profile({'architecture':'amd64','role':'issuer'})
                run.assert_not_called()
        with patch.multiple(host.sys,platform='linux',version_info=(3,12)),patch.object(host.platform,'freedesktop_os_release',return_value={'ID':'debian','VERSION_ID':'12'}),patch.object(host.subprocess,'run') as run:
            with self.assertRaises(ValueError):host.host_profile({'architecture':'amd64','role':'issuer'})
            run.assert_not_called()

    def test_wrong_architecture_refused(self):
        with patch.multiple(host.sys,platform='linux',version_info=(3,12)),patch.object(host.platform,'freedesktop_os_release',return_value={'ID':'ubuntu','VERSION_ID':'24.04'}),patch.object(host.platform,'machine',return_value='aarch64'):
            with self.assertRaises(ValueError):host.host_profile({'architecture':'amd64','role':'issuer'})

    def test_readiness_retries_transient_failure_and_uses_fixed_socket(self):
        from subprocess import CompletedProcess,TimeoutExpired
        with patch.object(host.subprocess,'run',side_effect=[TimeoutExpired('fixture',2),CompletedProcess([],1),CompletedProcess([],0)]) as run,patch.object(host.time,'sleep'):
            host.wait_ready('issuer')
            self.assertEqual(run.call_count,3)
            for call in run.call_args_list:
                self.assertEqual(call.args[0],['/usr/local/bin/spire-server','healthcheck','-socketPath','/run/spire-server/api.sock'])
                self.assertLessEqual(call.kwargs['timeout'],2)
                self.assertEqual(call.kwargs['stdout'],host.subprocess.DEVNULL)

    def test_readiness_deadline_and_invalid_role_fail_closed(self):
        with patch.object(host.time,'monotonic',side_effect=[0,21]),patch.object(host.subprocess,'run') as run:
            with self.assertRaises(ValueError):host.wait_ready('runner')
            run.assert_not_called()
        with self.assertRaises(ValueError):host.wait_ready('unexpected')


if __name__=='__main__':unittest.main()

