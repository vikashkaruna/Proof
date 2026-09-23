"""Explicit enrollment cannot silently initialize or authorize changed state."""
import contextlib
import base64
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'infra/workload'))
import spire_enrollment as enroll

SHA = 'a'*64
BINDING = {'schemaVersion':1,'role':'issuer','filesystemUuid':'11111111-1111-4111-8111-111111111111','trustDomain':'test.axiomproof.test','nodeId':None}
FINGERPRINT = {'keysSha256':'b'*64,'registrySha256':'c'*64}
PUBLIC_BUNDLE=b'fixture public bundle';BOOTSTRAP=b'fixture public CA'
TRUST = {'bundleSha256':enroll.digest(PUBLIC_BUNDLE),'bootstrapCaSha256':enroll.digest(BOOTSTRAP),'x509Authorities':1,'jwtAuthorities':1}


class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve();self.state=self.base/'state';self.state.mkdir(mode=0o700)
        for name in ('REQUEST','RECEIPT','APPROVAL','PERMIT','LOCK','BUNDLE','CA'):
            p=patch.object(enroll,name,self.base/(name+'.json'));p.start();self.addCleanup(p.stop)
        for p in (patch.object(enroll.state,'STATE',self.state),patch.object(enroll.host,'OWNER',os.geteuid()),patch.object(enroll.host,'protected_directory'),patch.object(enroll,'installed',return_value=BINDING.copy()),patch.object(enroll,'idle'),patch.object(enroll.state,'check'),patch.object(enroll,'fingerprint',return_value=FINGERPRINT.copy()),patch.object(enroll,'process_start',return_value='1234'),patch.object(enroll,'trust',return_value=(TRUST.copy(),PUBLIC_BUNDLE,BOOTSTRAP)),patch.object(enroll,'control',side_effect=self.control)):
            p.start();self.addCleanup(p.stop)

    def control(self,*args):
        if args == ('start',enroll.INITIAL):
            self.assertEqual(enroll.load(enroll.REQUEST)['manifestSha256'],SHA)
            self.assertTrue(enroll.PERMIT.exists())
            with patch.object(enroll,'exclusive',side_effect=BlockingIOError):
                enroll.permit()
        return b''

    def initialize(self):
        return enroll.initialize(SHA)

    def test_initialize_records_before_start_and_leaves_unmarked_state(self):
        reviewed=self.initialize()
        self.assertEqual(reviewed,enroll.digest(enroll.RECEIPT.read_bytes()))
        self.assertFalse(enroll.PERMIT.exists());self.assertFalse((self.state/'.axiom-state.json').exists())
        self.assertFalse(enroll.APPROVAL.exists())
        self.assertEqual(enroll.load(enroll.RECEIPT)['state'],FINGERPRINT)
        enroll.control.assert_any_call('stop',enroll.INITIAL)
        self.assertEqual(enroll.RECEIPT.stat().st_mode & 0o777,0o600)

    def test_expired_permit_refuses_start_and_leaves_request_for_review(self):
        def reject(*args):
            if args == ('start',enroll.INITIAL):
                value=enroll.load(enroll.PERMIT)
                value['createdAtMs']-=120000;value['expiresAtMs']-=120000
                enroll.PERMIT.write_bytes(enroll.encode(value))
                enroll.permit()
            return b''
        with patch.object(enroll,'control',side_effect=reject):
            with self.assertRaisesRegex(ValueError,'permit expired'):self.initialize()
        self.assertTrue(enroll.REQUEST.exists());self.assertFalse(enroll.RECEIPT.exists())
        self.assertFalse(enroll.PERMIT.exists())

    def test_changed_process_or_unheld_lock_refuses_permit(self):
        def reject(*args):
            if args == ('start',enroll.INITIAL):
                with patch.object(enroll,'process_start',return_value='different'):
                    with self.assertRaisesRegex(ValueError,'process changed'):enroll.permit()
                with patch.object(enroll,'exclusive',return_value=contextlib.nullcontext()):
                    enroll.permit()
            return b''
        with patch.object(enroll,'control',side_effect=reject):
            with self.assertRaisesRegex(ValueError,'owner absent'):self.initialize()
        self.assertTrue(enroll.REQUEST.exists());self.assertFalse(enroll.RECEIPT.exists())

    def test_seal_requires_second_review_and_does_not_activate(self):
        reviewed=self.initialize();enroll.control.reset_mock()
        enroll.seal(reviewed)
        self.assertEqual(json.loads((self.state/'.axiom-state.json').read_text()),BINDING)
        self.assertEqual(enroll.load(enroll.APPROVAL)['receiptSha256'],reviewed)
        enroll.control.assert_not_called()
        enroll.state.check.assert_any_call('--ready','issuer')

    def test_failed_start_preserves_request_and_stops_without_receipt(self):
        with patch.object(enroll,'control',side_effect=[ValueError('start refused'),b'']):
            with self.assertRaises(ValueError):self.initialize()
        self.assertTrue(enroll.REQUEST.exists());self.assertFalse(enroll.RECEIPT.exists());self.assertFalse(enroll.PERMIT.exists())
        self.assertFalse((self.state/'.axiom-state.json').exists())
        enroll.control.reset_mock()
        with self.assertRaises(ValueError):self.initialize()
        enroll.control.assert_not_called()

    def test_unstable_initial_trust_cannot_get_a_receipt(self):
        with patch.object(enroll,'trust',side_effect=[(TRUST,PUBLIC_BUNDLE,BOOTSTRAP),({**TRUST,'bundleSha256':'e'*64},PUBLIC_BUNDLE,BOOTSTRAP)]):
            with self.assertRaises(ValueError):self.initialize()
        self.assertFalse(enroll.RECEIPT.exists());self.assertFalse(enroll.PERMIT.exists())
        self.assertTrue(enroll.REQUEST.exists())
        enroll.control.assert_any_call('stop',enroll.INITIAL)

    def test_receipt_hash_mismatch_never_creates_approval(self):
        self.initialize()
        with self.assertRaises(ValueError):enroll.seal('0'*64)
        self.assertFalse(enroll.APPROVAL.exists());self.assertFalse((self.state/'.axiom-state.json').exists())

    def test_changed_state_refused_before_approval(self):
        reviewed=self.initialize()
        with patch.object(enroll,'fingerprint',return_value={**FINGERPRINT,'keysSha256':'e'*64}):
            with self.assertRaises(ValueError):enroll.seal(reviewed)
        self.assertFalse(enroll.APPROVAL.exists());self.assertFalse((self.state/'.axiom-state.json').exists())

    def test_reviewed_public_bundle_and_ca_cannot_change(self):
        reviewed=self.initialize()
        for path in (enroll.BUNDLE,enroll.CA):
            original=path.read_bytes();path.write_bytes(original+b'changed')
            with self.assertRaisesRegex(ValueError,'public trust changed'):enroll.seal(reviewed)
            self.assertFalse(enroll.APPROVAL.exists())
            path.write_bytes(original)

    def test_change_after_recorded_approval_stays_unmarked(self):
        reviewed=self.initialize()
        with patch.object(enroll,'fingerprint',side_effect=[FINGERPRINT,{**FINGERPRINT,'registrySha256':'e'*64}]):
            with self.assertRaises(ValueError):enroll.seal(reviewed)
        self.assertTrue(enroll.APPROVAL.exists());self.assertFalse((self.state/'.axiom-state.json').exists())
        with self.assertRaises(ValueError):enroll.seal(reviewed)

    def test_changed_binding_or_active_service_refused(self):
        reviewed=self.initialize()
        with patch.object(enroll,'installed',return_value={**BINDING,'trustDomain':'other.test'}):
            with self.assertRaises(ValueError):enroll.seal(reviewed)
        with patch.object(enroll,'idle',side_effect=ValueError('active')):
            with self.assertRaises(ValueError):enroll.seal(reviewed)
        self.assertFalse(enroll.APPROVAL.exists())

    def test_successful_records_and_marker_are_never_overwritten(self):
        reviewed=self.initialize();enroll.seal(reviewed)
        before={p:p.read_bytes() for p in (enroll.REQUEST,enroll.RECEIPT,enroll.APPROVAL,self.state/'.axiom-state.json')}
        with self.assertRaises(ValueError):self.initialize()
        with self.assertRaises(ValueError):enroll.seal(reviewed)
        self.assertEqual(before,{p:p.read_bytes() for p in before})

    def test_existing_permit_or_foreign_record_refuses_initialization(self):
        enroll.create(enroll.PERMIT,b'foreign')
        with self.assertRaises(ValueError):self.initialize()
        self.assertEqual(enroll.PERMIT.read_bytes(),b'foreign');self.assertFalse(enroll.REQUEST.exists())
        enroll.control.assert_not_called()


class PrimitiveTests(unittest.TestCase):
    def test_bundle_summary_covers_both_authorities_and_ignores_order(self):
        keys=[{'use':'jwt-svid','kty':'EC','kid':'one','x':'fixture'},{'use':'x509-svid','kty':'EC','x5c':[base64.b64encode(b'\x30'+b'x'*40).decode()]}]
        a=enroll.trust_summary(json.dumps({'keys':keys}).encode())
        b=enroll.trust_summary(json.dumps({'keys':list(reversed(keys))}).encode())
        self.assertEqual(a,b);self.assertEqual(a['jwtAuthorities'],1);self.assertEqual(a['x509Authorities'],1)

    def test_incomplete_duplicate_or_private_bundle_is_refused(self):
        keys=[{'use':'jwt-svid','kty':'EC'},{'use':'x509-svid','kty':'EC'}]
        for value in ({'keys':keys[:1]},{'keys':[keys[0],{**keys[1],'d':'private'}]},{'keys':[keys[0],{**keys[1],'use':'other'}]}):
            with self.assertRaises(ValueError):enroll.trust_summary(json.dumps(value).encode())
        with self.assertRaises(ValueError):enroll.trust_summary(b'{"keys":[],"keys":[]}')

    def test_idle_requires_no_process_job_or_enablement(self):
        normal=b'ActiveState=inactive\nMainPID=0\nJob=\nUnitFileState=disabled\nFragmentPath=/etc/systemd/system/axiom-spire-issuer.service\nDropInPaths=\nNeedDaemonReload=no\nTransient=no\n'
        for value in (normal.replace(b'inactive',b'active'),normal.replace(b'MainPID=0',b'MainPID=99'),normal.replace(b'Job=\n',b'Job=5\n'),normal.replace(b'disabled',b'enabled'),normal.replace(b'DropInPaths=\n',b'DropInPaths=/etc/override.conf\n'),normal.replace(b'NeedDaemonReload=no',b'NeedDaemonReload=yes'),normal.replace(b'Transient=no',b'Transient=yes'),normal.replace(b'/etc/systemd/system/',b'/run/systemd/system/')):
            with patch.object(enroll,'control',return_value=value),self.assertRaises(ValueError):enroll.idle(enroll.NORMAL)
        with patch.object(enroll,'control',return_value=normal):enroll.idle(enroll.NORMAL)
        with patch.object(enroll,'control',return_value=normal.replace(b'disabled',b'static').replace(b'axiom-spire-issuer.service',b'axiom-spire-enroll-issuer.service')):enroll.idle(enroll.INITIAL)

    def test_command_bounds_output_deadline_and_diagnostics(self):
        self.assertEqual(enroll.command([sys.executable,'-c',"print('fixture')"]),b'fixture\n')
        with self.assertRaises(ValueError):enroll.command([sys.executable,'-c',"print('x'*1000)"],maximum=32)
        with self.assertRaises(ValueError):enroll.command([sys.executable,'-c','import time;time.sleep(3)'],timeout=0.1)
        with self.assertRaisesRegex(ValueError,'enrollment command refused'):
            enroll.command([sys.executable,'-c',"import sys;sys.stderr.write('private-fixture');sys.exit(2)"])

    def test_create_is_exclusive_and_preserves_existing_record(self):
        with tempfile.TemporaryDirectory() as temporary,patch.object(enroll.host,'protected_directory'):
            path=Path(temporary)/'record'
            enroll.create(path,b'first')
            with self.assertRaises(FileExistsError):enroll.create(path,b'second')
            self.assertEqual(path.read_bytes(),b'first');self.assertEqual(path.stat().st_mode & 0o777,0o600)


if __name__=='__main__':unittest.main()
