/** Real UID-attested worker → private Hono tools → real PostgREST transactions.
 * Only synthetic fixtures in the isolated local parity project. No private
 * frame, token, service key, subprocess stderr or raw exception is emitted. */
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { JwtSvidVerifier } from '../services/bff/src/workloads/jwt-svid.js';
import {
  WorkloadAuthenticator,
  SupabaseWorkloadRegistrationStore,
} from '../services/bff/src/workloads/registration.js';
import {
  WorkloadTaskAuthority,
  SupabaseWorkloadTaskStore,
  WorkloadTaskIssuer,
} from '../services/bff/src/workloads/tasks.js';
import { AssessmentDispatch } from '../services/bff/src/workloads/assessment-dispatch.js';
import { PrivateAssessmentPayload } from '../services/bff/src/workloads/dispatch-payload.js';
import { AssessmentChannel } from '../services/bff/src/workloads/assessment-channel.js';
import { AssessmentController } from '../services/bff/src/workloads/assessment-controller.js';
import type { DispatchKeyWrapper } from '../services/bff/src/workloads/dispatch-payload.js';
import { TaskProof } from '../services/bff/src/workloads/tasks.js';
import { AssessmentConfirmation } from '../services/bff/src/workloads/assessment-confirmation.js';
import { AssessmentTools } from '../services/bff/src/workloads/assessment-tools.js';
import { workloadToolsRoutes } from '../services/bff/src/routes/workload-tools.js';
let phase = 'setup';
const outcomes: Record<string, boolean> = {};
async function main() {
  const input = z
    .object({
      containerName: z.string().regex(/^axiom-spire-test-[a-f0-9]{12}$/),
      jwks: z.unknown(),
    })
    .strict()
    .parse(JSON.parse(readFileSync(0, 'utf8')));
  const status = JSON.parse(readFileSync('.axiom-runtime/parity/status.json', 'utf8')) as Record<
    string,
    string
  >;
  const url = new URL(status.API_URL!);
  assert(
    url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.port === '56321' &&
      !url.username &&
      !url.password,
  );
  const db = createClient(url.origin, status.SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const check = <T>(reply: { data: T; error: unknown }): T => {
    if (reply.error) throw new Error('database operation failed');
    return reply.data;
  };
  const tenantId = randomUUID();
  const workloadId = randomUUID();
  const createdResponse = await db.auth.admin.createUser({
    email: `worker-${randomUUID()}@example.invalid`,
    email_confirm: true,
  });
  if (createdResponse.error) throw new Error('auth fixture failed');
  const created = createdResponse.data;
  const actorId = created.user!.id;
  check(await db.from('users').insert({ id: actorId, email: created.user!.email }));
  check(
    await db
      .from('tenants')
      .insert({ id: tenantId, slug: `worker-${tenantId}`, name: 'Synthetic isolated assessment' }),
  );
  check(
    await db.from('tenant_users').insert({ tenant_id: tenantId, user_id: actorId, role: 'owner' }),
  );
  check(
    await db.from('workload_identities').insert({
      id: workloadId,
      tenant_id: tenantId,
      agent_name: 'parikshan',
      spiffe_id: 'spiffe://local.axiomproof.test/agent/parikshan',
      status: 'active',
    }),
  );
  const version = `worker-${randomUUID()}`;
  check(
    await db.from('control_libraries').insert({
      version,
      published_at: new Date().toISOString(),
      published_by: 'isolated-acceptance',
      change_log: 'Synthetic scoring fixture',
      control_count: 2,
    }),
  );
  check(
    await db.from('controls').insert(
      [1, 2].map((n) => ({
        id: `WA-${n}`,
        library_version: version,
        title: 'Synthetic control',
        obligation: 'Synthetic obligation',
        domain: 'SEC',
        severity: 'low',
        citations: [{ instrument: 'Synthetic', reference: 'Test' }],
        evidence_required: [],
        assessment_questions: [{ id: 'Q1', type: 'boolean' }],
        scoring: { baseline: 0, weight: 1, penaltyPoints: 10, maxPenaltyINR: 1000000 },
        remediation_patterns: [],
        introduced_in_version: version,
      })),
    ),
  );
  let trustCurrent = true;
  const trust = {
    async load() {
      return { revision: 'isolated-current', validUntil: Date.now() + 60000, jwks: input.jwks };
    },
    async stillCurrent() {
      return trustCurrent;
    },
  };
  const authority = new WorkloadTaskAuthority(
    new WorkloadAuthenticator(
      new JwtSvidVerifier(
        {
          audience: 'axiom-assessment-tools',
          trustDomains: ['local.axiomproof.test'],
          maxLifetimeSeconds: 300,
        },
        trust,
      ),
      new SupabaseWorkloadRegistrationStore(db),
    ),
    new SupabaseWorkloadTaskStore(db),
  );
  const router = workloadToolsRoutes(new AssessmentTools(authority, db));
  const launchSupervised = () =>
    spawn(
      'docker',
      [
        'exec',
        '--user',
        '0',
        '-i',
        input.containerName,
        'python',
        '-m',
        'axiom.assessment_supervisor',
        '--private-stdio',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
  const callTool = async (operation: string, request: unknown) => {
    const response = await router.request(`/assessment/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error('tool_refused');
    return response.json() as Promise<unknown>;
  };

  const issuer = new WorkloadTaskIssuer(db);
  const confirmation = new AssessmentConfirmation(db);
  // Local synthetic wrapping provider; the wrapping key never enters SQL, IPC,
  // environment, process arguments or the isolated worker. Production requires KMS.
  const wrappingKey = randomBytes(32);
  const wrapper: DispatchKeyWrapper = {
    async wrap(aad, key) {
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
      cipher.setAAD(aad);
      return {
        keyRef: 'local-synthetic/dispatch-v1',
        wrappedKey: Buffer.concat([nonce, cipher.update(key), cipher.final(), cipher.getAuthTag()]),
      };
    },
    async unwrap(aad, keyRef, encrypted) {
      assert.equal(keyRef, 'local-synthetic/dispatch-v1');
      const value = Buffer.from(encrypted),
        decipher = createDecipheriv('aes-256-gcm', wrappingKey, value.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]);
    },
  };

  // These probes run under the same UID and image as the actual worker.
  phase = 'physical-isolation';
  const probe = `import os, pathlib, socket, importlib.util, json
assert os.getuid() == 20003
assert not any(k in os.environ for k in ['SUPABASE_URL','SUPABASE_SERVICE_KEY','APPROVAL_SIGNING_KEY','AWS_ACCESS_KEY_ID','GOOGLE_APPLICATION_CREDENTIALS','AGENT_RUNTIME_INTERNAL_TOKEN','MODEL_GATEWAY_API_KEY'])
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path('/worker/.env').exists()
assert not pathlib.Path('/worker/axiom/settings.py').exists()
assert not pathlib.Path('/worker/axiom/agents').exists()
assert importlib.util.find_spec('supabase') is None
assert importlib.util.find_spec('boto3') is None
assert importlib.util.find_spec('httpx') is None
for p in ['/root/join-token','/root/server.conf','/var/lib/spire/server/keys.json']:
 try: pathlib.Path(p).read_bytes()
 except PermissionError: pass
 else: raise Exception('issuer material readable')
s=socket.socket(); s.settimeout(1)
assert s.connect_ex(('1.1.1.1',443)) != 0
print('isolated')`;
  assert.equal(
    execFileSync(
      'docker',
      ['exec', '--user', '20003:20003', input.containerName, 'python', '-c', probe],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
    ).trim(),
    'isolated',
  );
  outcomes['worker-uid-no-backend-credentials'] = true;
  outcomes['worker-no-network-or-host-socket'] = true;
  outcomes['issuer-material-unreadable'] = true;
  async function runCase(
    name: string,
    beforeComplete?: (runId: string) => Promise<void>,
    wrongInput = false,
    loseWorkerResponse = false,
  ) {
    phase = name;
    const engagementId = randomUUID();
    check(
      await db.from('engagements').insert({
        id: engagementId,
        tenant_id: tenantId,
        library_version: version,
        title: 'Synthetic worker assessment',
      }),
    );
    const inputJson = JSON.stringify({
      tenant_id: tenantId,
      engagement_id: engagementId,
      library_version: version,
      answers: { 'WA-1': { Q1: false }, 'WA-2': { Q1: true } },
    });
    const inputHash = createHash('sha256').update(inputJson).digest('hex');
    const correlationId = randomUUID();
    const jobId = randomUUID();
    const context = {
      jobId,
      tenantId,
      actorId,
      workloadId,
      estateId: null,
      engagementId,
      correlationId,
      inputHash,
    };
    const first = await new AssessmentDispatch(db, wrapper).enqueue(context, inputJson);
    // Reconstruct the controller after a discarded response: stable job/run,
    // preserved ciphertext/proof, no new run or delegation audit.
    const dispatcher = new AssessmentDispatch(db, wrapper);
    const repeated = await dispatcher.enqueue(context, inputJson);
    assert.deepEqual(repeated, first);
    const stored = check(
      await db
        .from('assessment_dispatch_jobs')
        .select('id,ciphertext,wrapped_key')
        .eq('id', jobId)
        .single(),
    );
    assert(!JSON.stringify(stored).includes(inputJson));
    const claimed = await dispatcher.claim(tenantId, jobId);
    assert.equal(claimed.runId, first.run_id);
    assert.equal(claimed.payload.reveal().inputJson, inputJson);
    await assert.rejects(() => dispatcher.claim(tenantId, jobId));
    assert.equal(
      check(
        await db
          .from('audit_ledger')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('target_ref', first.run_id)
          .eq('action_type', 'workload.task_delegated'),
      )!.length,
      1,
    );
    const task = {
      runId: claimed.runId,
      expiresAt: claimed.expiresAt,
      proof: new TaskProof(claimed.payload.reveal().taskProof),
    };
    outcomes['encrypted-durable-dispatch-recovered-after-controller-reconstruction'] = true;
    outcomes['idempotent-issuance-one-run-and-audit'] = true;
    outcomes['private-dispatch-claimed-once'] = true;
    let completeRequest: unknown;
    const channel = new AssessmentChannel(
      launchSupervised,
      {
        start: (request) => callTool('start', request),
        complete: async (request) => {
          completeRequest = request;
          await beforeComplete?.(task.runId);
          return callTool('complete', request);
        },
      },
      'spiffe://local.axiomproof.test/agent/parikshan',
    );
    const outcome = await channel.run(
      wrongInput
        ? {
            ...claimed,
            payload: new PrivateAssessmentPayload(inputHash, inputJson + ' ', task.proof),
          }
        : claimed,
    );
    phase = `${name}-${outcome.workerStatus}-${outcome.cleanupConfirmed ? 'cleaned' : 'uncleaned'}`;
    assert.equal(outcome.cleanupConfirmed, true);
    // Model a lost controller-side channel response, then independently confirm
    // the database below without relying on the private worker status.
    const delivered = loseWorkerResponse ? undefined : outcome;
    {
      const findings = check(
        await db
          .from('findings')
          .select('control_id,score,risk_points')
          .eq('tenant_id', tenantId)
          .eq('engagement_id', engagementId),
      );
      const records = check(
        await db
          .from('audit_ledger')
          .select('action_type,input_hash,output_hash,detail')
          .eq('tenant_id', tenantId)
          .eq('target_ref', engagementId),
      );
      assert(findings && records);
      if (beforeComplete || wrongInput) {
        assert.equal(delivered?.workerStatus, 'failed');
        assert.equal(findings.length, 0);
        assert.equal(records.filter((r) => r.action_type === 'assessment.scored').length, 0);
        await assert.rejects(
          confirmation.confirm({
            tenantId,
            runId: task.runId,
            engagementId,
            correlationId,
            inputHash,
          }),
        );
      } else {
        if (loseWorkerResponse) assert.equal(delivered, undefined);
        else assert.equal(delivered?.workerStatus, 'persisted');
        assert.equal(findings.length, 2);
        assert.equal(findings.find((f) => f.control_id === 'WA-1')!.score, 0);
        assert.equal(findings.find((f) => f.control_id === 'WA-2')!.score, 100);
        const engagement = check(
          await db
            .from('engagements')
            .select('posture_score,estimated_exposure_inr,status')
            .eq('id', engagementId)
            .single(),
        );
        assert.deepEqual(engagement, {
          posture_score: 50,
          estimated_exposure_inr: 10000000,
          status: 'review',
        });
        assert.equal(records.length, 2);
        assert(records.every((r) => r.input_hash === inputHash));
        assert.equal(
          records.filter((r) => r.action_type === 'assessment.scored' && r.output_hash).length,
          1,
        );
        assert(!JSON.stringify(records).includes(task.proof.reveal()));
        assert(!JSON.stringify(records).includes('Q1'));
        // Lost-response retry returns the original receipt and creates no rows/events.
        const retry = await router.request('/assessment/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(completeRequest),
        });
        assert.equal(retry.status, 200);
        assert.equal(
          check(
            await db
              .from('audit_ledger')
              .select('id')
              .eq('tenant_id', tenantId)
              .eq('target_ref', engagementId)
              .eq('action_type', 'assessment.scored'),
          )!.length,
          1,
        );
        outcomes['retry-one-durable-receipt'] = true;
        outcomes['input-result-digests-no-private-ledger-data'] = true;
        const expected = { tenantId, runId: task.runId, engagementId, correlationId, inputHash };
        const recorded = await confirmation.confirm(expected);
        assert.equal(recorded.status, 'succeeded');
        assert.equal(recorded.result.posture_score, 50);
        assert.deepEqual(await confirmation.confirm(expected), recorded);
        const confirmedRun = check(
          await db
            .from('agent_runs')
            .select('status,output_redacted_hash,error,total_tokens,cost_usd')
            .eq('tenant_id', tenantId)
            .eq('id', task.runId)
            .single(),
        );
        assert.deepEqual(confirmedRun, {
          status: 'succeeded',
          output_redacted_hash: recorded.result_digest,
          error: null,
          total_tokens: 0,
          cost_usd: 0,
        });
        assert.equal(
          check(
            await db
              .from('audit_ledger')
              .select('id')
              .eq('tenant_id', tenantId)
              .eq('target_ref', task.runId)
              .eq('action_type', 'workload.task_completed'),
          )!.length,
          1,
        );
        outcomes['independent-terminal-confirmation-once'] = true;
        const afterConfirmation = await router.request('/assessment/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(completeRequest),
        });
        assert.equal(afterConfirmation.status, 403);
        outcomes['terminal-confirmation-does-not-revive-task'] = true;
      }
      outcomes[name] = true;
    }
  }
  await runCase('actual-worker-pinned-library-durable-findings');
  await runCase('lost-worker-response-recovered', undefined, false, true);
  await runCase('changed-assignment-refused', undefined, true);
  await runCase('revoked-task-refused-before-write', async (runId) =>
    issuer.revoke(tenantId, actorId, runId, randomUUID()),
  );
  await runCase('disabled-registration-refused-before-write', async () => {
    check(await db.from('workload_identities').update({ status: 'disabled' }).eq('id', workloadId));
  });
  check(await db.from('workload_identities').update({ status: 'active' }).eq('id', workloadId));
  await runCase('actor-demotion-refused-before-write', async () => {
    check(
      await db
        .from('tenant_users')
        .update({ role: 'viewer' })
        .eq('tenant_id', tenantId)
        .eq('user_id', actorId),
    );
  });
  check(
    await db
      .from('tenant_users')
      .update({ role: 'owner' })
      .eq('tenant_id', tenantId)
      .eq('user_id', actorId),
  );
  await runCase('retired-trust-refused-before-write', async () => {
    trustCurrent = false;
  });
  trustCurrent = true;

  phase = 'controller-reconciliation';
  for (const lost of [false, true]) {
    const engagementId = randomUUID(),
      correlationId = randomUUID(),
      jobId = randomUUID();
    check(
      await db.from('engagements').insert({
        id: engagementId,
        tenant_id: tenantId,
        library_version: version,
        title: 'Synthetic supervised controller',
      }),
    );
    const wire = JSON.stringify({
      tenant_id: tenantId,
      engagement_id: engagementId,
      library_version: version,
      answers: { 'WA-1': { Q1: false }, 'WA-2': { Q1: true } },
    });
    const dispatcher = new AssessmentDispatch(db, wrapper);
    const inputHash = createHash('sha256').update(wire).digest('hex');
    const receipt = await dispatcher.enqueue(
      {
        jobId,
        tenantId,
        actorId,
        workloadId,
        estateId: null,
        engagementId,
        correlationId,
        inputHash,
      },
      wire,
    );
    let launches = 0;
    const actualChannel = new AssessmentChannel(
      () => {
        launches++;
        return launchSupervised();
      },
      { start: (r) => callTool('start', r), complete: (r) => callTool('complete', r) },
      'spiffe://local.axiomproof.test/agent/parikshan',
    );
    const controller = new AssessmentController(
      dispatcher,
      {
        async run(claim) {
          const outcome = await actualChannel.run(claim);
          if (lost) throw new Error('synthetic channel response loss');
          return outcome;
        },
      },
      confirmation,
    );
    const result = await controller.run(tenantId, jobId);
    assert.equal(result.status, 'confirmed');
    assert.equal(result.runId, receipt.run_id);
    assert.equal((await controller.run(tenantId, jobId)).status, 'confirmed');
    assert.equal(launches, 1);
    assert(!JSON.stringify(result).includes('answers'));
    outcomes[
      lost ? 'controller-confirms-after-channel-loss' : 'controller-claims-launches-and-confirms'
    ] = true;
  }
  outcomes['controller-recovery-never-relaunches'] = true;
  phase = 'supervisor-cleanup';
  const treeProbe = `import json, os, signal, sys
from axiom.assessment_supervisor import supervise
from pathlib import Path
os.environ['SYNTHETIC_PARENT_SECRET']='not-for-worker'
program="""import os, signal, subprocess, sys, time
assert os.getuid()==20003
assert 'SYNTHETIC_PARENT_SECRET' not in os.environ
try: os.kill(os.getppid(),signal.SIGSTOP)
except PermissionError: pass
else: raise RuntimeError('worker could stop supervisor')
child=subprocess.Popen([sys.executable,'-c','import os,time; os.setsid(); time.sleep(60)'])
print('isolated-tree',flush=True)
time.sleep(60)
"""
code,report=supervise((sys.executable,'-c',program),seconds=0.5)
assert code==124 and report['timed_out'] and report['cleanup_confirmed']
assert not Path(f'/proc/self/task/{os.getpid()}/children').read_text().strip()
print('reaped')`;
  assert.equal(
    execFileSync(
      'docker',
      ['exec', '--user', '0', input.containerName, 'python', '-c', treeProbe],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
    ).trim(),
    'isolated-tree\nreaped',
  );
  outcomes['supervisor-drops-credentials-and-reaps-detached-descendants'] = true;
  const idle = spawn(
    'docker',
    [
      'exec',
      '--user',
      '0',
      '-i',
      input.containerName,
      'python',
      '-m',
      'axiom.assessment_supervisor',
      '--private-stdio',
      '--deadline-seconds',
      '0.5',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const idleClosed = once(idle, 'close');
  idle.stderr.resume();
  let report = '';
  const idleTimer = setTimeout(() => idle.kill('SIGKILL'), 10000);
  try {
    for await (const chunk of idle.stdout) {
      report += String(chunk);
      assert(report.length < 1024);
    }
    const [code] = await idleClosed;
    assert.equal(code, 124);
    assert.deepEqual(JSON.parse(report), {
      supervisor: { worker_exit: null, timed_out: true, cleanup_confirmed: true },
    });
  } finally {
    clearTimeout(idleTimer);
    idle.stdin.end();
  }
  outcomes['supervisor-bounds-idle-private-input'] = true;

  phase = 'supervisor-parent-death';
  const deathProbe = `import ctypes, os, signal, subprocess, sys, time
from pathlib import Path
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
worker="""import ctypes,os,signal,subprocess,sys,time
from functools import partial
from axiom.process_lifetime import bind_parent_lifetime
value=ctypes.c_int()
assert ctypes.CDLL(None).prctl(2,ctypes.byref(value),0,0,0)==0
assert value.value==signal.SIGKILL
subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],preexec_fn=partial(bind_parent_lifetime,os.getpid()))
print('bound',flush=True)
time.sleep(60)
"""
monitor_code='from axiom.assessment_supervisor import supervise; import sys; supervise((sys.executable,"-c",'+repr(worker)+'),seconds=5)'
monitor=subprocess.Popen([sys.executable,'-c',monitor_code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
assert monitor.stdout.readline().strip()==b'bound'
monitor.kill();monitor.wait(timeout=2)
deadline=time.monotonic()+3
while time.monotonic()<deadline:
 try:
  pid,status=os.waitpid(-1,os.WNOHANG)
  if pid: assert os.waitstatus_to_exitcode(status)==-signal.SIGKILL
 except ChildProcessError: break
 time.sleep(0.01)
else: raise RuntimeError('process chain survived parent death')
assert not Path(f'/proc/self/task/{os.getpid()}/children').read_text().strip()
print('parent-death-clean')`;
  assert.equal(
    execFileSync(
      'docker',
      ['exec', '--user', '0', input.containerName, 'python', '-c', deathProbe],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
    ).trim(),
    'parent-death-clean',
  );
  outcomes['kernel-parent-death-stops-fixed-worker-chain'] = true;

  phase = 'supervisor-launch-guard';
  const implicit = spawnSync(
    'docker',
    ['run', '--rm', '--network', 'none', 'axiom-assessment-worker:acceptance'],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(implicit.status, 78);
  assert.equal(implicit.stdout, '');
  const unprivileged = spawnSync(
    'docker',
    [
      'exec',
      '--user',
      '20003:20003',
      '-i',
      input.containerName,
      'python',
      '-m',
      'axiom.assessment_supervisor',
      '--private-stdio',
    ],
    { encoding: 'utf8', input: '', timeout: 10000 },
  );
  assert.equal(unprivileged.status, 70);
  assert.equal(unprivileged.stdout, '');
  outcomes['supervisor-refuses-implicit-or-unprivileged-launch'] = true;
  phase = 'result';
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }));
  if (process.env.CI === 'true') assert(!dirty);
  mkdirSync('.axiom-runtime/workload-assessment', { recursive: true, mode: 0o700 });
  writeFileSync(
    '.axiom-runtime/workload-assessment/results.json',
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'isolated-workload-assessment',
        passed: true,
        revision,
        dirty,
        outcomes,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ passed: true, outcomes }) + '\n');
}
main().catch(() => {
  process.stderr.write(`Workload assessment failed at ${phase}. Private output withheld.\n`);
  process.exitCode = 1;
});
