"""Read-only state gate: mount binding, protected recovery files and fresh disk refusal."""
import base64
import importlib.util
import json
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('spire_state', ROOT / 'infra/workload/spire_state.py')
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)
FS_UUID = 'de6a77f6-27ae-4c42-b302-8a98d243ed9b'
POLICY = {'schemaVersion': 1, 'role': 'issuer', 'filesystemUuid': FS_UUID, 'trustDomain': 'preprod.axiomproof.test', 'nodeId': None}
DER = base64.b64encode(b'\x30' + b'0' * 63).decode()
CERT = base64.b64encode(b'-----BEGIN CERTIFICATE-----\n' + DER.encode() + b'\n-----END CERTIFICATE-----\n').decode()
ROOT_MOUNT = '20 1 8:1 / / rw - ext4 /dev/sda1 rw\n'
STATE_MOUNT = '21 20 8:16 / /var/lib/spire rw,nosuid,nodev,noexec - ext4 /dev/sdb rw\n'


class StatePolicyTests(unittest.TestCase):
    def test_role_and_exact_node_binding(self):
        self.assertEqual(state.policy(POLICY), POLICY)
        runner = {**POLICY, 'role': 'runner', 'nodeId': 'spiffe://preprod.axiomproof.test/spire/agent/gcp_iit/project-x/123'}
        self.assertEqual(state.policy(runner), runner)
        for field, values in {'role': ['other', 'issuer'], 'nodeId': [None, runner['nodeId'].replace('preprod.', 'foreign.'), runner['nodeId'] + '\n', runner['nodeId'].rsplit('/', 1)[0] + '/18446744073709551616']}.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    state.policy({**runner, field: value})

    def test_strict_policy_and_canonical_uuid(self):
        for value in (None, [], {**POLICY, 'extra': True}, {**POLICY, 'schemaVersion': True}, {k:v for k,v in POLICY.items() if k != 'nodeId'}):
            with self.assertRaises(ValueError):
                state.policy(value)
        for value in (0, FS_UUID.upper(), FS_UUID + '\n', '00000000-0000-0000-0000-000000000000', '../disk'):
            with self.assertRaises(ValueError):
                state.policy({**POLICY, 'filesystemUuid': value})
        with self.assertRaises(ValueError):
            json.loads('{"a":1,"a":2}', object_pairs_hook=state.unique)

    def test_mount_binding_accepts_dedicated_hardened_device(self):
        self.assertEqual(state.mount_binding(ROOT_MOUNT + STATE_MOUNT, os.makedev(8,16)), ('21','8:16'))

    def test_missing_stacked_root_device_or_nested_mount_refused(self):
        for text in (ROOT_MOUNT, ROOT_MOUNT + STATE_MOUNT * 2, ROOT_MOUNT.replace('8:1 ', '8:16 ') + STATE_MOUNT, ROOT_MOUNT + STATE_MOUNT + STATE_MOUNT.replace('21 ', '22 ', 1).replace('/var/lib/spire ', '/var/lib/spire/server ')):
            with self.subTest(text=text), self.assertRaises(ValueError):
                state.mount_binding(text, os.makedev(8,16))

    def test_wrong_device_subtree_filesystem_or_mount_flags_refused(self):
        for old,new in [('8:16','8:32'), (' / /var',' /subdir /var'), ('ext4','tmpfs'), ('rw,nosuid,nodev,noexec','rw,nosuid,nodev'), ('rw,nosuid,nodev,noexec','ro,nosuid,nodev,noexec'), ('/dev/sdb rw','/dev/sdb ro')]:
            with self.subTest(new=new), self.assertRaises(ValueError):
                state.mount_binding(ROOT_MOUNT + STATE_MOUNT.replace(old,new), os.makedev(8,16))

    def test_mount_parser_bounds_and_escapes(self):
        text = STATE_MOUNT.replace('/var/lib/spire', r'/var/lib/other\040path')
        self.assertEqual(state.parse_mounts(text)[0]['path'], '/var/lib/other path')
        for value in ('x', 'a b c - x', 'x' * (4 * 1024 * 1024 + 1)):
            with self.assertRaises(ValueError):
                state.parse_mounts(value)

    def test_superblock_uuid_probe_is_bound_and_read_only(self):
        meta = type('Meta', (), {'st_mode': 0o060600, 'st_uid': 0, 'st_rdev': os.makedev(8,16)})()
        result = type('Result', (), {'stdout': (FS_UUID+'\n').encode()})()
        with patch.object(state, 'ancestors'), patch.object(Path, 'lstat', return_value=meta), patch.object(Path, 'stat', return_value=meta), patch.object(Path, 'resolve', return_value=Path('/dev/sdb')), patch.object(state.subprocess, 'run', return_value=result) as run:
            self.assertEqual(state.mounted_device(POLICY), os.makedev(8,16))
            self.assertEqual(run.call_args.args[0], ['/usr/sbin/blkid', '-p', '-s', 'UUID', '-o', 'value', '--', '/dev/sdb'])
            self.assertEqual(run.call_args.kwargs['timeout'], 2)
            result.stdout = b'foreign\n'
            with self.assertRaises(ValueError):
                state.mounted_device(POLICY)


    def test_preparer_derives_node_from_reviewed_policy_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'state.json'
            command=[sys.executable,str(ROOT/'scripts/prepare-workload-state.py'),str(ROOT/'infra/workload/spire-policy.example.json'),'runner',FS_UUID,str(target)]
            result=subprocess.run(command,capture_output=True)
            self.assertEqual(result.returncode,0)
            content=target.read_bytes();value=json.loads(content)
            self.assertEqual(value['nodeId'],'spiffe://preprod.axiomproof.test/spire/agent/gcp_iit/replace-project/1')
            self.assertEqual(target.stat().st_mode & 0o777,0o600)
            self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
            self.assertEqual(target.read_bytes(),content)

    def test_preparer_invalid_input_creates_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'state.json'
            command=[sys.executable,str(ROOT/'scripts/prepare-workload-state.py'),str(ROOT/'infra/workload/spire-policy.example.json'),'runner','bad-uuid',str(target)]
            result=subprocess.run(command,capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stderr,b'SPIRE state binding preparation refused.\n')
            self.assertFalse(target.exists())

    def test_guard_cli_never_prints_private_input_errors(self):
        result=subprocess.run([sys.executable,str(ROOT/'infra/workload/spire_state.py'),'--invalid','issuer'],capture_output=True)
        self.assertEqual(result.returncode,1)
        self.assertEqual(result.stdout,b'')
        self.assertEqual(result.stderr,b'SPIRE state check refused.\n')


class StateFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        for patcher in (patch.object(state,'STATE',self.root), patch.object(state,'OWNER',os.geteuid())):
            patcher.start(); self.addCleanup(patcher.stop)

    def write(self, path, content):
        path.write_bytes(content if isinstance(content, bytes) else json.dumps(content).encode())
        path.chmod(0o600)
        return path

    def initialized(self, role='issuer'):
        value = {**POLICY, 'role':role, 'nodeId':None if role=='issuer' else 'spiffe://preprod.axiomproof.test/spire/agent/gcp_iit/project-x/123'}
        self.write(self.root / '.axiom-state.json', value)
        data = self.root / ('server' if role=='issuer' else 'agent'); data.mkdir(mode=0o700)
        self.write(data / 'keys.json', {'keys':{'key':DER}})
        if role=='issuer':
            self.write(data / 'db.sqlite3', b'SQLite format 3\x00' + b'\0' * 4080)
        else:
            self.write(data / 'agent-data.json', {'svid':[CERT], 'bundle':[CERT], 'reattestable':False})
        return value,data

    def test_empty_check_never_prepares_or_reuses_state(self):
        state.empty(); self.assertEqual(list(self.root.iterdir()), [])
        found=self.root/'lost+found';found.mkdir(mode=0o700)
        state.empty(); self.write(found/'recovered',b'x')
        with self.assertRaises(ValueError): state.empty()
        (found/'recovered').unlink();self.write(self.root/'unexpected',b'x')
        with self.assertRaises(ValueError): state.empty()

    def test_issuer_ready_is_read_only(self):
        value,data=self.initialized()
        before={p:p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        state.ready(value)
        self.assertEqual({p:p.read_bytes() for p in before},before)
        self.assertEqual(set(before),{p for p in self.root.rglob('*') if p.is_file()})

    def test_runner_ready_requires_recovery_chain_and_bundle(self):
        value,data=self.initialized('runner');state.ready(value)
        for payload in ({'svid':[], 'bundle':[CERT]}, {'svid':[CERT]}, {'svid':[DER], 'bundle':[DER]}, {'svid':[CERT], 'bundle':['not-base64']}):
            self.write(data/'agent-data.json',payload)
            with self.assertRaises(ValueError): state.ready(value)

    def test_missing_or_empty_keys_and_database_cannot_reinitialize(self):
        value,data=self.initialized()
        for keys in ({'keys':{}},{'keys':{'x':''}}, {'keys':{'x':DER},'extra':True}):
            self.write(data/'keys.json',keys)
            with self.assertRaises(ValueError): state.ready(value)
        self.write(data/'keys.json',{'keys':{'x':DER}})
        self.write(data/'db.sqlite3',b'not a sqlite database')
        with self.assertRaises(ValueError): state.ready(value)
        (data/'keys.json').unlink()
        with self.assertRaises(FileNotFoundError): state.ready(value)
        self.assertFalse((data/'keys.json').exists())

    def test_foreign_marker_and_missing_marker_refused(self):
        value,data=self.initialized()
        with self.assertRaises(ValueError): state.ready({**value,'trustDomain':'foreign.test'})
        (self.root/'.axiom-state.json').unlink()
        with self.assertRaises(FileNotFoundError): state.ready(value)

    def test_permissions_symlinks_hardlinks_and_oversize_refused(self):
        path=self.write(self.root/'test',b'private')
        path.chmod(0o644)
        with self.assertRaises(ValueError): state.private_file(path,64)
        path.chmod(0o600)
        with self.assertRaises(ValueError): state.private_file(path,2)
        alias=self.root/'alias';alias.symlink_to(path)
        with self.assertRaises(OSError): state.private_file(alias,64)
        alias.unlink();os.link(path,alias)
        with self.assertRaises(ValueError): state.private_file(path,64)

    def test_fifo_and_directory_refused_without_blocking(self):
        fifo=self.root/'fifo';os.mkfifo(fifo,0o600)
        with self.assertRaises(ValueError): state.private_file(fifo,64)
        with self.assertRaises(ValueError): state.private_file(self.root,64)

    def test_directory_alias_and_group_write_refused(self):
        directory=self.root/'data';directory.mkdir(mode=0o700)
        alias=self.root/'alias';alias.symlink_to(directory)
        with self.assertRaises(ValueError): state.directory(alias)
        directory.chmod(0o770)
        with self.assertRaises(ValueError): state.directory(directory)
        directory.chmod(0o755)
        with self.assertRaises(ValueError): state.directory(directory,private=True)


    def check_fixture(self, tables, mode='--ready', role='issuer'):
        config=self.root/'config.json';self.write(config,POLICY)
        device=self.root.stat().st_dev
        expected=f'{os.major(device)}:{os.minor(device)}'
        good=f'20 1 0:999 / / rw - ext4 /dev/root rw\n21 20 {expected} / {self.root} rw,nosuid,nodev,noexec - ext4 /dev/state rw\n'
        observations=[io.StringIO(good if value=='good' else good.replace('21 20','22 20') if value=='changed' else value) for value in tables]
        with patch.object(state,'CONFIG',config), patch.object(state,'ancestors'), patch.object(state,'mounted_device',return_value=device), patch('builtins.open',side_effect=observations):
            state.check(mode,role)

    def test_full_gate_checks_mount_before_existing_state_and_again_after_read(self):
        value,data=self.initialized()
        self.check_fixture(['good','good'])
        with self.assertRaises(ValueError): self.check_fixture(['good','changed'])
        with patch.object(state,'ready') as ready:
            with self.assertRaises(ValueError): self.check_fixture([ROOT_MOUNT])
            ready.assert_not_called()

    def test_wrong_host_role_and_invalid_mode_fail_before_disk_probe(self):
        with patch.object(state,'mounted_device') as device:
            with self.assertRaises(ValueError): self.check_fixture([],role='runner')
            with self.assertRaises(ValueError): state.check('--initialize','issuer')
            device.assert_not_called()


if __name__=='__main__': unittest.main()
