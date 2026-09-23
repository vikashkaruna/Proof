"""Placement denial, actual HTTP framing, bounded observation and host composition."""
import copy
import http.client
import http.server
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'infra/workload'))
import controller_placement as placement

TENANT = '11111111-1111-4111-8111-111111111111'
PROFILE = {'schemaVersion': 1, 'tenantId': TENANT, 'controllerManifestSha256': 'a'*64, 'zone': 'asia-south1-a', 'privateIp': '10.0.0.11'}
BINDING = {'schemaVersion': 1, 'role': 'runner', 'filesystemUuid': TENANT, 'trustDomain': 'fixture.test', 'nodeId': 'spiffe://fixture.test/spire/agent/gcp_iit/axiom-test/123'}
OBSERVED = {'tenantId': TENANT, 'instanceId': '123', 'projectId': 'axiom-test', 'zone': 'projects/456/zones/asia-south1-a', 'privateIp': '10.0.0.11'}
INTERFACE = {'ifindex': 2, 'flags': ['UP', 'LOWER_UP', 'BROADCAST', 'MULTICAST'], 'operstate': 'UP', 'addr_info': [{'family': 'inet', 'scope': 'global', 'local': '10.0.0.11', 'preferred_life_time': 4294967295}]}


class PlacementTests(unittest.TestCase):
    def test_profile_refuses_ambiguous_or_public_placement(self):
        self.assertEqual(placement.profile(PROFILE), PROFILE)
        for key, value in [('schemaVersion', True), ('tenantId', '0'*32), ('tenantId', '00000000-0000-0000-0000-000000000000'), ('zone', 'asia-south2-a'), ('zone', 'asia-south1-a/../b'), ('privateIp', '127.0.0.1'), ('privateIp', '169.254.169.254'), ('privateIp', '8.8.8.8'), ('privateIp', '::1'), ('privateIp', '010.0.0.11'), ('controllerManifestSha256', 'A'*64), ('url', 'http://alternate')]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                placement.profile({**PROFILE, key: value})

    def test_metadata_requires_exact_tenant_node_address_and_mumbai_zone(self):
        placement.matched(PROFILE, BINDING, OBSERVED)
        for key, value in [('tenantId', '22222222-2222-4222-8222-222222222222'), ('projectId', 'other-project'), ('instanceId', '124'), ('privateIp', '10.0.0.12'), ('zone', 'projects/456/zones/asia-south1-b'), ('zone', 'projects/not-number/zones/asia-south1-a')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                placement.matched(PROFILE, BINDING, {**OBSERVED, key: value})
        with self.assertRaises(ValueError):
            placement.matched(PROFILE, {**BINDING, 'nodeId': 'spiffe://fixture.test/spire/agent/join_token/axiom-test/123'}, OBSERVED)

    def test_address_must_be_unique_live_nonloop_global_interface(self):
        with patch.object(placement.enrollment, 'command', return_value=json.dumps([INTERFACE]).encode()) as command:
            placement.assigned(PROFILE['privateIp'])
            self.assertEqual(command.call_args.args[0], ['/usr/sbin/ip', '-j', '-4', 'address', 'show', 'up'])
        variants = [[], [INTERFACE, INTERFACE]]
        for key, value in [('flags', ['UP', 'LOWER_UP', 'LOOPBACK']), ('flags', ['UP']), ('operstate', 'DOWN'), ('ifindex', True)]:
            variants.append([{**INTERFACE, key: value}])
        for key, value in [('scope', 'host'), ('local', '10.0.0.12'), ('family', 'inet6'), ('preferred_life_time', 0), ('tentative', True), ('dadfailed', True), ('deprecated', True)]:
            variants.append([{**INTERFACE, 'addr_info': [{**INTERFACE['addr_info'][0], key: value}]}])
        for interfaces in variants:
            with self.subTest(interfaces=interfaces), patch.object(placement.enrollment, 'command', return_value=json.dumps(interfaces).encode()), self.assertRaises(ValueError):
                placement.assigned(PROFILE['privateIp'])

    def test_observer_child_has_fixed_isolated_command_deadline_and_bound(self):
        with patch.object(placement.enrollment, 'command', return_value=json.dumps(OBSERVED).encode()) as command:
            self.assertEqual(placement.metadata(), OBSERVED)
            self.assertEqual(command.call_args.args[0], ['/usr/bin/python3', '-I', '-B', '/opt/axiom/spire/1.15.3/controller_placement.py', '--observe'])
            self.assertEqual(command.call_args.kwargs, {'timeout': 8, 'maximum': 2048})
        for raw in (b'[]', b'{"tenantId":"a","tenantId":"b"}', json.dumps({**OBSERVED, 'token': 'forbidden'}).encode()):
            with patch.object(placement.enrollment, 'command', return_value=raw), self.assertRaises(ValueError): placement.metadata()

    def test_total_observation_deadline_kills_trickling_child(self):
        # Exercise the real subprocess deadline even when output keeps arriving.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'controller_placement.py'
            path.write_text('import time\nwhile True:\n print("x", flush=True)\n time.sleep(0.05)\n')
            started = time.monotonic()
            with patch.object(placement.host, 'PREFIX', Path(directory)), self.assertRaises(ValueError): placement.metadata()
            self.assertLess(time.monotonic()-started, 11)


class MetadataHTTPTests(unittest.TestCase):
    def setUp(self):
        self.requests = []; self.status = 200; self.flavors = ['Google']; self.payload = None; self.delay = 0
        case = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                case.requests.append((self.path, dict(self.headers)))
                time.sleep(case.delay)
                reverse = {'/computeMetadata/v1/'+path: name for name, path in placement.PATHS.items()}
                payload = case.payload if case.payload is not None else OBSERVED[reverse[self.path]].encode()
                try:
                    self.send_response(case.status)
                    for flavor in case.flavors: self.send_header('Metadata-Flavor', flavor)
                    self.send_header('Content-Length', str(len(payload)))
                    self.send_header('Location', 'http://forbidden.example/token')
                    self.end_headers(); self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError): pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(thread.join); self.addCleanup(server.shutdown)
        original = http.client.HTTPConnection
        def fixture(host, port, timeout):
            self.assertEqual((host, port, timeout), ('169.254.169.254', 80, 1))
            return original('127.0.0.1', server.server_port, timeout=timeout)
        replacement = patch.object(placement.http.client, 'HTTPConnection', side_effect=fixture)
        replacement.start(); self.addCleanup(replacement.stop)

    def test_real_http_uses_only_fixed_nonsensitive_paths_without_proxy(self):
        with patch.dict(os.environ, {'HTTP_PROXY': 'http://unusable.invalid:1', 'http_proxy': 'http://unusable.invalid:1'}):
            self.assertEqual(placement.observe(), OBSERVED)
        self.assertEqual([request[0] for request in self.requests], ['/computeMetadata/v1/'+path for path in placement.PATHS.values()])
        self.assertTrue(all(headers['Metadata-Flavor'] == 'Google' for _, headers in self.requests))
        self.assertFalse(any('token' in path or 'recursive' in path for path, _ in self.requests))

    def test_redirect_error_or_missing_duplicate_wrong_flavor_refuses(self):
        for status, flavors in [(302, ['Google']), (404, ['Google']), (200, []), (200, ['google']), (200, ['Google', 'Google'])]:
            self.status, self.flavors = status, flavors; self.requests.clear()
            with self.subTest(status=status, flavors=flavors), self.assertRaises(ValueError): placement.observe()
            self.assertEqual(len(self.requests), 1)

    def test_empty_oversized_whitespace_or_binary_response_refuses(self):
        for payload in (b'', b'x'*257, b' tenant', b'tenant\n', b'a\x00b', b'\xff'):
            self.payload = payload
            with self.subTest(payload=repr(payload[:10])), self.assertRaises(ValueError): placement.observe()

    def test_stalled_response_refuses(self):
        self.delay = 1.2
        with self.assertRaises(TimeoutError): placement.observe()


class PlacementCompositionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'placement.json'
        self.raw = placement.enrollment.encode(PROFILE); self.path.write_bytes(self.raw); self.path.chmod(0o600)
        self.sha = placement.enrollment.digest(self.raw)
        self.delivered = Path('/etc/axiom/controllers')/TENANT/('a'*64)/'files'
        self.file_review = {'schemaVersion': 1, 'tenantId': TENANT, 'spireManifestSha256': 'b'*64, 'controllerImage': 'sha256:'+'c'*64, 'files': {name: 'd'*64 for name in placement.files.FILES}}
        patches = {
            'owner': patch.object(placement.host, 'OWNER', os.geteuid()),
            'ancestry': patch.object(placement.host, 'protected_directory'),
            'files': patch.object(placement.files, 'check', return_value=self.delivered),
            'review': patch.object(placement.enrollment, 'load', return_value=self.file_review),
            'installed': patch.object(placement.enrollment, 'installed', return_value=BINDING),
            'metadata': patch.object(placement, 'metadata', return_value=OBSERVED),
            'assigned': patch.object(placement, 'assigned'),
            'volumes': patch.object(placement.volumes, 'prepare', return_value={'volumes': {'fixture': 'checked'}}),
        }
        self.mocks = {}
        for name, replacement in patches.items():
            self.mocks[name] = replacement.start(); self.addCleanup(replacement.stop)

    def check(self): return placement.check(self.path, self.sha)

    def test_composes_protected_files_node_live_volumes_and_repeated_placement(self):
        result = self.check()
        self.assertEqual(result['profile'], PROFILE); self.assertEqual(result['files'], str(self.delivered))
        self.assertEqual(result['image'], self.file_review['controllerImage'])
        self.mocks['volumes'].assert_called_once_with('b'*64, check=True)
        self.assertEqual(self.mocks['metadata'].call_count, 2)
        self.assertEqual(self.mocks['assigned'].call_count, 2)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_unreviewed_profile_refuses_before_files_or_network(self):
        self.path.write_bytes(self.raw+b' ')
        with self.assertRaises(ValueError): self.check()
        self.mocks['files'].assert_not_called(); self.mocks['metadata'].assert_not_called()

    def test_wrong_vm_refuses_before_docker_volume_inspection(self):
        self.mocks['metadata'].return_value = {**OBSERVED, 'tenantId': 'foreign'}
        with self.assertRaises(ValueError): self.check()
        self.mocks['volumes'].assert_not_called()

    def test_changed_metadata_node_files_or_profile_during_check_refuses(self):
        for key, changed in [('metadata', {**OBSERVED, 'instanceId': '124'}), ('installed', {**BINDING, 'nodeId': BINDING['nodeId']+'0'}), ('files', Path('/changed'))]:
            mock = self.mocks[key]; original = mock.return_value; mock.side_effect = [original, changed]
            with self.subTest(key=key), self.assertRaises(ValueError): self.check()
            mock.side_effect = None
        self.mocks['volumes'].side_effect = lambda *a, **kw: (self.path.write_bytes(self.raw+b' ') or {})
        with self.assertRaises(ValueError): self.check()

    def test_protected_file_failure_or_live_health_failure_does_not_pass(self):
        for key in ('files', 'volumes', 'assigned'):
            self.mocks[key].side_effect = ValueError('fixture refusal')
            with self.subTest(key=key), self.assertRaises(ValueError): self.check()
            self.mocks[key].side_effect = None


if __name__ == '__main__': unittest.main()
