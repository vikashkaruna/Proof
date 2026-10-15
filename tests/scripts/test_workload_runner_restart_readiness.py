"""Pure deterministic tests of the native fixture restart observation, no host actions."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/test-workload-runner-systemd.py'
SERVICE = 'axiom-spire-runner.service'
HEALTH = 'axiom-spire-health.service'


class Clock:
    def __init__(self):
        self.elapsed = 0

    def monotonic(self):
        return self.elapsed

    def time_ns(self):
        return int((100010 + self.elapsed * 1000) * 1000000)

    def sleep(self, seconds):
        self.elapsed += seconds


class RestartReadiness(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.commands = []
        self.failures = {}
        self.foreign_node = False
        self.late = False
        self.restarted = True
        self.clock_transition = 1
        self.volume_calls = []
        self.messages = []
        self.env = {'time': self.clock, 'SERVICE': SERVICE, 'HEALTH': HEALTH,
                    'fixture': SimpleNamespace(subprocess=SimpleNamespace(TimeoutExpired=TimeoutError)),
                    'control': self.control, 'health': self.health, 'run': self.fake_run,
                    'print': lambda *args, **kwargs: self.messages.append(' '.join(map(str, args)))}
        self.tree = ast.parse(SOURCE.read_text())
        functions = [n for n in self.tree.body if isinstance(n, ast.FunctionDef) and n.name != 'main']
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), 'exec'), self.env)
        # Restore fake health: its production definition only reads a local file.
        self.env['health'] = self.health

    def health(self):
        if not self.restarted:
            return {'healthy': True, 'observedAtMs': 100000, 'syncAtMs': 99999}
        current = self.clock.elapsed >= self.clock_transition and not self.late
        return {'healthy': True, 'observedAtMs': int(100010+self.clock.elapsed*1000) if current else 100005,
                'syncAtMs': int(100009+self.clock.elapsed*1000) if current else 100004,
                'certificateExpiresAtMs': 99999999,
                'nodeId': 'foreign' if self.foreign_node else 'reviewed-node'}

    def control(self, *args, **kwargs):
        self.commands.append((args, kwargs))
        if args == ('restart', SERVICE):
            self.restarted = True
            return SimpleNamespace(returncode=0, stdout=b'')
        self.assertEqual(args[0], 'show')
        unit = args[-1]
        self.assertIn(unit, (SERVICE, HEALTH))
        ready = self.clock.elapsed >= self.clock_transition or unit == SERVICE
        fields = {'ActiveState': 'active' if ready else 'activating',
                  'SubState': 'running' if ready else 'start-pre', 'MainPID': '123',
                  'FragmentPath': '/etc/systemd/system/'+unit, 'DropInPaths': '',
                  'NeedDaemonReload': 'no', 'Transient': 'no'}
        fields.update(self.failures)
        return SimpleNamespace(returncode=0, stdout='\n'.join(k+'='+v for k, v in fields.items()).encode())

    def fake_run(self, *args, **kwargs):
        self.volume_calls.append(args[0])
        raise RuntimeError('SECRET arbitrary subprocess error')

    def restart_window(self):
        main = next(n for n in self.tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        body = next(n for n in main.body if isinstance(n, ast.Try)).body
        anchor = next(i for i, n in enumerate(body) if isinstance(n, ast.Assign)
                      and any(isinstance(t, ast.Subscript) and isinstance(t.slice, ast.Constant)
                              and t.slice.value == 'controller-delivery-does-not-require-or-claim-runtime-activation'
                              for t in n.targets))
        stop = next(i for i in range(anchor+1, len(body)) if isinstance(body[i], ast.Expr)
                    and isinstance(body[i].value, ast.Call) and isinstance(body[i].value.func, ast.Name)
                    and body[i].value.func.id == 'check')
        self.restarted = False
        self.env['expected'] = 'reviewed-node'
        exec(compile(ast.Module(body=body[anchor+1:stop], type_ignores=[]), str(SOURCE), 'exec'),
             self.env)

    def test_actual_restart_window_rejects_old_observer_and_start_pre(self):
        # The old observer publishes after the pre-restart snapshot, but before
        # restart completion. Old fixture healthy()+timestamp predicate accepts it.
        self.restart_window()
        self.assertGreaterEqual(self.clock.elapsed, 1)
        self.assertLess(self.clock.elapsed, 40)
        queried = [args[-1] for args, _ in self.commands if args[0] == 'show']
        self.assertIn(SERVICE, queried)
        self.assertIn(HEALTH, queried)

    def test_original_deadline_is_not_renewed_per_phase(self):
        self.clock_transition = 100
        with self.assertRaisesRegex(ValueError, 'observation timed out'):
            self.restart_window()
        self.assertEqual(self.clock.elapsed, 40)
        self.assertFalse(self.volume_calls)

    def test_systemctl_timeouts_share_the_original_deadline(self):
        calls = []

        def unavailable(*args, **kwargs):
            budget = kwargs['timeout']
            calls.append(budget)
            self.assertLessEqual(budget, 3)
            self.clock.elapsed += budget
            raise TimeoutError('SECRET query details')

        self.env['control'] = unavailable
        with self.assertRaisesRegex(ValueError, 'observation timed out'):
            self.env['wait_for_reviewed_restart'](100010, 'reviewed-node')
        self.assertEqual(self.clock.elapsed, 40)
        self.assertTrue(calls)
        self.assertFalse(self.volume_calls)

    def test_each_exact_production_unit_property_remains_required(self):
        self.clock.elapsed = 2
        bad = {'ActiveState': 'activating', 'SubState': 'start-pre', 'MainPID': '0',
               'FragmentPath': '/tmp/SECRET-unit', 'DropInPaths': 'SECRET-override',
               'NeedDaemonReload': 'yes', 'Transient': 'yes'}
        for key, value in bad.items():
            with self.subTest(key=key):
                self.failures = {key: value}
                self.assertFalse(self.env['reviewed_restart_ready'](100010, 'reviewed-node', 40))
        self.failures = {}
        self.assertTrue(self.env['reviewed_restart_ready'](100010, 'reviewed-node', 40))

    def test_current_units_do_not_make_old_or_foreign_health_current(self):
        self.clock.elapsed = 2
        self.late = True
        self.assertFalse(self.env['reviewed_restart_ready'](100010, 'reviewed-node', 40))
        self.late = False
        self.foreign_node = True
        self.assertFalse(self.env['reviewed_restart_ready'](100010, 'reviewed-node', 40))

    def test_failed_volume_assertion_runs_once_and_reports_only_categories(self):
        self.failures = {'FragmentPath': '/tmp/SECRET-unit', 'DropInPaths': 'SECRET-override'}
        with self.assertRaises(RuntimeError):
            self.env['check_restart_volumes'](['python', 'volume.py'], 'digest')
        self.assertEqual(self.volume_calls, [['python', 'volume.py', '--check', 'digest']])
        output = '\n'.join(self.messages)
        self.assertIn('FragmentPath', output)
        self.assertIn('DropInPaths', output)
        self.assertNotIn('SECRET', output)


if __name__ == '__main__':
    unittest.main()
