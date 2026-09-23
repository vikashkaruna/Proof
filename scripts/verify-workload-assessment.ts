/** Real UID-attested worker → private Hono tools → real PostgREST transactions.
 * Only synthetic fixtures in the isolated local parity project. No private
 * frame, token, service key, subprocess stderr or raw exception is emitted. */
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteAssessmentServer } from '../services/bff/src/workloads/assessment-remote.js';
import { GoogleSchedulerIdentity } from '../services/bff/src/workloads/scheduler-identity.js';
import { startAssessmentControllerSocket } from '../services/bff/src/workloads/assessment-socket.js';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { TenantId } from '../packages/types/src/domain.js';
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
import { AssessmentRetention } from '../services/bff/src/workloads/assessment-retention.js';
import { AssessmentScheduling } from '../services/bff/src/workloads/assessment-scheduling.js';
import { AssessmentDispatch } from '../services/bff/src/workloads/assessment-dispatch.js';
import { PrivateAssessmentPayload } from '../services/bff/src/workloads/dispatch-payload.js';
import { AssessmentChannel } from '../services/bff/src/workloads/assessment-channel.js';
import { AssessmentController } from '../services/bff/src/workloads/assessment-controller.js';
import { DispatchKeyPolicy } from '../services/bff/src/workloads/dispatch-key-policy.js';
import {
  AwsDispatchKeyWrapper,
  type DispatchAwsKmsPort,
} from '../services/bff/src/workloads/dispatch-key-wrappers.js';
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
  const scheduleTenants = { unix: randomUUID(), https: randomUUID() };
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
  // Production dispatch adapter, local cryptographic KMS fixture. No cloud call
  // or IAM claim. Keys remain in this controller fixture, never SQL/IPC/history.
  const syntheticRef = () => `arn:aws:kms:ap-south-1:123456789012:key/${randomUUID()}`;
  const fixtureRings = new Map(
    [tenantId, ...Object.values(scheduleTenants)].map(
      (tenant) => [tenant as TenantId, { primary: syntheticRef(), retiring: [] }] as const,
    ),
  );
  let keyPolicy = new DispatchKeyPolicy('aws', fixtureRings);
  const firstKeyRef = keyPolicy.primary(tenantId as TenantId);
  const wrappingKeys = new Map(
    [...fixtureRings.values()].map((ring) => [ring.primary, randomBytes(32)]),
  );
  const rotatedRef = syntheticRef();
  wrappingKeys.set(rotatedRef, randomBytes(32));
  keyPolicy = keyPolicy.withReadable(tenantId as TenantId, rotatedRef);
  const kms: DispatchAwsKmsPort = {
    async send(command) {
      const request = command.input;
      const keyRef = request.KeyId!;
      const master = wrappingKeys.get(keyRef);
      assert(master);
      assert.equal(request.EncryptionAlgorithm, 'SYMMETRIC_DEFAULT');
      assert.equal(
        request.EncryptionContext?.axiomDispatchPurpose,
        'axiom.assessment.dispatch.dek.v1',
      );
      assert.match(request.EncryptionContext!.axiomDispatchContext!, /^[a-f0-9]{64}$/);
      const binding = Buffer.from(JSON.stringify(request.EncryptionContext));
      if ('Plaintext' in request && request.Plaintext) {
        assert.equal(request.Plaintext.byteLength, 32);
        const nonce = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', master, nonce);
        cipher.setAAD(binding);
        return {
          KeyId: keyRef,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          CiphertextBlob: Buffer.concat([
            nonce,
            cipher.update(request.Plaintext),
            cipher.final(),
            cipher.getAuthTag(),
          ]),
        };
      }
      assert('CiphertextBlob' in request && request.CiphertextBlob);
      const value = Buffer.from(request.CiphertextBlob),
        decipher = createDecipheriv('aes-256-gcm', master, value.subarray(0, 12));
      decipher.setAAD(binding);
      decipher.setAuthTag(value.subarray(-16));
      return {
        KeyId: keyRef,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        Plaintext: Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]),
      };
    },
  };
  let wrapper = new AwsDispatchKeyWrapper(keyPolicy, kms);

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
    const rotating = keyPolicy.primary(tenantId as TenantId) === firstKeyRef;
    keyPolicy = keyPolicy.withPrimary(tenantId as TenantId, rotatedRef);
    wrapper = new AwsDispatchKeyWrapper(new DispatchKeyPolicy('aws', keyPolicy.snapshot()), kms);
    // Reconstruct the controller after a discarded response: stable job/run,
    // preserved ciphertext/proof, no new run or delegation audit.
    const dispatcher = new AssessmentDispatch(db, wrapper);
    const repeated = await dispatcher.enqueue(context, inputJson);
    assert.deepEqual(repeated, first);
    const stored = check(
      await db
        .from('assessment_dispatch_jobs')
        .select('id,key_ref,ciphertext,wrapped_key')
        .eq('id', jobId)
        .single(),
    );
    assert(!JSON.stringify(stored).includes(inputJson));
    assert.equal(stored!.key_ref, rotating ? firstKeyRef : rotatedRef);
    const claimed = await dispatcher.claim(tenantId, jobId);
    assert.equal(claimed.runId, first.run_id);
    assert.equal(claimed.payload.reveal().inputJson, inputJson);
    outcomes[
      rotating
        ? 'dispatch-kms-retained-key-opens-after-rotation'
        : 'dispatch-kms-new-jobs-use-primary'
    ] = true;
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
        if (name === 'actual-worker-pinned-library-durable-findings') {
          const retention = new AssessmentRetention(db, { retentionDays: 90, tenantId });
          assert.deepEqual(await retention.purgeNext(), { status: 'idle' });
          outcomes['retention-preserves-recent-confirmation'] = true;
          // Synthetic local fixture only: advance its confirmation age. No
          // production clock override or backend write route is introduced.
          execFileSync(
            'docker',
            [
              'exec',
              '-i',
              'supabase_db_axiom-w0-parity',
              'psql',
              '-X',
              '-U',
              'postgres',
              '-d',
              'postgres',
              '-v',
              'ON_ERROR_STOP=1',
              '-q',
            ],
            {
              input: `update public.workload_assessment_packets set finalized_at=clock_timestamp()-interval '91 days' where tenant_id='${tenantId}' and run_id='${task.runId}';`,
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 10000,
            },
          );
          const receipt = await retention.purgeNext();
          assert.equal(receipt.status, 'purged');
          assert(
            receipt.status === 'purged' && receipt.jobId === jobId && receipt.retentionDays === 90,
          );
          const cleaned = check(
            await db
              .from('assessment_dispatch_jobs')
              .select('nonce,ciphertext,wrapped_key,payload_purge_receipt,claimed_at')
              .eq('id', jobId)
              .single(),
          );
          assert(
            cleaned &&
              cleaned.nonce === null &&
              cleaned.ciphertext === null &&
              cleaned.wrapped_key === null &&
              cleaned.payload_purge_receipt &&
              cleaned.claimed_at,
          );
          outcomes['retention-purges-private-bytes-with-durable-receipt'] = true;
          assert.deepEqual(await retention.purgeNext(), { status: 'idle' });
          assert.deepEqual(await dispatcher.enqueue(context, inputJson), first);
          await assert.rejects(() => dispatcher.claim(tenantId, jobId));
          outcomes['retention-preserves-idempotency-and-single-use-claim'] = true;
          assert.deepEqual(await confirmation.confirm(expected), recorded);
          assert.equal(
            check(await db.from('findings').select('id').eq('engagement_id', engagementId))!.length,
            2,
          );
          outcomes['retention-preserves-confirmed-result-and-findings'] = true;
        }
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
  for (const transport of ['unix', 'https'] as const) {
    phase = `temporal-${transport}-scheduling`;
    // Dedicated tenant shard keeps historical synthetic outbox fixtures out of
    // this production-adapter poll, without adding caller-selected tenant input.
    const scheduleTenantId = scheduleTenants[transport],
      scheduleWorkloadId = randomUUID();
    check(
      await db.from('tenants').insert({
        id: scheduleTenantId,
        slug: `schedule-${scheduleTenantId}`,
        name: 'Synthetic scheduling',
      }),
    );
    check(
      await db
        .from('tenant_users')
        .insert({ tenant_id: scheduleTenantId, user_id: actorId, role: 'owner' }),
    );
    check(
      await db.from('workload_identities').insert({
        id: scheduleWorkloadId,
        tenant_id: scheduleTenantId,
        agent_name: 'parikshan',
        spiffe_id: 'spiffe://local.axiomproof.test/agent/parikshan',
        status: 'active',
      }),
    );
    const scheduledJobs: Array<{ tenantId: string; jobId: string }> = [];
    const schedulingDispatch = new AssessmentDispatch(db, wrapper);
    for (let n = 0; n < 2; n++) {
      const engagementId = randomUUID(),
        correlationId = randomUUID(),
        jobId = randomUUID();
      check(
        await db.from('engagements').insert({
          id: engagementId,
          tenant_id: scheduleTenantId,
          library_version: version,
          title: 'Synthetic opaque scheduling',
        }),
      );
      const wire = JSON.stringify({
        tenant_id: scheduleTenantId,
        engagement_id: engagementId,
        library_version: version,
        answers: { 'WA-1': { Q1: false }, 'WA-2': { Q1: true } },
      });
      await schedulingDispatch.enqueue(
        {
          jobId,
          tenantId: scheduleTenantId,
          actorId,
          workloadId: scheduleWorkloadId,
          estateId: null,
          engagementId,
          correlationId,
          inputHash: createHash('sha256').update(wire).digest('hex'),
        },
        wire,
      );
      scheduledJobs.push({ tenantId: scheduleTenantId, jobId });
    }
    phase = `temporal-${transport}-setup`;
    let scheduledLaunches = 0;
    const scheduledChannel = new AssessmentChannel(
      () => {
        scheduledLaunches++;
        return launchSupervised();
      },
      { start: (r) => callTool('start', r), complete: (r) => callTool('complete', r) },
      'spiffe://local.axiomproof.test/agent/parikshan',
    );
    const directory = await realpath(await mkdtemp('/tmp/axiom-schedule-'));
    await chmod(directory, 0o700);
    const scheduling = new AssessmentScheduling(db, {
      namespace: 'default',
      tenantId: scheduleTenantId,
    });
    let polls = 0;
    const controllerOptions = {
      controller: new AssessmentController(schedulingDispatch, scheduledChannel, confirmation),
      scheduling: {
        async reserve() {
          if (++polls === 2) {
            // Acceptance fixture only: advance the persisted lease deadline after
            // a lost start response, avoiding a three-minute test wall-clock wait.
            // No task lifetime, claim or execution authority is changed.
            execFileSync(
              'docker',
              [
                'exec',
                '-i',
                'supabase_db_axiom-w0-parity',
                'psql',
                '-X',
                '-U',
                'postgres',
                '-d',
                'postgres',
                '-v',
                'ON_ERROR_STOP=1',
                '-q',
              ],
              {
                input: `update public.assessment_dispatch_jobs set scheduling_lease_until=clock_timestamp()-interval '1 second',scheduling_next_at=clock_timestamp()-interval '1 day' where id='${scheduledJobs[0]!.jobId}' and scheduling_status='pending';`,
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 10000,
              },
            );
          }
          return scheduling.reserve();
        },
        acknowledge: (request: unknown) => scheduling.acknowledge(request),
      },
    };
    let endpoint: Record<string, unknown>;
    let closeController: () => Promise<void> = async () => {};
    const originalFetch = globalThis.fetch;
    let keyFetches = 0;
    try {
      if (transport === 'unix') {
        const socket = await startAssessmentControllerSocket({
          directory,
          socketGroup: process.getgid!(),
          ...controllerOptions,
        });
        endpoint = { socketPath: socket.socketPath, controllerUid: process.getuid!() };
        closeController = socket.close;
      } else {
        // Synthetic TLS/signing material is generated only for this local test.
        // No production token, key or credential is loaded or written here.
        const certPath = join(directory, 'tls.crt'),
          keyPath = join(directory, 'tls.key');
        execFileSync(
          'openssl',
          [
            'req',
            '-new',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-x509',
            '-days',
            '1',
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost,IP:127.0.0.1',
            '-keyout',
            keyPath,
            '-out',
            certPath,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
        );
        const certificate = readFileSync(certPath, 'utf8');
        let identity: GoogleSchedulerIdentity | undefined;
        const server = createRemoteAssessmentServer({
          ...controllerOptions,
          tls: { key: readFileSync(keyPath), cert: certificate },
          identity: {
            async authorize(authorization) {
              if (!identity) throw new Error('Fixture identity unavailable');
              return identity.authorize(authorization);
            },
          },
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        closeController = () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) =>
              error ? reject(new Error('Fixture close failed')) : resolve(),
            ),
          );
        const address = server.address();
        assert(address && typeof address !== 'string');
        const origin = `https://127.0.0.1:${address.port}`;
        const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwks = {
          keys: [
            {
              ...pair.publicKey.export({ format: 'jwk' }),
              kid: 'fixture',
              alg: 'RS256',
              use: 'sig',
            },
          ],
        };
        globalThis.fetch = async (resource, options) => {
          if (String(resource) === 'https://www.googleapis.com/oauth2/v3/certs') {
            keyFetches++;
            return new Response(JSON.stringify(jwks), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return originalFetch(resource, options);
        };
        const subject = '123456789012345678901',
          email = 'scheduler@synthetic.iam.gserviceaccount.com';
        identity = new GoogleSchedulerIdentity({ audience: origin, subject, email });
        const issue = (sub: string) => {
          const encode = (value: unknown) =>
            Buffer.from(JSON.stringify(value)).toString('base64url');
          const now = Math.floor(Date.now() / 1000);
          const value =
            encode({ alg: 'RS256', kid: 'fixture', typ: 'JWT' }) +
            '.' +
            encode({
              iss: 'https://accounts.google.com',
              sub,
              azp: sub,
              email,
              email_verified: true,
              aud: origin,
              iat: now,
              exp: now + 300,
            });
          return (
            value +
            '.' +
            sign('RSA-SHA256', Buffer.from(value), pair.privateKey).toString('base64url')
          );
        };
        endpoint = {
          origin,
          certificate,
          identityToken: issue(subject),
          foreignIdentityToken: issue('999999999999999999999'),
        };
      }
      phase = `temporal-${transport}-probe-process`;
      const probe = spawn(
        'uv',
        [
          'run',
          '--no-sync',
          '--project',
          'services/temporal-workers',
          'python',
          'scripts/verify-assessment-scheduling.py',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } },
      );
      probe.stderr.resume(); // Never forward SDK failures or private diagnostics.
      probe.stdin.on('error', () => {});
      const done = once(probe, 'close')
        .then(([code]) => code)
        .catch(() => null);
      const timer = setTimeout(() => probe.kill('SIGTERM'), 150000);
      let stdout = '';
      try {
        probe.stdin.end(
          JSON.stringify({
            ...endpoint,
            jobs: scheduledJobs,
          }),
        );
        for await (const chunk of probe.stdout) {
          stdout += String(chunk);
          if (stdout.length > 4096) throw new Error('Scheduling probe output refused');
        }
        phase = `temporal-probe-output-launches-${scheduledLaunches}`;
        const code = await done;
        if (code !== 0) {
          const failure = z
            .object({
              failedPhase: z.enum([
                'setup',
                'remote-refusal',
                'schedule',
                'pickup',
                'recovery',
                'empty',
                'result',
                'confirmation',
                'duplicate',
                'history',
                'calls',
              ]),
            })
            .strict()
            .safeParse(stdout ? JSON.parse(stdout) : null);
          phase = `temporal-${transport}-${failure.success ? failure.data.failedPhase : 'process'}-launches-${scheduledLaunches}`;
        }
        assert.equal(code, 0);
        const result = z
          .object({
            'temporal-private-controller-real-worker-confirmed': z.literal(true),
            'temporal-lost-reply-reconciles-without-relaunch': z.literal(true),
            'temporal-history-contains-only-opaque-job-metadata': z.literal(true),
            'outbox-private-pickup-submits-and-acknowledges': z.literal(true),
            'outbox-lost-start-reacquires-lease-without-new-execution': z.literal(true),
            'outbox-lost-ack-stays-durably-submitted': z.literal(true),
            remoteChecks: z.boolean(),
          })
          .strict()
          .parse(JSON.parse(stdout));
        phase = 'temporal-launch-count';
        assert.equal(scheduledLaunches, 2);
        const rows = check(
          await db
            .from('assessment_dispatch_jobs')
            .select(
              'scheduling_status,scheduling_attempts,workflow_namespace,workflow_run_id,scheduling_receipt',
            )
            .eq('tenant_id', scheduleTenantId),
        );
        assert(rows);
        assert.equal(rows.length, 2);
        assert(
          rows.every(
            (row) =>
              row.scheduling_status === 'submitted' &&
              row.workflow_namespace === 'default' &&
              row.workflow_run_id &&
              row.scheduling_receipt,
          ),
        );
        assert.deepEqual(rows.map((row) => row.scheduling_attempts).sort(), [1, 2]);
        const audits = check(
          await db
            .from('audit_ledger')
            .select('id')
            .eq('tenant_id', scheduleTenantId)
            .eq('action_type', 'workload.dispatch_scheduled'),
        );
        assert(audits);
        assert.equal(audits.length, 2);
        const { remoteChecks, ...common } = result;
        assert.equal(remoteChecks, transport === 'https');
        if (remoteChecks) {
          assert(keyFetches > 0);
          outcomes['remote-https-scheduler-identity-and-pickup'] = true;
          outcomes['remote-https-foreign-identity-refused-before-poll'] = true;
          outcomes['remote-https-untrusted-certificate-refused'] = true;
        }
        Object.assign(outcomes, common);
      } finally {
        clearTimeout(timer);
        if (probe.exitCode === null) probe.kill('SIGTERM');
      }
    } finally {
      phase += '-close';
      try {
        await closeController();
      } finally {
        globalThis.fetch = originalFetch;
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
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
