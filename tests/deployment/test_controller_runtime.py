"""Review, confinement and interrupted-lifetime ownership regression tests."""
import contextlib
import copy
import json
import os
import signal
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'infra/workload'))
import controller_runtime as runtime

TENANT = '11111111-1111-4111-8111-111111111111'
ATTEMPT = '22222222-2222-4222-8222-222222222222'
SHA = 'a'*64
ID = 'b'*64
IMAGE = 'sha256:'+'c'*64
PROFILE = {'schemaVersion': 1, 'tenantId': TENANT, 'placementFile': '/etc/axiom/placement.json', 'placementSha256': 'd'*64, 'backendUrl': 'https://backend.example.test'}
READY = {'profile': {'tenantId': TENANT, 'privateIp': '10.0.0.11'}, 'files': '/etc/axiom/controllers/fixture/files', 'image': IMAGE, 'volumes': {'workload': {'Name': 'axiom-workload-api-fixture'}, 'health': {'Name': 'axiom-spire-health-fixture'}}}
ENV = ['PATH=/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'PNPM_HOME=/pnpm', 'NODE_ENV=production', 'TSX_DISABLE_CACHE=1', 'NODE_VERSION=24.21.0', 'YARN_VERSION=1.22.22']
IMAGE_OBSERVATION = {'Id': IMAGE, 'Config': {'User': '20000:20000', 'Entrypoint': runtime.ENTRYPOINT, 'WorkingDir': '/app/services/bff', 'Env': ENV}}


def intended():
    with patch.object(runtime, 'image_environment', return_value=ENV), patch.object(runtime.volumes, 'SOCKET') as socket:
        socket.lstat.return_value = types.SimpleNamespace(st_gid=999)
        return runtime.spec(PROFILE, SHA, READY, ATTEMPT)


def observed_container(spec):
    # Docker inspect contract; native acceptance independently exercises the CLI.
    return {'Id': ID, 'Name': '/'+spec['name'], 'Image': IMAGE,
            'Config': {'Labels': spec['labels'], 'User': '20000:20000', 'Entrypoint': runtime.ENTRYPOINT,
                       'Cmd': ['--serve', '/run/controller-secrets/service.json'], 'WorkingDir': '/app/services/bff',
                       'Hostname': spec['name'], 'OpenStdin': False, 'Tty': False, 'StopSignal': 'SIGTERM',
                       'StopTimeout': 90, 'Env': spec['env']},
            'HostConfig': {'NetworkMode': 'bridge', 'IpcMode': 'private', 'CgroupnsMode': 'private',
                           'ReadonlyRootfs': True, 'Privileged': False, 'PidMode': '', 'UTSMode': '',
                           'CapAdd': None, 'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'],
                           'GroupAdd': [spec['group']], 'PidsLimit': 128, 'Memory': 536870912, 'MemorySwap': 536870912,
                           'LogConfig': {'Type': 'none', 'Config': {}}, 'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0},
                           'PortBindings': {'8443/tcp': [{'HostIp': spec['privateIp'], 'HostPort': '8443'}]},
                           'Mounts': spec['mounts'], 'AutoRemove': False, 'PublishAllPorts': False,
                           'OomKillDisable': False, 'UsernsMode': '', 'Runtime': 'runc'},
            'State': {'Status': 'created', 'Running': False}}


class RuntimePolicyTests(unittest.TestCase):
    def test_profile_refuses_credentials_or_alternate_authority(self):
        runtime.profile(PROFILE)
        for key, value in [('schemaVersion', True), ('tenantId', '00000000-0000-0000-0000-000000000000'), ('placementFile', '/tmp/../profile'), ('placementFile', '/etc/a%20b'), ('placementFile', '/etc/a\nb'), ('backendUrl', 'http://plain'), ('backendUrl', 'https://user:secret@host'), ('backendUrl', 'https://host/?token=x'), ('backendUrl', 'https://host/#secret'), ('backendUrl', 'https://host/private'), ('backendUrl', 'https://host:22'), ('env', {'SECRET': 'forbidden'})]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError): runtime.profile({**PROFILE, key: value})

    def test_unit_preserves_daemon_namespace_and_bounded_stop_without_restart(self):
        unit = runtime.unit(PROFILE, SHA).decode()
        self.assertIn('Restart=no', unit); self.assertIn('TimeoutStopSec=180', unit)
        self.assertIn('--stop '+TENANT+' '+SHA, unit)
        self.assertIn('Type=exec', unit)
        self.assertNotIn('ProtectSystem=', unit); self.assertNotIn('PrivateTmp=', unit)
        self.assertNotIn(PROFILE['backendUrl'], unit)

    def test_image_contract_refuses_entrypoint_user_mounts_or_environment_override(self):
        with patch.object(runtime, 'observation', return_value=IMAGE_OBSERVATION):
            self.assertEqual(runtime.image_environment(IMAGE), ENV)
        for key, value in [('User', 'root'), ('Entrypoint', ['/bin/sh']), ('WorkingDir', '/other'), ('Cmd', ['run']), ('Volumes', {'/etc': {}}), ('Healthcheck', {'Test': ['CMD', 'evil']}), ('OnBuild', ['RUN evil']), ('StopSignal', 'SIGKILL'), ('Env', ENV+['SECRET=private']), ('Env', ENV+['PATH=/evil']), ('Env', [item.replace('production', 'development') for item in ENV])]:
            observation = copy.deepcopy(IMAGE_OBSERVATION); observation['Config'][key] = value
            with self.subTest(key=key), patch.object(runtime, 'observation', return_value=observation), self.assertRaises(ValueError): runtime.image_environment(IMAGE)

    def test_created_spec_has_only_private_publish_fixed_protected_mounts_and_real_entrypoint(self):
        spec = intended(); args = runtime.arguments(spec)
        self.assertEqual(args[-3:], [IMAGE, '--serve', '/run/controller-secrets/service.json'])
        self.assertIn('10.0.0.11:8443:8443/tcp', args)
        self.assertNotIn('--entrypoint', args); self.assertNotIn('--privileged', args)
        self.assertEqual([entry['Target'] for entry in spec['mounts']], ['/run/controller-secrets', '/run/docker.sock', '/run/workload', '/run/spire-health'])
        self.assertTrue(spec['mounts'][0]['ReadOnly'])
        self.assertEqual(spec['labels'][runtime.LABEL+'tenant'], TENANT)
        with patch.object(runtime, 'image_environment', return_value=ENV), self.assertRaises(ValueError):
            runtime.spec(PROFILE, SHA, {**READY, 'profile': {**READY['profile'], 'tenantId': ATTEMPT}}, ATTEMPT)

    def test_stop_ownership_refuses_foreign_id_name_image_or_labels(self):
        spec = intended()
        observed = {'Id': ID, 'Name': '/'+spec['name'], 'Image': IMAGE, 'Config': {'Labels': spec['labels']}, 'State': {'Running': True, 'Status': 'running'}}
        with patch.object(runtime, 'observation', return_value=observed): self.assertEqual(runtime.owned(ID, spec), observed)
        for key, value in [('Id', 'e'*64), ('Name', '/foreign'), ('Image', 'sha256:'+'e'*64), ('Config', {'Labels': {}})]:
            with self.subTest(key=key), patch.object(runtime, 'observation', return_value={**observed, key: value}), self.assertRaises(ValueError): runtime.owned(ID, spec)
        with patch.object(runtime, 'observation') as inspect, self.assertRaises(ValueError): runtime.owned('short-id', spec)
        inspect.assert_not_called()


    def test_created_confinement_accepts_exact_contract_and_refuses_every_changed_field(self):
        spec = intended(); observed = observed_container(spec)
        with patch.object(runtime, 'observation', return_value=observed): runtime.created(ID, spec)
        for section in ('Config', 'HostConfig'):
            for key, value in observed[section].items():
                altered = copy.deepcopy(observed)
                altered[section][key] = not value if isinstance(value, bool) else 'unexpected'
                with self.subTest(section=section, key=key), patch.object(runtime, 'observation', return_value=altered), self.assertRaises(ValueError):
                    runtime.created(ID, spec)

    def test_private_binding_refuses_desktop_rewrite_public_wildcard_and_extra_port(self):
        spec = intended()
        ports = [{'8443/tcp': [{'HostIp': ip, 'HostPort': port}]} for ip, port in
                 [('127.0.0.1', ''), ('0.0.0.0', '8443'), ('::', '8443'), ('10.0.0.12', '8443'), ('10.0.0.11', '')]]
        ports.append({'8443/tcp': [{'HostIp': '10.0.0.11', 'HostPort': '8443'}], '80/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '80'}]})
        for bindings in ports:
            altered = observed_container(spec); altered['HostConfig']['PortBindings'] = bindings
            with self.subTest(bindings=bindings), patch.object(runtime, 'observation', return_value=altered), self.assertRaises(ValueError): runtime.created(ID, spec)

    def test_unrequested_host_authority_and_started_container_are_refused(self):
        spec = intended()
        for key in ('Binds', 'Devices', 'DeviceRequests', 'DeviceCgroupRules', 'VolumesFrom', 'Links', 'ExtraHosts', 'Tmpfs', 'Sysctls', 'StorageOpt', 'CgroupParent', 'Dns', 'DnsOptions', 'DnsSearch'):
            altered = observed_container(spec); altered['HostConfig'][key] = ['unrequested']
            with self.subTest(key=key), patch.object(runtime, 'observation', return_value=altered), self.assertRaises(ValueError): runtime.created(ID, spec)
        altered = observed_container(spec); altered['State']['Status'] = 'running'
        with patch.object(runtime, 'observation', return_value=altered), self.assertRaises(ValueError): runtime.created(ID, spec)

    def test_native_empty_driver_representation_accepts_no_driver_authority(self):
        spec = intended(); observed = copy.deepcopy(observed_container(spec))
        for mount in observed['HostConfig']['Mounts']:
            if mount['Type'] == 'volume': mount['VolumeOptions']['DriverConfig'] = {}
        with patch.object(runtime, 'observation', return_value=observed): runtime.created(ID, spec)
        for driver in ({'Name': 'nfs'}, {'Options': {'device': '/etc'}}, None, {'Name': ''}):
            altered = copy.deepcopy(observed); altered['HostConfig']['Mounts'][2]['VolumeOptions']['DriverConfig'] = driver
            with self.subTest(driver=driver), patch.object(runtime, 'observation', return_value=altered), self.assertRaises(ValueError): runtime.created(ID, spec)
        for field, value in [('Source', 'foreign'), ('Target', '/other'), ('ReadOnly', False), ('VolumeOptions', {'NoCopy': False, 'DriverConfig': {}})]:
            altered = copy.deepcopy(observed); altered['HostConfig']['Mounts'][2][field] = value
            with self.subTest(field=field), patch.object(runtime, 'observation', return_value=altered), self.assertRaises(ValueError): runtime.created(ID, spec)

    def test_namespace_probe_uses_short_fixed_deadline(self):
        with patch.object(runtime.enrollment, 'command', return_value=b'0\n') as command, self.assertRaises(ValueError): runtime.volumes.daemon_namespace()
        command.assert_called_once_with(['/usr/bin/systemctl', 'show', '--property=MainPID', '--value', 'docker.service'], timeout=3)


class RuntimeLifetimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile_dir = self.root/'profiles'; self.profile_dir.mkdir(mode=0o700)
        raw = runtime.enrollment.encode(PROFILE); self.sha = runtime.enrollment.digest(raw)
        (self.profile_dir/(self.sha+'.json')).write_bytes(raw); (self.profile_dir/(self.sha+'.json')).chmod(0o600)
        self.state = self.root/'state'
        self.spec = intended(); self.spec['labels'][runtime.LABEL+'profile'] = self.sha
        self.status = 'created'; self.calls = []; self.fail_create = False; self.fail_start = False
        replacements = {
            'owner': patch.object(runtime.host, 'OWNER', os.geteuid()),
            'ancestry': patch.object(runtime.host, 'protected_directory'),
            'state': patch.object(runtime, 'STATE', self.state),
            'profiles': patch.object(runtime, 'PROFILES', self.profile_dir),
            'exclusive': patch.object(runtime.enrollment, 'exclusive', side_effect=contextlib.nullcontext),
            'placement': patch.object(runtime.placement, 'check', return_value=READY),
            'spec': patch.object(runtime, 'spec', return_value=self.spec),
            'uuid': patch.object(runtime.uuid, 'uuid4', return_value=ATTEMPT),
            'created': patch.object(runtime, 'created'),
            'owned': patch.object(runtime, 'owned', side_effect=lambda *args: {'State': {'Running': self.status=='running', 'Status': self.status}}),
            'docker': patch.object(runtime, 'docker', side_effect=self.docker),
            'sleep': patch.object(runtime.time, 'sleep', side_effect=lambda _: signal.raise_signal(signal.SIGTERM)),
        }
        self.mocks = {}
        for name, replacement in replacements.items():
            self.mocks[name] = replacement.start(); self.addCleanup(replacement.stop)

    @property
    def attempt(self): return self.state/TENANT/ATTEMPT

    def docker(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[0] == 'create':
            self.assertTrue((self.attempt/'intent.json').exists())
            self.assertFalse((self.attempt/'container.json').exists())
            if self.fail_create: raise ValueError('uncertain create')
            return (ID+'\n').encode()
        if args[:2] == ('container', 'start'):
            self.assertEqual(runtime.enrollment.load(self.attempt/'container.json'), {'schemaVersion': 1, 'containerId': ID})
            self.status = 'running'
            if self.fail_start: raise ValueError('uncertain start')
        elif args[:2] == ('container', 'stop'):
            self.assertEqual(args, ('container', 'stop', '--time', '90', ID))
            self.assertEqual(kwargs['timeout'], 100); self.status = 'exited'
        else: self.fail('unexpected Docker operation')
        return (ID+'\n').encode()

    def test_create_is_journaled_before_start_and_sigterm_stops_only_recorded_id(self):
        runtime.run(self.sha)
        self.assertEqual([args[:2] for args, _ in self.calls], [('create', '--pull'), ('container', 'start'), ('container', 'stop')])
        self.assertEqual(runtime.enrollment.load(self.attempt/'stopped.json'), {'schemaVersion': 1, 'containerId': ID})
        self.assertEqual(self.mocks['placement'].call_count, 2)

    def test_uncertain_create_is_preserved_and_no_name_adoption_or_retry(self):
        self.fail_create = True
        with self.assertRaises(ValueError): runtime.run(self.sha)
        before = (self.attempt/'intent.json').read_bytes()
        with self.assertRaises(ValueError): runtime.run(self.sha)
        with self.assertRaises(FileNotFoundError): runtime.stop(TENANT, self.sha)
        self.assertEqual((self.attempt/'intent.json').read_bytes(), before)
        self.assertEqual(len(self.calls), 1)

    def test_uncertain_start_uses_durable_id_to_stop_without_relaunch(self):
        self.fail_start = True
        with self.assertRaises(ValueError): runtime.run(self.sha)
        self.assertTrue((self.attempt/'stopped.json').exists())
        self.assertEqual(sum(args[:2] == ('container', 'start') for args, _ in self.calls), 1)

    def test_changed_placement_after_create_refuses_start_and_seals_stopped_object(self):
        self.mocks['placement'].side_effect = [READY, {**READY, 'image': 'sha256:'+'e'*64}]
        with self.assertRaises(ValueError): runtime.run(self.sha)
        self.assertTrue((self.attempt/'stopped.json').exists())
        self.assertFalse(any(args[:2] == ('container', 'start') for args, _ in self.calls))

    def test_stop_is_available_when_metadata_and_health_are_unavailable(self):
        self.mocks['sleep'].side_effect = RuntimeError('interrupted monitor')
        self.mocks['owned'].side_effect = RuntimeError('daemon unavailable')
        with self.assertRaises(RuntimeError): runtime.run(self.sha)
        self.assertFalse((self.attempt/'stopped.json').exists())
        self.mocks['owned'].side_effect = lambda *args: {'State': {'Running': self.status=='running', 'Status': self.status}}
        self.mocks['placement'].side_effect = RuntimeError('metadata or health unavailable')
        runtime.stop(TENANT, self.sha)
        self.assertTrue((self.attempt/'stopped.json').exists())
        # Repeating stop is a no-op, without touching Docker or metadata.
        before = len(self.calls); runtime.stop(TENANT, self.sha); self.assertEqual(len(self.calls), before)

    def test_wrong_review_cannot_stop_an_unresolved_container(self):
        self.fail_create = True
        with self.assertRaises(ValueError): runtime.run(self.sha)
        with self.assertRaises(ValueError): runtime.stop(TENANT, 'e'*64)
        self.assertEqual(len(self.calls), 1)

    def test_per_tenant_lock_refuses_concurrent_start_and_unsafe_lock(self):
        with runtime.locked(TENANT):
            with self.assertRaises(BlockingIOError):
                with runtime.locked(TENANT): pass
        (self.state/TENANT/'lock').chmod(0o666)
        with self.assertRaises(ValueError):
            with runtime.locked(TENANT): pass

    def test_second_unresolved_attempt_refuses(self):
        self.fail_create = True
        with self.assertRaises(ValueError): runtime.run(self.sha)
        other = self.state/TENANT/'33333333-3333-4333-8333-333333333333'; other.mkdir(mode=0o700)
        runtime.enrollment.create(other/'intent.json', (self.attempt/'intent.json').read_bytes())
        with self.assertRaises(ValueError): runtime.stop(TENANT, self.sha)
        self.assertEqual(len(self.calls), 1)


    def test_failed_confinement_leaves_unstarted_intent_without_adoption(self):
        self.mocks['created'].side_effect = ValueError('confinement refused')
        with self.assertRaises(ValueError): runtime.run(self.sha)
        self.assertTrue((self.attempt/'intent.json').exists())
        self.assertFalse((self.attempt/'container.json').exists())
        self.assertEqual(len(self.calls), 1)

    def test_receipt_persistence_failure_never_starts_container(self):
        create = runtime.enrollment.create
        def fail_receipt(path, data):
            if path.name == 'container.json': raise OSError('disk failure')
            return create(path, data)
        with patch.object(runtime.enrollment, 'create', side_effect=fail_receipt), self.assertRaises(OSError): runtime.run(self.sha)
        self.assertTrue((self.attempt/'intent.json').exists())
        self.assertEqual(len(self.calls), 1)

    def test_signal_during_create_records_id_then_stops_without_start(self):
        original = self.docker
        def interrupted(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[0] == 'create': signal.raise_signal(signal.SIGTERM)
            return result
        self.mocks['docker'].side_effect = interrupted
        runtime.run(self.sha)
        self.assertTrue((self.attempt/'stopped.json').exists())
        self.assertEqual(len(self.calls), 1)

    def test_stop_timeout_preserves_unresolved_attempt_and_explicit_retry(self):
        original = self.docker
        def timeout(*args, **kwargs):
            if args[:2] == ('container', 'stop'): raise ValueError('stop uncertain')
            return original(*args, **kwargs)
        self.mocks['docker'].side_effect = timeout
        with self.assertRaises(ValueError): runtime.run(self.sha)
        self.assertFalse((self.attempt/'stopped.json').exists())
        with self.assertRaises(ValueError): runtime.run(self.sha)
        self.mocks['docker'].side_effect = original
        runtime.stop(TENANT, self.sha)
        self.assertTrue((self.attempt/'stopped.json').exists())

    def test_uncertain_start_still_created_cannot_certify_stopped_or_relaunch(self):
        original = self.docker
        def queued(*args, **kwargs):
            if args[:2] == ('container', 'start'):
                self.assertEqual(runtime.enrollment.load(self.attempt/'start.json'), {'schemaVersion': 1, 'containerId': ID})
                raise ValueError('start request timed out before state transition')
            return original(*args, **kwargs)
        self.mocks['docker'].side_effect = queued
        with self.assertRaises(ValueError): runtime.run(self.sha)
        with self.assertRaises(ValueError): runtime.stop(TENANT, self.sha)
        with self.assertRaises(ValueError): runtime.run(self.sha)
        self.assertFalse((self.attempt/'stopped.json').exists())
        # Only the eventual observed running process can now be stopped safely.
        self.status = 'running'; self.mocks['docker'].side_effect = original
        runtime.stop(TENANT, self.sha)
        self.assertTrue((self.attempt/'stopped.json').exists())

    def test_corrupt_intent_profile_or_name_cannot_stop_container(self):
        self.fail_start = True
        self.mocks['owned'].side_effect = ValueError('unavailable')
        with self.assertRaises(ValueError): runtime.run(self.sha)
        path = self.attempt/'intent.json'; original = runtime.enrollment.load(path)
        for field in ('name', 'labels'):
            altered = copy.deepcopy(original)
            if field == 'name': altered['spec']['name'] = 'foreign'
            else: altered['spec']['labels'][runtime.LABEL+'profile'] = 'e'*64
            path.write_bytes(runtime.enrollment.encode(altered))
            before = len(self.calls)
            with self.assertRaises(ValueError): runtime.stop(TENANT, self.sha)
            self.assertEqual(len(self.calls), before)


if __name__ == '__main__': unittest.main()
