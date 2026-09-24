/** Trusted local controller integration. Synthetic backend/key material enters
 * only on private stdin. Outputs fixed labels, never requests or raw errors. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  controllerBackendCredentials,
  requireControllerBackend,
} from '../services/bff/src/workloads/controller-files.js';
import { createDecipheriv, generateKeyPairSync, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { createClient } from '@supabase/supabase-js';
import { createLocalJWKSet, SignJWT } from 'jose';
import { z } from 'zod';
import {
  composeVmAssessmentController,
  vmControllerConfiguration,
} from '../services/bff/src/workloads/assessment-vm.js';
import { createRemoteAssessmentServer } from '../services/bff/src/workloads/assessment-remote.js';
import type { DispatchAwsKmsPort } from '../services/bff/src/workloads/dispatch-key-wrappers.js';
let phase = 'input';
async function main() {
  const input = z
    .object({
      config: vmControllerConfiguration,
      serviceKey: z.string(),
      jobId: z.uuid(),
      foreignTenant: z.uuid(),
      fixtureKeys: z.record(z.string(), z.string()),
      tls: z.object({ key: z.string(), cert: z.string() }).strict(),
    })
    .strict()
    .parse(JSON.parse(readFileSync(0, 'utf8')));
  assert.equal(process.getuid!(), 20000);
  phase = 'protected-credentials';
  const backendFile = '/run/controller-test/backend.key';
  let backend: Awaited<ReturnType<typeof controllerBackendCredentials>>;
  try {
    await writeFile(backendFile, input.serviceKey + '\n', { mode: 0o600, flag: 'wx' });
    backend = await controllerBackendCredentials(
      backendFile,
      {
        ...process.env,
        AXIOM_REGION: 'ap-south-1',
        SUPABASE_URL: 'https://backend.fixture.test',
      },
      input.config.tenantId,
    );
    assert.equal(backend.accessToken, JSON.parse(input.serviceKey).accessToken);
  } finally {
    await rm(backendFile, { force: true });
  }
  const hostname = process.env.HOSTNAME!;
  assert.match(hostname, /^[a-f0-9]{12,64}$/);
  const recordedEnv = z.array(z.string()).parse(
    JSON.parse(
      execFileSync(
        '/usr/bin/docker',
        [
          '--host',
          'unix:///run/docker.sock',
          'inspect',
          '--format',
          '{{json .Config.Env}}',
          hostname,
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 16384,
          env: { PATH: '/usr/local/bin:/usr/bin:/bin', DOCKER_CONFIG: '/nonexistent' },
        },
      ),
    ),
  );
  for (const value of [
    input.serviceKey,
    backend.accessToken,
    input.tls.key,
    ...Object.values(input.fixtureKeys),
  ])
    assert(recordedEnv.every((entry) => !entry.includes(value)));
  const outcomes: Record<string, boolean> = {
    'vm-controller-protected-file-backend-credential': true,
    'vm-controller-credentials-absent-from-container-env': true,
  };
  const db = createClient('http://host.docker.internal:56321', backend.apiKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${backend.accessToken}` } },
  });
  await requireControllerBackend(db, input.config.tenantId);
  const awsKms: DispatchAwsKmsPort = {
    async send(command) {
      const request = command.input;
      assert('CiphertextBlob' in request && request.CiphertextBlob);
      assert.equal(request.EncryptionAlgorithm, 'SYMMETRIC_DEFAULT');
      assert.equal(
        request.EncryptionContext?.axiomDispatchPurpose,
        'axiom.assessment.dispatch.dek.v1',
      );
      const keyRef = request.KeyId!;
      const master = Buffer.from(input.fixtureKeys[keyRef]!, 'base64');
      assert.equal(master.length, 32);
      const value = Buffer.from(request.CiphertextBlob);
      const decipher = createDecipheriv('aes-256-gcm', master, value.subarray(0, 12));
      decipher.setAAD(Buffer.from(JSON.stringify(request.EncryptionContext)));
      decipher.setAuthTag(value.subarray(-16));
      return {
        KeyId: keyRef,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        Plaintext: Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]),
      };
    },
  };
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const schedulerKeys = createLocalJWKSet({
    keys: [
      { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' },
    ],
  });
  phase = 'startup';
  const ports = { awsKms, schedulerKeys };
  const service = await composeVmAssessmentController(input.config, db, ports);
  outcomes['vm-controller-live-trust-and-durable-policy-startup'] = true;
  const { IssuerSyncHealth } = await import('../services/bff/src/workloads/issuer-sync-health.js');
  await new IssuerSyncHealth(input.config.issuerNodeId).requireFresh();
  await assert.rejects(
    composeVmAssessmentController(
      { ...input.config, issuerNodeId: input.config.issuerNodeId + '-foreign' },
      db,
      ports,
    ),
  );
  outcomes['vm-controller-root-owned-live-issuer-sync-required'] = true;
  phase = 'stale-policy';
  const altered = structuredClone(input.config);
  altered.keys.primary = `arn:aws:kms:ap-south-1:123456789012:key/${randomUUID()}`;
  await assert.rejects(composeVmAssessmentController(altered, db, ports), {
    message: 'VM assessment controller configuration refused',
  });
  const before = await db
    .from('assessment_dispatch_jobs')
    .select('claimed_at')
    .eq('id', input.jobId)
    .single();
  assert(!before.error && before.data.claimed_at === null);
  outcomes['vm-controller-stale-policy-refused-before-claim'] = true;
  phase = 'https';
  const server = createRemoteAssessmentServer({ ...service, tls: input.tls });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const authorization =
      'Bearer ' +
      (await new SignJWT({ email: input.config.scheduler.email, email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer('https://accounts.google.com')
        .setSubject(input.config.scheduler.subject)
        .setAudience(input.config.scheduler.audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(pair.privateKey));
    const call = (path: string, body: unknown, bearer = authorization) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((done, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path,
            method: 'POST',
            ca: input.tls.cert,
            headers: { authorization: bearer, 'content-type': 'application/json' },
            timeout: 85000,
          },
          (reply) => {
            let wire = '';
            reply.on('data', (part) => {
              wire += String(part);
            });
            reply.on('end', () => {
              try {
                done({
                  status: reply.statusCode!,
                  body: JSON.parse(wire) as Record<string, unknown>,
                });
              } catch {
                reject(new Error('invalid controller reply'));
              }
            });
          },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('deadline')));
        req.end(JSON.stringify(body));
      });
    const target = { tenantId: input.config.tenantId, jobId: input.jobId };
    assert.equal(
      (await call('/assessment/run', target, 'Bearer synthetic.invalid.proof')).status,
      503,
    );
    const foreignTarget = { ...target, tenantId: input.foreignTenant };
    assert.equal((await call('/assessment/run', foreignTarget)).body.status, 'unconfirmed');
    assert.equal((await call('/assessment/reconcile', foreignTarget)).body.status, 'unconfirmed');
    outcomes['vm-controller-https-identity-and-tenant-refusal'] = true;
    phase = 'launch';
    const result = await call('/assessment/run', target);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'confirmed');
    assert.equal(result.body.cleanupConfirmed, true);
    outcomes['vm-controller-real-trust-worker-persistence-and-cleanup'] = true;
    phase = 'recovery';
    const restored = await composeVmAssessmentController(input.config, db, ports);
    const recovered = await restored.controller.run(target.tenantId, target.jobId);
    assert.equal(recovered.status, 'confirmed');
    assert.equal(recovered.cleanupConfirmed, null);
    assert.equal(recovered.receipt, result.body.receipt);
    outcomes['vm-controller-reconstruction-confirms-without-relaunch'] = true;
    phase = 'scheduling';
    const poll = await service.scheduling.reserve();
    assert(poll.jobs.every((job) => job.tenantId === input.config.tenantId));
    await assert.rejects(
      service.scheduling.acknowledge({
        tenantId: input.foreignTenant,
        jobId: input.jobId,
        leaseId: randomUUID(),
        namespace: input.config.namespace,
        workflowId: `assessment-${input.foreignTenant}-${input.jobId}`,
        workflowRunId: randomUUID(),
      }),
    );
    outcomes['vm-controller-scheduling-is-tenant-bound'] = true;
    process.stdout.write(JSON.stringify({ passed: true, outcomes }));
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}
main().catch(() => {
  process.stderr.write(`VM controller acceptance failed at ${phase}. Private output withheld.\n`);
  process.exitCode = 1;
});
