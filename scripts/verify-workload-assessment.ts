/** Real UID-attested worker → private Hono tools → real PostgREST transactions.
 * Only synthetic fixtures in the isolated local parity project. No private
 * frame, token, service key, subprocess stderr or raw exception is emitted. */
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
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
    outcomes['encrypted-durable-dispatch-recovered-after-controller-restart'] = true;
    outcomes['idempotent-issuance-one-run-and-audit'] = true;
    outcomes['private-dispatch-claimed-once'] = true;
    const child = spawn(
      'docker',
      [
        'exec',
        '--user',
        '20003:20003',
        '-i',
        input.containerName,
        'python',
        '-m',
        'axiom.assessment_worker',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const closed = once(child, 'close');
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    // Private stderr is discarded; never forward it, even on assertion failure.
    child.stderr.resume();
    let buffer = '';
    let result: Record<string, unknown> | undefined;
    let count = 0;
    let completeRequest: unknown;
    child.stdin.write(
      JSON.stringify({
        tenantId,
        runId: task.runId,
        taskProof: task.proof.reveal(),
        inputJson: inputJson + (wrongInput ? ' ' : ''),
        inputHash,
        spiffeId: 'spiffe://local.axiomproof.test/agent/parikshan',
      }) + '\n',
    );
    try {
      for await (const chunk of child.stdout) {
        buffer += String(chunk);
        assert(buffer.length <= 1048576);
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const frame = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
          buffer = buffer.slice(newline + 1);
          if ('tool' in frame) {
            assert(++count <= 2);
            assert.equal(frame.tool, count === 1 ? 'assessment.start' : 'assessment.complete');
            if (frame.tool === 'assessment.complete') {
              completeRequest = frame.request;
              await beforeComplete?.(task.runId);
            }
            const response = await router.request(
              `/assessment/${count === 1 ? 'start' : 'complete'}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(frame.request),
              },
            );
            child.stdin.write(
              JSON.stringify({ ok: response.ok, value: await response.json() }) + '\n',
            );
          } else {
            assert(!result);
            // Deliberately discard the terminal frame in the recovery case.
            if (!loseWorkerResponse) result = frame;
          }
        }
      }
      const [code] = await closed;
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
        assert.equal(code, 1);
        assert.deepEqual(result, { error: 'assessment_worker_failed' });
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
        assert.equal(code, 0);
        assert.equal(count, 2);
        if (loseWorkerResponse) assert.equal(result, undefined);
        else assert.equal((result!.result as { status: string }).status, 'persisted');
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
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGKILL');
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
