import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.useRealTimers());
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownedDeploymentOperationCanonicalJSON, OWNED_DEPLOYMENT_STEPS } from '@axiom/types';
import {
  OwnedDeploymentInstaller,
  actualOwnedTransportVerifier,
} from './owned-deployment-installer.js';
import { ApprovalEngine, type SignedApprovalToken } from '@axiom/approval-engine';
import type { OwnedDeploymentDecision } from '@axiom/types';
import { makeOwnedDeploymentManifest } from '../test/owned-deployment-fixture.js';
import {
  ownedDeploymentManifest,
  ownedDeploymentManifestSha256,
} from './owned-deployment-manifest.js';
import {
  OwnedDeploymentApprovals,
  type OwnedDeploymentApprovalSource,
  type OwnedDeploymentApprovalPorts,
} from './owned-deployment-approval.js';
const id = (n: number) => `89110000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const m = ownedDeploymentManifest.parse(makeOwnedDeploymentManifest()),
    hash = ownedDeploymentManifestSha256(m),
    now = Date.now();
  const current: OwnedDeploymentApprovalSource = {
    manifest: m,
    summary: {
      requestId: id(10),
      tenantId: m.tenantId,
      actorId: id(11),
      engagementId: m.engagementId,
      connectorId: m.connectorId,
      state: 'preflight_ready',
      manifestSha256: hash,
      environment: 'local',
      label: 'Owned synthetic audit configuration',
      scope: 'owned_synthetic_config.audit_log_enable',
      fixtureId: m.fixtureId,
      resourceId: m.resourceId,
      bindingId: m.bindingId,
      custodyPolicyId: m.custodyPolicyId,
      custodyEpoch: 1,
      requestedAt: new Date(now - 1000).toISOString(),
      expiresAt: m.expiresAt,
      reason: 'Synthetic fixture enrollment requested for validation',
      preflight: {
        sha256: 'b'.repeat(64),
        completedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 240000).toISOString(),
        rollbackSha256: 'c'.repeat(64),
        dryRunCompleted: true,
        rollbackValidated: true,
        checks: [
          {
            name: 'Fixture-only host checks',
            outcome: 'passed',
            detail: 'Unit fixture; no actual Docker inspection',
          },
        ],
        receiptId: '1',
      },
      approval: null,
      installation: null,
      limitations: m.limitations,
    },
  };
  const context = {
    tenantId: m.tenantId,
    actorId: id(12),
    expectedActorId: id(12),
    sessionId: id(13),
  };
  const decision: OwnedDeploymentDecision = {
    operationKey: id(14),
    expectedManifestSha256: hash,
    expectedPreflightSha256: 'b'.repeat(64),
    expectedRollbackSha256: 'c'.repeat(64),
    reason: 'Approve only this synthetic fixture deployment',
    acknowledgeOwnedSynthetic: true,
  };
  const engine = new ApprovalEngine(Buffer.from('synthetic-enrollment-unit-signing-secret'));
  const issue = vi.spyOn(engine, 'issue');
  let retainedToken: SignedApprovalToken | undefined;
  const ports = {
    authorizeFounder: vi.fn(async () => {}),
    recoverApproval: vi.fn<OwnedDeploymentApprovalPorts['recoverApproval']>(async () => null),
    loadCurrentSource: vi.fn(async () => structuredClone(current)),
    loadApprovedInstallerSource: vi.fn<OwnedDeploymentApprovalPorts['loadApprovedInstallerSource']>(
      async () => ({
        source: structuredClone(current),
        decision,
        token: retainedToken,
      }),
    ),
    consumeBoundFounderMfa: vi.fn(async () => {}),
    recordApproved: vi.fn<OwnedDeploymentApprovalPorts['recordApproved']>(
      async (_context, input) => {
        retainedToken = input.token;
        current.summary.state = 'approved';
        current.summary.approval = {
          approvalId: id(15),
          approvedBy: context.actorId,
          approvedAt: new Date().toISOString(),
          expiresAt: current.manifest.expiresAt,
          receiptId: '2',
        };
        return structuredClone(current.summary);
      },
    ),
  };
  const service = new OwnedDeploymentApprovals(ports, engine);
  const approve = () => service.approve(context, current.summary.requestId, decision, id(16));
  return { current, context, decision, ports, engine, issue, service, approve };
}
it('issues a distinct signed enrollment domain only after actual source and bound founder MFA gates', async () => {
  const f = await fixture();
  expect((await f.approve()).state).toBe('approved');
  expect(f.ports.consumeBoundFounderMfa).toHaveBeenCalledOnce();
  expect(f.ports.loadCurrentSource).toHaveBeenCalledTimes(2);
  expect(f.issue.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.ports.consumeBoundFounderMfa.mock.invocationCallOrder[0]!,
  );
  const token = f.ports.recordApproved.mock.calls[0]![1].token;
  expect(token.spec.actionIds).toHaveLength(6);
  expect(new Set(token.spec.actionIds).size).toBe(6);
  expect(await f.engine.verify(f.context.tenantId, token)).toEqual({
    valid: false,
    reason: 'purpose_mismatch',
  });
  await f.service.verifyInstallerToken(
    f.context.tenantId,
    f.current.summary.requestId,
    token,
    'enroll_synthetic_resource',
  );
});
it.each(['rollbackValidated', 'dryRunCompleted'] as const)(
  'cannot sign with missing actual %s',
  async (field) => {
    const f = await fixture();
    f.current.summary.preflight![field] = false;
    await expect(f.approve()).rejects.toThrow();
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.ports.consumeBoundFounderMfa).not.toHaveBeenCalled();
  },
);
it('refuses owner or stale actor before issuing any token', async () => {
  const f = await fixture();
  f.ports.authorizeFounder.mockRejectedValueOnce(Error('Founder required'));
  await expect(f.approve()).rejects.toThrow();
  expect(f.issue).not.toHaveBeenCalled();
  f.context.expectedActorId = id(99);
  await expect(f.approve()).rejects.toThrow();
  expect(f.issue).not.toHaveBeenCalled();
});
it('cannot sign changed or expired source after valid MFA', async () => {
  const f = await fixture();
  f.ports.consumeBoundFounderMfa.mockImplementation(async () => {
    f.current.summary.custodyEpoch++;
  });
  await expect(f.approve()).rejects.toThrow();
  expect(f.issue).not.toHaveBeenCalled();
});
it('recovers the exact prior approval before attempting consumed MFA', async () => {
  const f = await fixture();
  const prior = await f.approve();
  const identity = {
    tenantId: f.context.tenantId,
    actorId: f.context.actorId,
    requestId: f.current.summary.requestId,
    operationKey: f.decision.operationKey,
    intent: { phase: 'approve', request: f.decision, challengeId: id(16) },
  };
  f.ports.recoverApproval.mockResolvedValueOnce({
    data: {
      ...identity,
      phase: 'approve',
      outcome: 'recorded',
      canonicalRequestHash: createHash('sha256')
        .update(ownedDeploymentOperationCanonicalJSON(identity))
        .digest('hex'),
      receiptId: '2',
      result: prior,
      phaseResult: null,
    },
  });
  f.ports.consumeBoundFounderMfa.mockRejectedValue(Error('Already consumed'));
  expect(await f.approve()).toEqual(prior);
  expect(f.issue).toHaveBeenCalledOnce();
  expect(f.ports.consumeBoundFounderMfa).toHaveBeenCalledOnce();
});
it('refuses tampered signature, foreign persisted token, changed scope and revoked deployment at every step', async () => {
  const f = await fixture();
  await f.approve();
  const token = f.ports.recordApproved.mock.calls[0]![1].token;
  const forged = { ...token, signature: 'a'.repeat(64) };
  await expect(
    f.service.verifyInstallerToken(
      f.context.tenantId,
      f.current.summary.requestId,
      forged,
      'authorize_role_switch',
    ),
  ).rejects.toThrow();
  await expect(
    f.service.verifyInstallerToken(f.context.tenantId, id(99), token, 'authorize_role_switch'),
  ).rejects.toThrow();
  const changed = {
    ...f.current,
    manifest: {
      ...f.current.manifest,
      deployment: { ...f.current.manifest.deployment, workerUid: 0 },
    },
  };
  f.ports.loadApprovedInstallerSource.mockResolvedValueOnce({
    source: changed,
    decision: f.decision,
    token,
  });
  await expect(
    f.service.verifyInstallerToken(
      f.context.tenantId,
      f.current.summary.requestId,
      token,
      'stage_owned_controller',
    ),
  ).rejects.toThrow();
  f.current.summary.state = 'revoked';
  await expect(
    f.service.verifyInstallerToken(
      f.context.tenantId,
      f.current.summary.requestId,
      token,
      'verify_installed_scope',
    ),
  ).rejects.toThrow();
});

it('never recovers a foreign or merely similar receipt as confirmed approval', async () => {
  const f = await fixture();
  const prior = await f.approve();
  f.ports.recoverApproval.mockResolvedValueOnce({
    data: {
      requestId: f.current.summary.requestId,
      tenantId: f.context.tenantId,
      actorId: id(99),
      operationKey: f.decision.operationKey,
      phase: 'approve',
      outcome: 'recorded',
      canonicalRequestHash: 'a'.repeat(64),
      intent: { phase: 'approve', request: f.decision, challengeId: id(16) },
      receiptId: '2',
      result: prior,
      phaseResult: null,
    },
  });
  await expect(f.approve()).rejects.toThrow('Owned deployment approval refused');
  expect(f.issue).toHaveBeenCalledOnce();
});

it('renews only current installed scope after installer expiry without reauthorizing installation', async () => {
  const f = await fixture();
  await f.approve();
  const token = f.ports.recordApproved.mock.calls[0]![1].token;
  f.current.summary.state = 'active';
  f.current.summary.installation = {
    operationKey: id(17),
    steps: [
      'enroll_synthetic_resource',
      'authorize_role_switch',
      'publish_scoped_credential',
      'register_karya_identity',
      'stage_owned_controller',
      'verify_installed_scope',
    ].map((step) => ({
      step: step as import('@axiom/types').OwnedDeploymentStep,
      state: 'confirmed',
      receiptId: '3',
      detail: 'Unit fixture readback',
    })),
    receiptId: '4',
  };
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 600000);
  expect(
    await f.service.verifyCredentialRenewal(f.context.tenantId, f.current.summary.requestId),
  ).toMatchObject({
    tenantId: f.context.tenantId,
    bindingId: f.current.summary.bindingId,
    scopeExpiresAt: f.current.manifest.expiresAt,
    maxCredentialLifetimeSeconds: 600,
  });
  await expect(
    f.service.verifyInstallerToken(
      f.context.tenantId,
      f.current.summary.requestId,
      token,
      'stage_owned_controller',
    ),
  ).rejects.toThrow();
  f.current.summary.state = 'revoked';
  await expect(
    f.service.verifyCredentialRenewal(f.context.tenantId, f.current.summary.requestId),
  ).rejects.toThrow();
});

it('allows expired installer history for renewal but never bootstraps from an unavailable current credential', async () => {
  const f = await fixture();
  await f.approve();
  f.current.summary.state = 'active';
  f.current.summary.installation = {
    operationKey: id(70),
    receiptId: '70',
    steps: OWNED_DEPLOYMENT_STEPS.map((step) => ({
      step,
      state: 'confirmed',
      receiptId: '70',
      detail: 'Unit fixture only; no actual deployment',
    })),
  };
  const serviceRpc = vi.fn(async (name: string) => {
    if (name === 'read_owned_deployment_installer_source')
      return f.ports.loadApprovedInstallerSource(f.context.tenantId, f.current.summary.requestId);
    if (name === 'read_owned_deployment_credential_scope')
      throw Error('No current issued credential');
    throw Error('Unexpected authority call');
  });
  const installer = new OwnedDeploymentInstaller({
    serviceRpc,
    manifests: async () => new Map([[f.current.summary.manifestSha256, f.current.manifest]]),
    approval: f.engine,
    credentialDirectory: '/unused-private-unit-fixture',
    verifyTransport: vi.fn(),
  });
  // The enrollment scope lasts one hour; its original installer token is short.
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 16 * 60 * 1000);
  await expect(
    installer.renew({
      tenantId: f.context.tenantId,
      enrollmentId: f.current.summary.requestId,
      credentialId: id(71),
    }),
  ).rejects.toThrow('No current issued credential');
  expect(serviceRpc.mock.calls.map(([name]) => name)).toContain(
    'read_owned_deployment_credential_scope',
  );
  expect(serviceRpc.mock.calls.map(([name]) => name)).not.toContain(
    'reserve_owned_deployment_credential',
  );
  expect(f.issue).toHaveBeenCalledTimes(1);
});

it('refuses tampered retained HMAC before accessing any renewal credential or issuing a JTI', async () => {
  const f = await fixture();
  await f.approve();
  f.current.summary.state = 'active';
  f.current.summary.installation = {
    operationKey: id(70),
    receiptId: '70',
    steps: OWNED_DEPLOYMENT_STEPS.map((step) => ({
      step,
      state: 'confirmed',
      receiptId: '70',
      detail: 'Explicit unit stand-in',
    })),
  };
  const original = {
    source: f.current,
    decision: f.decision,
    token: f.ports.recordApproved.mock.calls[0]![1].token,
  };
  const serviceRpc = vi.fn(async (name: string) => {
    if (name === 'read_owned_deployment_installer_source')
      return { ...original, token: { ...original.token, signature: '0'.repeat(64) } };
    throw Error('Foreign HMAC reached authority');
  });
  const installer = new OwnedDeploymentInstaller({
    serviceRpc,
    manifests: async () => new Map([[f.current.summary.manifestSha256, f.current.manifest]]),
    approval: f.engine,
    credentialDirectory: '/unused-private-unit-fixture',
    verifyTransport: vi.fn(),
  });
  await expect(
    installer.renew({
      tenantId: f.context.tenantId,
      enrollmentId: f.current.summary.requestId,
      credentialId: id(71),
    }),
  ).rejects.toThrow();
  expect(
    serviceRpc.mock.calls.every(([name]) => name === 'read_owned_deployment_installer_source'),
  ).toBe(true);
  expect(f.issue).toHaveBeenCalledTimes(1);
});

it('checks retained HMAC, actual protected token and independently authenticated HTTP before reserving a renewal', async () => {
  // This is an independent HTTP verifier mock, not native PostgREST evidence.
  const f = await fixture();
  await f.approve();
  f.current.summary.state = 'active';
  f.current.summary.installation = {
    operationKey: id(70),
    receiptId: '70',
    steps: OWNED_DEPLOYMENT_STEPS.map((step) => ({
      step,
      state: 'confirmed',
      receiptId: '70',
      detail: 'Explicit unit stand-in',
    })),
  };
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'axiom-owned-renew-unit-'));
  const now = Math.floor(Date.now() / 1000),
    key = randomBytes(32),
    credentialId = id(71);
  const manifest = f.current.manifest;
  const metadata = {
    tenantId: f.context.tenantId,
    bindingId: manifest.bindingId,
    enrollmentId: f.current.summary.requestId,
    credentialId,
    custodyEpoch: 1,
    manifestSha256: f.current.summary.manifestSha256,
    reservationSha256: createHash('sha256').update('unit-reservation').digest('hex'),
    issuerConfigurationSha256: manifest.source.issuerConfigurationSha256,
    issuedAt: now,
    expiresAtSeconds: now + 600,
    expiresAt: new Date((now + 600) * 1000).toISOString(),
    scopeExpiresAtSeconds: Math.floor(Date.parse(manifest.expiresAt) / 1000),
    hostInstallerSha256: manifest.source.hostInstallerSha256,
    bffContainerId: manifest.deployment.bffContainerId,
    bffImage: manifest.deployment.bffImage,
  };
  const claims = {
    role: 'owned_target_controller',
    owned_target_purpose: 'owned_synthetic_target_v1',
    tenant_id: metadata.tenantId,
    binding_id: metadata.bindingId,
    enrollment_id: metadata.enrollmentId,
    jti: credentialId,
    custody_epoch: 1,
    iat: now,
    exp: now + 600,
  };
  const unsigned = [{ alg: 'HS256', typ: 'JWT' }, claims]
    .map((v) => Buffer.from(JSON.stringify(v)).toString('base64url'))
    .join('.');
  const valid = unsigned + '.' + createHmac('sha256', key).update(unsigned).digest('base64url');
  const credential = {
    schemaVersion: 1,
    tenantId: metadata.tenantId,
    bindingId: metadata.bindingId,
    enrollmentId: metadata.enrollmentId,
    credentialId,
    custodyEpoch: 1,
    expiresAt: metadata.expiresAt,
    accessToken: valid,
  };
  const path = join(directory, metadata.bindingId, credentialId, 'backend.key');
  await mkdir(join(directory, metadata.bindingId), { mode: 0o700 });
  await mkdir(join(directory, metadata.bindingId, credentialId), { mode: 0o700 });
  let raw = JSON.stringify(credential) + '\n';
  await writeFile(path, raw, { mode: 0o600 });
  let authenticated = 0;
  const server = createServer(async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '',
      parts = token.split('.');
    const expected = createHmac('sha256', key).update(parts.slice(0, 2).join('.')).digest();
    const provided = Buffer.from(parts[2] ?? '', 'base64url');
    const cryptographic =
      provided.length === expected.length && timingSafeEqual(provided, expected);
    if (
      req.method !== 'POST' ||
      req.url !== '/rest/v1/rpc/verify_owned_target_transport' ||
      !cryptographic
    ) {
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ message: 'signature refused' }));
      return;
    }
    authenticated++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        tenantId: metadata.tenantId,
        bindingId: metadata.bindingId,
        enrollmentId: metadata.enrollmentId,
        credentialId: metadata.credentialId,
        custodyEpoch: 1,
        reservationSha256: metadata.reservationSha256,
        transportVerified: true,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('unit server refused');
  const serviceRpc = vi.fn(async (name: string) => {
    if (name === 'read_owned_deployment_installer_source')
      return f.ports.loadApprovedInstallerSource(f.context.tenantId, f.current.summary.requestId);
    if (name === 'read_owned_deployment_credential_scope')
      return {
        scope: {
          tenantId: metadata.tenantId,
          bindingId: metadata.bindingId,
          enrollmentId: metadata.enrollmentId,
          credentialId,
          custodyEpoch: 1,
          expiresAt: metadata.expiresAt,
        },
        credentialSha256: createHash('sha256').update(raw).digest('hex'),
      };
    if (name === 'read_owned_deployment_credential_reservation')
      return { metadata, credentialSha256: createHash('sha256').update(raw).digest('hex') };
    if (name === 'reserve_owned_deployment_credential')
      return { ...metadata, credentialId: id(72) };
    if (name === 'read_owned_deployment_reviewed_host') return { runtime: 'unit fixture' };
    throw Error('Unexpected renewal authority call');
  });
  const installer = new OwnedDeploymentInstaller({
    serviceRpc,
    manifests: async () => new Map([[f.current.summary.manifestSha256, manifest]]),
    approval: f.engine,
    credentialDirectory: directory,
    verifyTransport: actualOwnedTransportVerifier(
      'http://127.0.0.1:' + address.port,
      'unit-anonymous-transport-key',
    ),
  });
  try {
    expect(
      (
        await installer.renew({
          tenantId: f.context.tenantId,
          enrollmentId: metadata.enrollmentId,
          credentialId: id(72),
        })
      ).reservation.credentialId,
    ).toBe(id(72));
    expect(authenticated).toBe(1);
    expect(
      serviceRpc.mock.calls.filter(([name]) => name === 'reserve_owned_deployment_credential'),
    ).toHaveLength(1);
    serviceRpc.mockClear();
    raw =
      JSON.stringify({
        ...credential,
        accessToken: unsigned + '.' + Buffer.alloc(32).toString('base64url'),
      }) + '\n';
    await writeFile(path, raw, { mode: 0o600 });
    await expect(
      installer.renew({
        tenantId: f.context.tenantId,
        enrollmentId: metadata.enrollmentId,
        credentialId: id(73),
      }),
    ).rejects.toThrow('crypto transport unconfirmed');
    expect(serviceRpc.mock.calls.map(([name]) => name)).not.toContain(
      'reserve_owned_deployment_credential',
    );
    expect(f.issue).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
    key.fill(0);
  }
});

it('keeps exact-claim recovery metadata-only and refuses foreign or incomplete terminal proofs', async () => {
  const f = await fixture();
  const readback = {
    claimId: id(81),
    kind: 'installation',
    tenantId: f.context.tenantId,
    requestId: id(10),
    taskId: id(10),
    manifestSha256: f.current.summary.manifestSha256,
    terminal: 'authority_revoked_with_original_effect_history',
    receiptId: '82',
    hostSha256: null,
    stepReceipts: [{ step: 'publish_scoped_credential', state: 'unconfirmed', receiptId: '80' }],
  };
  const serviceRpc = vi.fn(async () => readback);
  const installer = new OwnedDeploymentInstaller({
    serviceRpc,
    manifests: async () => new Map([[f.current.summary.manifestSha256, f.current.manifest]]),
    approval: f.engine,
    credentialDirectory: '/unused-private-unit-fixture',
    verifyTransport: vi.fn(),
  });
  expect((await installer.readTask({ claimId: id(81) })).terminal).toBe(
    'authority_revoked_with_original_effect_history',
  );
  expect(serviceRpc).toHaveBeenCalledWith('read_owned_deployment_task_receipt', {
    p_claim_id: id(81),
  });
  readback.claimId = id(99);
  await expect(installer.readTask({ claimId: id(81) })).rejects.toThrow();
  readback.claimId = id(81);
  readback.terminal = 'installation_confirmed_history';
  await expect(installer.readTask({ claimId: id(81) })).rejects.toThrow(
    'installation receipt refused',
  );
  expect(f.issue).not.toHaveBeenCalled();
});
