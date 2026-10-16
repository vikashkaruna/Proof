import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, chmodSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registeredBrowserRequested,
  registeredBrowserConfigSchema,
  writeRegisteredBrowserFile,
  readRegisteredBrowserFile,
  validateRegisteredSubmission,
  waitForRegisteredSubmission,
} from './acceptance-public-asset-browser.js';
const config = () => {
  const tenantId = randomUUID();
  return registeredBrowserConfigSchema.parse({
    version: 1,
    kind: 'owned-demo-registered-website-browser',
    nonce: randomBytes(16).toString('hex'),
    codeSha: 'a'.repeat(40),
    databaseId: 'b'.repeat(64),
    projectId: 'axiom-owned-test',
    apiOrigin: 'http://127.0.0.1:56321',
    bffOrigin: 'http://127.0.0.1:4400',
    tenantId,
    tenantSlug: `worker-${tenantId}`,
    actorId: randomUUID(),
    estateId: randomUUID(),
    systemId: randomUUID(),
    engagementId: randomUUID(),
    isDemo: true,
    publicUrl: 'https://fixture.axiomproof.ai/',
    email: `fixture-${randomUUID()}@example.invalid`,
    password: randomBytes(32).toString('hex'),
    loginSecret: 'ABCDEFGHIJKLMNOP',
  });
};
function submission(c = config()) {
  const jobId = randomUUID(),
    reviewId = randomUUID();
  const requestText = JSON.stringify({
    operationKey: jobId,
    engagementId: c.engagementId,
    answers: {},
    applicability: { sdfSelfAttested: null, processesChildren: null, processesHealth: null },
    reviewRef: { reviewId, requestSha256: 'c'.repeat(64), snapshotSha256: 'd'.repeat(64) },
  });
  return {
    version: 1,
    nonce: c.nonce,
    tenantId: c.tenantId,
    actorId: c.actorId,
    engagementId: c.engagementId,
    checkId: randomUUID(),
    bindingId: randomUUID(),
    drishtiObservationId: randomUUID(),
    vibhaagObservationId: randomUUID(),
    targetId: randomUUID(),
    associationId: randomUUID(),
    associationSha256: 'e'.repeat(64),
    targetSha256: 'f'.repeat(64),
    reviewId,
    reviewRequestSha256: 'c'.repeat(64),
    reviewSnapshotSha256: 'd'.repeat(64),
    jobId,
    runId: randomUUID(),
    requestText,
    requestSha256: createHash('sha256').update(requestText).digest('hex'),
    observedStatus: 202,
  };
}
test('registered fixture is opt-in and never enables ordinary report/default mode', () => {
  assert.equal(registeredBrowserRequested({}), false);
  assert.throws(() => registeredBrowserRequested({ AXIOM_REGISTERED_WEBSITE_BROWSER: 'true' }));
  assert.throws(() => registeredBrowserRequested({ AXIOM_REGISTERED_WEBSITE_BROWSER: 'false' }));
  assert.equal(
    registeredBrowserRequested({
      AXIOM_REGISTERED_WEBSITE_BROWSER: 'true',
      AXIOM_PUBLIC_CONTROL_REPORT_ACCEPTANCE: 'true',
    }),
    true,
  );
});
test('same-source submission binds exact human, tenant, review and canonical request bytes', () => {
  const c = config(),
    s = submission(c);
  assert.deepEqual(validateRegisteredSubmission(c, s), s);
  for (const field of ['actorId', 'tenantId', 'engagementId', 'reviewId', 'jobId'] as const)
    assert.throws(() => validateRegisteredSubmission(c, { ...s, [field]: randomUUID() }));
  assert.throws(() => validateRegisteredSubmission(c, { ...s, nonce: '0'.repeat(32) }));
  assert.throws(() => validateRegisteredSubmission(c, { ...s, requestText: s.requestText + ' ' }));
  const duplicated = s.requestText.replace('{', '{"operationKey":"' + s.jobId + '",');
  assert.throws(() =>
    validateRegisteredSubmission(c, {
      ...s,
      requestText: duplicated,
      requestSha256: createHash('sha256').update(duplicated).digest('hex'),
    }),
  );
});
test('config refuses non-owned targets, real tenant and raw control or workload fields', () => {
  const c = config();
  for (const change of [
    { isDemo: false },
    { bffOrigin: 'https://app.axiomproof.ai' },
    { apiOrigin: 'http://127.0.0.1:54321' },
    { tenantSlug: 'customer' },
    { email: 'operator@customer.example' },
    { serviceKey: 'secret' },
    { workloadToken: 'secret' },
  ])
    assert.equal(registeredBrowserConfigSchema.safeParse({ ...c, ...change }).success, false);
});
test('private files reject overwrite, weak permissions, symlinks, malformed and oversized values', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-owned-browser-')));
  try {
    const c = config();
    writeRegisteredBrowserFile(dir, 'config', c);
    assert.deepEqual(readRegisteredBrowserFile(dir, 'config'), c);
    assert.throws(() => writeRegisteredBrowserFile(dir, 'config', c));
    const path = join(dir, 'config.private.json');
    chmodSync(path, 0o644);
    assert.throws(() => readRegisteredBrowserFile(dir, 'config'));
    rmSync(path);
    symlinkSync(join(dir, 'absent'), path);
    assert.throws(() => readRegisteredBrowserFile(dir, 'config'));
    rmSync(path);
    writeFileSync(path, 'x'.repeat(65_537), { mode: 0o600 });
    assert.throws(() => readRegisteredBrowserFile(dir, 'config'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('rendezvous keeps original bounded deadline and refuses dead browser, wrong source or malformed receipt', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-owned-browser-')));
  try {
    const c = config();
    await assert.rejects(
      waitForRegisteredSubmission(dir, c, {
        deadline: Date.now() - 1,
        signal: new AbortController().signal,
        browserAlive: () => true,
      }),
    );
    await assert.rejects(
      waitForRegisteredSubmission(dir, c, {
        deadline: Date.now() + 1000,
        signal: new AbortController().signal,
        browserAlive: () => false,
      }),
    );
    writeRegisteredBrowserFile(dir, 'submission', submission(c));
    const s = await waitForRegisteredSubmission(dir, c, {
      deadline: Date.now() + 1000,
      signal: new AbortController().signal,
      browserAlive: () => true,
    });
    assert.equal(s.actorId, c.actorId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('owned verifier timeout removes its child/grandchild without touching another process group', () => {
  const script = String.raw`
import ast, os, signal, subprocess, sys, tempfile, pathlib, time
source=pathlib.Path('scripts/test-workload-identity.py').read_text()
module=ast.parse(source)
function=next(node for node in module.body if isinstance(node,ast.FunctionDef) and node.name=='run_owned_verifier')
namespace={'os':os,'signal':signal,'subprocess':subprocess,'ROOT':pathlib.Path.cwd()}
exec(compile(ast.Module(body=[function],type_ignores=[]),'<owned-fixture-cleanup>','exec'),namespace)
unrelated=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'],start_new_session=True)
try:
 with tempfile.TemporaryDirectory(prefix='axiom-owned-cleanup-') as directory:
  pidfile=pathlib.Path(directory)/'child.pid'
  child="import pathlib,subprocess,sys,time;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)']);pathlib.Path(sys.argv[1]).write_text(str(p.pid));time.sleep(10)"
  try:
   namespace['run_owned_verifier']([sys.executable,'-c',child,str(pidfile)],None,0.5)
   raise AssertionError('original deadline not enforced')
  except subprocess.TimeoutExpired: pass
  grandchild=int(pidfile.read_text())
  state=subprocess.run(['ps','-o','stat=','-p',str(grandchild)],capture_output=True,text=True,check=False).stdout.strip()
  if state and not state.startswith('Z'): raise AssertionError('owned grandchild still running')
  if unrelated.poll() is not None: raise AssertionError('unrelated process touched')
finally:
 unrelated.kill();unrelated.communicate()
print('owned-cleanup-passed')
`;
  const result = spawnSync('python3', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, 'owned process cleanup regression failed');
  assert.equal(result.stdout.trim(), 'owned-cleanup-passed');
});

test('registered detached groups require exact nonce and kernel birth before cleanup; unrelated group survives', () => {
  const script = String.raw`
import ast, ctypes, hashlib, json, os, pathlib, platform, re, signal, subprocess, sys, tempfile, time
source=pathlib.Path('scripts/test-workload-identity.py').read_text();module=ast.parse(source)
names={'owned_process_birth','read_owned_browser_json','register_owned_browser_group','cleanup_owned_browser_groups'}
namespace={**globals(),'ROOT':pathlib.Path.cwd(),'Path':pathlib.Path,'stat':__import__('stat')}
exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),'<owned-registry>','exec'),namespace)
unrelated=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
child=None
try:
 with tempfile.TemporaryDirectory(prefix='axiom-owned-detached-') as directory:
  nonce='a'*32;code='b'*40
  launcher="import ast,ctypes,hashlib,json,os,pathlib,platform,re,signal,subprocess,sys,time;from pathlib import Path;import stat;module=ast.parse(Path('scripts/test-workload-identity.py').read_text());names={'owned_process_birth','register_owned_browser_group'};exec(compile(ast.Module(body=[n for n in module.body if isinstance(n,ast.FunctionDef) and n.name in names],type_ignores=[]),'<owned-registry-child>','exec'));register_owned_browser_group(Path(sys.argv[1]),sys.argv[2],sys.argv[3],'next');signal.signal(signal.SIGINT,signal.SIG_IGN);grandchild=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);time.sleep(30)']);Path(sys.argv[1]+'/grandchild.pid').write_text(str(grandchild.pid));time.sleep(30)"
  child=subprocess.Popen([sys.executable,'-c',launcher,directory,nonce,code],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  deadline=time.monotonic()+2
  path=pathlib.Path(directory)/('group-'+str(child.pid)+'.private.json')
  while time.monotonic()<deadline and not pathlib.Path(directory,'grandchild.pid').exists():time.sleep(.02)
  record=json.loads(path.read_text());grandchild=int(pathlib.Path(directory,'grandchild.pid').read_text())
  assert record['pid']==record['pgid']==child.pid and os.getpgid(child.pid)!=os.getpgrp()
  for change in [{'nonce':'c'*32},{'birth':'stale-kernel-identity'}]:
   path.write_text(json.dumps({**record,**change}));path.chmod(0o600)
   try:namespace['cleanup_owned_browser_groups'](pathlib.Path(directory),nonce,code,.1);raise AssertionError('invalid registry accepted')
   except RuntimeError:pass
   assert child.poll() is None and unrelated.poll() is None
  path.write_text(json.dumps(record));path.chmod(0o600)
  result=namespace['cleanup_owned_browser_groups'](pathlib.Path(directory),nonce,code,.1)
  assert result=={'registeredGroups':1,'signalledGroups':1}
  child.communicate(timeout=2)
  state=subprocess.run(['ps','-o','stat=','-p',str(grandchild)],capture_output=True,text=True,check=False).stdout.strip()
  assert not state or state.startswith('Z')
  assert unrelated.poll() is None
finally:
 if child and child.poll() is None:os.killpg(child.pid,signal.SIGKILL);child.communicate()
 unrelated.kill();unrelated.communicate()
print('detached-registry-passed')
`;
  const result = spawnSync('python3', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, 'detached registry regression failed');
  assert.equal(result.stdout.trim(), 'detached-registry-passed');
});

test('hash-bound launcher refuses wrong nonce and preserves Playwright inherited CDP pipe descriptors through exec', () => {
  const script = String.raw`
import hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile
root=pathlib.Path.cwd();base=root/'.axiom-runtime';base.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='owned-launcher-unit-',dir=base) as folder:
 directory=pathlib.Path(folder).resolve();directory.chmod(0o700)
 nonce='a'*32;code=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
 binary=directory/'synthetic-cdp-executable'
 binary.write_text('#!'+sys.executable+'\nimport os,pathlib\nos.write(4,b"owned-cdp")\nassert os.read(3,9)==b"owned-cdp"\npathlib.Path(os.environ["OWNED_CDP_RESULT"]).write_text("pipes-preserved")\n');binary.chmod(0o700)
 def entry(path):
  p=pathlib.Path(path).resolve();return {'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
 config={'version':1,'nonce':nonce,'codeSha':code,'root':str(root),'python':entry(sys.executable),'node':entry(sys.executable),'next':entry(binary),'chromium':entry(binary)}
 path=directory/'launch-config.private.json';path.write_text(json.dumps(config));path.chmod(0o600)
 command=[sys.executable,'scripts/test-workload-identity.py','--owned-browser-launch','chromium',str(directory)]
 refused=subprocess.run(command+['c'*32,code,'--remote-debugging-pipe'],capture_output=True,text=True,check=False)
 assert refused.returncode==1 and not list(directory.glob('group-*.private.json'))
 original=config['chromium']['sha256'];config['chromium']['sha256']='f'*64;path.write_text(json.dumps(config))
 refused=subprocess.run(command+[nonce,code,'--remote-debugging-pipe'],capture_output=True,text=True,check=False)
 assert refused.returncode==1 and not list(directory.glob('group-*.private.json'))
 config['chromium']['sha256']=original;path.write_text(json.dumps(config))
 read,write=os.pipe()
 try:
  # Fresh synthetic Python test owns only these pipe ends. FD3/4 are exactly
  # the Playwright processLauncher pipe contract; no browser is launched here.
  assert (read,write)==(3,4)
  env={**os.environ,'OWNED_CDP_RESULT':str(directory/'result.private')}
  child=subprocess.Popen(command+[nonce,code,'--remote-debugging-pipe'],pass_fds=(3,4),start_new_session=True,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  assert child.wait(timeout=3)==0
  assert (directory/'result.private').read_text()=='pipes-preserved'
  record=json.loads(next(directory.glob('group-*.private.json')).read_text())
  assert record['pid']==record['pgid']==child.pid and record['nonce']==nonce
 finally:os.close(read);os.close(write)
print('cdp-pipes-passed')
`;
  const result = spawnSync('python3', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, 'owned CDP exec regression failed');
  assert.equal(result.stdout.trim(), 'cdp-pipes-passed');
});
