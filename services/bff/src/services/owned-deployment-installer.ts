/** Fixed private host channel. Transport authentication is separate; each
 * installation/issuance call re-verifies the retained purpose-bound HMAC and
 * current scope before invoking an allowlisted SQL transition. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import {
  OWNED_DEPLOYMENT_STEPS,
  ownedDeploymentDecision,
  ownedDeploymentSummary,
  ownedDeploymentStep,
} from '@axiom/types';
import type { ApprovalEngine } from '@axiom/approval-engine';
import { OwnedDeploymentApprovals, ownedEnrollmentActionId } from './owned-deployment-approval.js';
import {
  ownedDeploymentManifest,
  type OwnedDeploymentManifest,
} from './owned-deployment-manifest.js';
import { ownedHash } from './owned-execution-plan.js';
import {
  ownedTargetCredentialValue,
  withOwnedTargetCredential,
  ownedTargetScope,
} from './owned-target-credentials.js';
const uuid = z.uuid(),
  sha = z.string().regex(/^[a-f0-9]{64}$/);
const retained = z
  .object({
    source: z
      .object({ summary: ownedDeploymentSummary, manifest: ownedDeploymentManifest })
      .strict(),
    decision: ownedDeploymentDecision,
    token: z.unknown(),
  })
  .strict();
const taskBody = z.object({ tenantId: uuid, claimId: uuid, step: ownedDeploymentStep }).strict();
const issuerBody = z
  .object({
    tenantId: uuid,
    bindingId: uuid,
    enrollmentId: uuid,
    credentialId: uuid,
    reservationSha256: sha,
    manifestSha256: sha,
    custodyEpoch: z.number().int().positive().safe(),
    issuerConfigurationSha256: sha,
  })
  .strict();
const metadata = z
  .object({
    tenantId: uuid,
    bindingId: uuid,
    enrollmentId: uuid,
    credentialId: uuid,
    custodyEpoch: z.number().int().positive().safe(),
    manifestSha256: sha,
    reservationSha256: sha,
    issuerConfigurationSha256: sha,
    issuedAt: z.number().int().safe().positive(),
    expiresAtSeconds: z.number().int().safe().positive(),
    expiresAt: z.iso.datetime({ offset: true }),
    scopeExpiresAtSeconds: z.number().int().safe().positive(),
    hostInstallerSha256: sha,
    bffContainerId: z.string().regex(/^[a-f0-9]{64}$/),
    bffImage: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const reservation = z.object({ metadata, credentialSha256: sha.nullable() }).strict();
const noHuman = async () => {
  throw Error('Private installer has no human approval authority');
};
export interface OwnedDeploymentInstallerPorts {
  serviceRpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  manifests(): Promise<Map<string, OwnedDeploymentManifest>>;
  approval: Pick<ApprovalEngine, 'issue' | 'sign'>;
  credentialDirectory: string;
  /** Actual signed PostgREST transport, never a decoded-claims substitute. */
  verifyTransport(accessToken: string, tenantId: string, bindingId: string): Promise<unknown>;
}
export function actualOwnedTransportVerifier(url: string, anonKey: string) {
  return async (accessToken: string, tenantId: string, bindingId: string) => {
    const result = await createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })
      .rpc('verify_owned_target_transport', { p_tenant_id: tenantId, p_binding_id: bindingId })
      .abortSignal(AbortSignal.timeout(10000));
    if (result.error) throw Error('Owned target crypto transport unconfirmed');
    return result.data as unknown;
  };
}
export class OwnedDeploymentInstaller {
  private readonly approvals: OwnedDeploymentApprovals;
  constructor(private readonly ports: OwnedDeploymentInstallerPorts) {
    if (
      !path.isAbsolute(ports.credentialDirectory) ||
      path.normalize(ports.credentialDirectory) !== ports.credentialDirectory
    )
      throw Error('Owned target credential directory refused');
    this.approvals = new OwnedDeploymentApprovals(
      {
        authorizeFounder: noHuman,
        recoverApproval: noHuman,
        loadCurrentSource: noHuman,
        consumeBoundFounderMfa: noHuman,
        recordApproved: noHuman,
        loadApprovedInstallerSource: (tenantId, requestId) =>
          ports.serviceRpc('read_owned_deployment_installer_source', {
            p_tenant_id: tenantId,
            p_request_id: requestId,
          }),
      },
      ports.approval,
    );
  }
  private async source(
    tenantId: string,
    requestId: string,
    step: (typeof OWNED_DEPLOYMENT_STEPS)[number],
    claimId?: string,
  ) {
    uuid.parse(tenantId);
    uuid.parse(requestId);
    const raw = await this.ports.serviceRpc(
      claimId ? 'read_owned_deployment_step_source' : 'read_owned_deployment_installer_source',
      {
        p_tenant_id: tenantId,
        p_request_id: requestId,
        ...(claimId ? { p_claim_id: uuid.parse(claimId) } : {}),
      },
    );
    const current = retained.parse(raw),
      manifest = (await this.ports.manifests()).get(current.source.summary.manifestSha256);
    if (
      !manifest ||
      ownedHash(manifest) !== ownedHash(current.source.manifest) ||
      current.source.summary.tenantId !== tenantId ||
      current.source.summary.requestId !== requestId
    )
      throw Error('Owned deployment reviewed source changed');
    if (current.source.summary.state === 'active' && step === 'publish_scoped_credential')
      await this.approvals.verifyCredentialRenewal(tenantId, requestId);
    else await this.approvals.verifyInstallerToken(tenantId, requestId, current.token, step);
    return current;
  }
  async claim(raw: unknown) {
    const { claimId } = z.object({ claimId: uuid }).strict().parse(raw);
    const result = z
      .object({ kind: z.enum(['idle', 'preflight', 'installation']), task: z.unknown().nullable() })
      .strict()
      .parse(
        await this.ports.serviceRpc('claim_next_owned_deployment_task', { p_claim_id: claimId }),
      );
    if (result.kind === 'idle') {
      if (result.task !== null) throw Error('Owned deployment task refused');
      return result;
    }
    const task = z
      .object({
        taskId: uuid,
        claimId: z.literal(claimId),
        requestId: uuid,
        tenantId: uuid,
        manifest: ownedDeploymentManifest,
        manifestSha256: sha,
        expiresAt: z.iso.datetime({ offset: true }),
        canonicalRequestHash: sha.optional(),
        persistentMutations: z.literal(0).optional(),
      })
      .strict()
      .parse(result.task);
    const configured = (await this.ports.manifests()).get(task.manifestSha256);
    if (
      !configured ||
      ownedHash(configured) !== ownedHash(task.manifest) ||
      task.manifest.tenantId !== task.tenantId ||
      Date.parse(task.expiresAt) <= Date.now()
    )
      throw Error('Owned deployment task source refused');
    if (result.kind === 'installation')
      await this.source(task.tenantId, task.requestId, 'enroll_synthetic_resource', claimId);
    return { ...result, task };
  }
  async preflight(taskId: string, raw: unknown) {
    const body = z
      .object({ claimId: uuid, observation: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(raw);
    return this.ports.serviceRpc('record_owned_deployment_preflight', {
      p_task_id: uuid.parse(taskId),
      p_claim_id: body.claimId,
      p_host: body.observation,
    });
  }
  async authorize(requestId: string, raw: unknown) {
    const body = taskBody.parse(raw),
      current = await this.source(body.tenantId, requestId, body.step, body.claimId);
    const result = await this.ports.serviceRpc('authorize_owned_deployment_step', {
      p_tenant_id: body.tenantId,
      p_request_id: requestId,
      p_step: body.step,
      p_signed_token: current.token,
    });
    if (body.step !== 'publish_scoped_credential')
      return { authorization: result, reservation: null };
    const scope = metadata.parse(
      await this.ports.serviceRpc('reserve_owned_deployment_credential', {
        p_tenant_id: body.tenantId,
        p_request_id: requestId,
        p_credential_id: ownedEnrollmentActionId(requestId, 'publish_scoped_credential'),
      }),
    );
    return { authorization: result, reservation: scope };
  }
  async issuerAuthorize(raw: unknown) {
    const body = issuerBody.parse(raw),
      current = await this.source(body.tenantId, body.enrollmentId, 'publish_scoped_credential');
    const result = reservation.parse(
      await this.ports.serviceRpc('read_owned_deployment_credential_reservation', {
        p_tenant_id: body.tenantId,
        p_request_id: body.enrollmentId,
        p_credential_id: body.credentialId,
      }),
    );
    const m = result.metadata;
    for (const key of [
      'tenantId',
      'bindingId',
      'enrollmentId',
      'credentialId',
      'reservationSha256',
      'manifestSha256',
      'custodyEpoch',
      'issuerConfigurationSha256',
    ] as const)
      if (m[key] !== body[key]) throw Error('Owned issuer reservation source refused');
    if (
      m.hostInstallerSha256 !== current.source.manifest.source.hostInstallerSha256 ||
      m.bffContainerId !== current.source.manifest.deployment.bffContainerId ||
      m.bffImage !== current.source.manifest.deployment.bffImage ||
      m.expiresAtSeconds * 1000 <= Date.now() ||
      m.expiresAtSeconds > m.scopeExpiresAtSeconds ||
      m.expiresAtSeconds - m.issuedAt > 900
    )
      throw Error('Owned issuer scope expired');
    return m;
  }
  private async transport(token: string, m: z.infer<typeof metadata>) {
    z.object({
      tenantId: z.literal(m.tenantId),
      bindingId: z.literal(m.bindingId),
      enrollmentId: z.literal(m.enrollmentId),
      credentialId: z.literal(m.credentialId),
      custodyEpoch: z.literal(m.custodyEpoch),
      reservationSha256: z.literal(m.reservationSha256),
      transportVerified: z.literal(true),
    })
      .strict()
      .parse(await this.ports.verifyTransport(token, m.tenantId, m.bindingId));
  }
  async issuerComplete(raw: unknown) {
    const body = issuerBody
      .extend({ credential: z.unknown(), credentialSha256: sha })
      .strict()
      .parse(raw);
    const { credential, credentialSha256, ...intent } = body,
      m = await this.issuerAuthorize(intent);
    const scope = ownedTargetScope.parse({
      tenantId: m.tenantId,
      bindingId: m.bindingId,
      enrollmentId: m.enrollmentId,
      credentialId: m.credentialId,
      custodyEpoch: m.custodyEpoch,
      expiresAt: m.expiresAt,
    });
    const token = ownedTargetCredentialValue(credential, scope);
    // Issuer JSON has only ASCII fixed keys, UUIDs, ISO time and base64url token.
    const encoded =
      JSON.stringify(
        Object.fromEntries(
          Object.entries(z.record(z.string(), z.unknown()).parse(credential)).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        ),
      ) + '\n';
    if (createHash('sha256').update(encoded, 'utf8').digest('hex') !== credentialSha256)
      throw Error('Owned issuer candidate digest refused');
    await this.transport(token, m);
    // Recheck signature/scope after the real HTTP call and before SQL publication.
    await this.issuerAuthorize(intent);
    const done = z
      .object({
        credentialId: z.literal(m.credentialId),
        active: z.literal(true),
        tokenSha256: z.literal(credentialSha256),
      })
      .strict()
      .parse(
        await this.ports.serviceRpc('complete_owned_deployment_credential', {
          p_tenant_id: m.tenantId,
          p_request_id: m.enrollmentId,
          p_credential_id: m.credentialId,
          p_token_sha256: credentialSha256,
        }),
      );
    return {
      state: 'active' as const,
      credentialId: done.credentialId,
      credentialSha256: done.tokenSha256,
    };
  }
  private async published(tenantId: string, requestId: string, credentialId: string) {
    const result = reservation.parse(
      await this.ports.serviceRpc('read_owned_deployment_credential_reservation', {
        p_tenant_id: tenantId,
        p_request_id: requestId,
        p_credential_id: uuid.parse(credentialId),
      }),
    );
    if (!result.credentialSha256) throw Error('Owned credential not issued');
    const m = result.metadata,
      scope = ownedTargetScope.parse({
        tenantId: m.tenantId,
        bindingId: m.bindingId,
        enrollmentId: m.enrollmentId,
        credentialId: m.credentialId,
        custodyEpoch: m.custodyEpoch,
        expiresAt: m.expiresAt,
      });
    await withOwnedTargetCredential(
      path.join(this.ports.credentialDirectory, m.bindingId, m.credentialId, 'backend.key'),
      result.credentialSha256,
      scope,
      (token) => this.transport(token, m),
    );
    return result;
  }
  async confirm(requestId: string, raw: unknown) {
    const body = taskBody
        .extend({ readback: z.record(z.string(), z.unknown()) })
        .strict()
        .parse(raw),
      current = await this.source(body.tenantId, requestId, body.step, body.claimId);
    if (body.step === 'publish_scoped_credential')
      await this.published(body.tenantId, requestId, uuid.parse(body.readback.credentialId));
    if (body.step === 'verify_installed_scope') {
      const credential = z
        .object({ credentialId: uuid, credentialSha256: sha, filePublished: z.literal(true) })
        .strict()
        .parse(body.readback.credential);
      const actual = await this.published(body.tenantId, requestId, credential.credentialId);
      if (actual.credentialSha256 !== credential.credentialSha256)
        throw Error('Owned final credential changed');
    }
    return this.ports.serviceRpc('confirm_owned_deployment_step', {
      p_tenant_id: body.tenantId,
      p_request_id: requestId,
      p_step: body.step,
      p_signed_token: current.token,
      p_readback: body.readback,
    });
  }
  async unconfirmed(requestId: string, raw: unknown) {
    const body = taskBody.parse(raw),
      current = await this.source(body.tenantId, requestId, body.step, body.claimId);
    return this.ports.serviceRpc('record_owned_deployment_step_unconfirmed', {
      p_tenant_id: body.tenantId,
      p_request_id: requestId,
      p_step: body.step,
      p_signed_token: current.token,
    });
  }
}
