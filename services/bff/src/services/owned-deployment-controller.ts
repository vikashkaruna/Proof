/** Trusted normal-session enrollment orchestration. The browser supplies no
 * manifest, observed proof, token, provider instruction, credential or path. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApprovalEngine } from '@axiom/approval-engine';
import {
  ownedDeploymentRequest,
  ownedDeploymentPreflight,
  ownedDeploymentDecision,
  ownedDeploymentMfaEnvelope,
  ownedDeploymentFence,
  ownedDeploymentInstall,
  ownedDeploymentOperationReadback,
  ownedDeploymentOperationCanonicalJSON,
  ownedDeploymentSummary,
  ownedDeploymentOperationPhase,
  ownedDeploymentRevocationMfaEnvelope,
  ownedDeploymentRevocation,
} from '@axiom/types';
import {
  OwnedDeploymentApprovals,
  ownedEnrollmentDecisionHash,
  type OwnedDeploymentHuman,
} from './owned-deployment-approval.js';
import { ownedHash } from './owned-execution-plan.js';
import type { OwnedDeploymentManifest } from './owned-deployment-manifest.js';
import type { MfaService } from './mfa.js';
export interface OwnedDeploymentControllerPorts {
  humanRpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  serviceRpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  manifests(): Promise<Map<string, OwnedDeploymentManifest>>;
  mfa: Pick<MfaService, 'issueChallenge' | 'verifyChallenge' | 'consumeChallenge'>;
  approval: Pick<ApprovalEngine, 'issue' | 'sign'>;
}
const uuid = z.uuid();
export function ownedEnrollmentRevocationHash(
  c: OwnedDeploymentHuman,
  requestId: string,
  raw: unknown,
) {
  return ownedHash({
    domain: 'axiom.owned-synthetic.enrollment-revocation.v1',
    tenantId: c.tenantId,
    actorId: c.actorId,
    sessionId: c.sessionId,
    requestId: uuid.parse(requestId),
    request: ownedDeploymentRevocation.parse(raw),
  });
}
export class OwnedDeploymentController {
  constructor(private readonly ports: OwnedDeploymentControllerPorts) {}
  private auth(c: OwnedDeploymentHuman) {
    uuid.parse(c.tenantId);
    uuid.parse(c.actorId);
    uuid.parse(c.sessionId);
    if (c.expectedActorId !== c.actorId) throw Error('Owned deployment actor refused');
    return { p_tenant_id: c.tenantId, p_actor_id: c.actorId, p_session_id: c.sessionId };
  }
  private rpc(c: OwnedDeploymentHuman, name: string, args: Record<string, unknown> = {}) {
    return this.ports.humanRpc(name, { ...this.auth(c), ...args });
  }
  async list(c: OwnedDeploymentHuman, requestId?: string) {
    const rows = z
      .array(ownedDeploymentSummary)
      .max(100)
      .parse(
        await this.rpc(c, 'read_owned_deployment_requests', {
          p_request_id: requestId ? uuid.parse(requestId) : null,
        }),
      );
    if (
      rows.some((row) => row.tenantId !== c.tenantId || (requestId && row.requestId !== requestId))
    )
      throw Error('Owned deployment source refused');
    return rows;
  }
  async options(c: OwnedDeploymentHuman, engagementId: string) {
    // Authoritative current human/session check precedes protected registry reads.
    await this.rpc(c, 'read_owned_deployment_requests', { p_request_id: null });
    uuid.parse(engagementId);
    return [...(await this.ports.manifests())]
      .filter(([, m]) => m.tenantId === c.tenantId && m.engagementId === engagementId)
      .map(([manifestSha256, m]) => ({
        manifestSha256,
        engagementId: m.engagementId,
        connectorId: m.connectorId,
        label: m.label,
        environment: m.environment,
        expiresAt: m.expiresAt,
        limitations: m.limitations,
      }));
  }
  async readOperation(
    c: OwnedDeploymentHuman,
    requestId: string,
    phase: string,
    operationKey: string,
  ) {
    const value = ownedDeploymentOperationReadback.parse(
      await this.rpc(c, 'read_owned_deployment_operation', {
        p_request_id: uuid.parse(requestId),
        p_phase: ownedDeploymentOperationPhase.parse(phase),
        p_operation_key: uuid.parse(operationKey),
      }),
    );
    const d = value.data;
    if (
      d.tenantId !== c.tenantId ||
      d.actorId !== c.actorId ||
      d.requestId !== requestId ||
      d.phase !== phase ||
      d.operationKey !== operationKey
    )
      throw Error('Owned deployment recovery refused');
    return value;
  }
  async request(c: OwnedDeploymentHuman, raw: unknown) {
    const request = ownedDeploymentRequest.parse(raw),
      manifest = (await this.ports.manifests()).get(request.manifestSha256);
    if (
      !manifest ||
      manifest.tenantId !== c.tenantId ||
      manifest.engagementId !== request.engagementId ||
      manifest.connectorId !== request.connectorId
    )
      throw Error('Owned deployment manifest refused');
    return ownedDeploymentSummary.parse(
      await this.rpc(c, 'prepare_owned_deployment_request', {
        p_request: request,
        p_manifest: manifest,
      }),
    );
  }
  async preflight(c: OwnedDeploymentHuman, requestId: string, raw: unknown) {
    return ownedDeploymentSummary.parse(
      await this.rpc(c, 'prepare_owned_deployment_preflight', {
        p_request_id: uuid.parse(requestId),
        p_request: ownedDeploymentPreflight.parse(raw),
      }),
    );
  }
  async fence(c: OwnedDeploymentHuman, requestId: string, raw: unknown) {
    return this.rpc(c, 'fence_owned_deployment_intent', {
      p_request_id: uuid.parse(requestId),
      p_request: ownedDeploymentFence.parse(raw),
    });
  }
  private approvals(c: OwnedDeploymentHuman) {
    return new OwnedDeploymentApprovals(
      {
        authorizeFounder: async (context) => {
          await this.rpc(context, 'verify_owned_deployment_founder');
        },
        recoverApproval: (context, requestId, decision) =>
          this.readOperation(context, requestId, 'approve', decision.operationKey),
        loadCurrentSource: (tenantId, requestId) => {
          if (tenantId !== c.tenantId) throw Error('Owned deployment tenant refused');
          return this.rpc(c, 'read_owned_deployment_source', { p_request_id: requestId });
        },
        loadApprovedInstallerSource: (tenantId, requestId) =>
          this.ports.serviceRpc('read_owned_deployment_installer_source', {
            p_tenant_id: tenantId,
            p_request_id: requestId,
          }),
        consumeBoundFounderMfa: async (context, input) => {
          const result = await this.ports.mfa.consumeChallenge({
            userId: context.actorId,
            tenantId: context.tenantId,
            sessionId: context.sessionId,
            purpose: 'owned_synthetic_enrollment',
            challengeId: input.challengeId,
            boundResourceRef: input.operationKey,
            boundPayloadSha256: input.decisionSha256,
            consumedFor: input.operationKey,
          });
          if (!result.ok) throw Error('Owned deployment fresh MFA refused');
        },
        recordApproved: (context, input) =>
          this.rpc(context, 'record_owned_deployment_approval', {
            p_request_id: input.requestId,
            p_decision: input.decision,
            p_challenge_id: input.challengeId,
            p_token: input.token,
          }),
      },
      this.ports.approval,
    );
  }
  async mfa(
    c: OwnedDeploymentHuman,
    requestId: string,
    phase: 'challenge' | 'verify' | 'approve',
    raw: unknown,
  ) {
    const body = ownedDeploymentMfaEnvelope.parse(raw),
      decision = ownedDeploymentDecision.parse(body.request);
    uuid.parse(requestId);
    if (phase === 'approve') {
      if (!body.challengeId || body.code) throw Error('Owned deployment MFA envelope refused');
      return { data: await this.approvals(c).approve(c, requestId, decision, body.challengeId) };
    }
    if (phase === 'challenge' && (body.challengeId || body.code))
      throw Error('Owned deployment MFA envelope refused');
    if (phase === 'verify' && !body.challengeId)
      throw Error('Owned deployment MFA envelope refused');
    const intent =
      phase === 'challenge'
        ? { phase, request: decision }
        : { phase, request: decision, challengeId: body.challengeId! };
    const prior = (await this.readOperation(c, requestId, phase, decision.operationKey)).data;
    if (prior.outcome !== 'not_recorded') {
      const expected = createHash('sha256')
        .update(
          ownedDeploymentOperationCanonicalJSON({
            tenantId: c.tenantId,
            actorId: c.actorId,
            requestId,
            operationKey: decision.operationKey,
            intent,
          }),
        )
        .digest('hex');
      if (
        prior.outcome !== 'recorded' ||
        prior.canonicalRequestHash !== expected ||
        ownedHash(prior.intent) !== ownedHash(intent) ||
        prior.phaseResult?.phase !== phase
      )
        throw Error('Owned deployment MFA outcome unconfirmed');
      return phase === 'challenge' && prior.phaseResult.phase === 'challenge'
        ? { data: prior.phaseResult.challenge }
        : { data: { verified: true } };
    }
    await this.rpc(c, 'prepare_owned_deployment_decision', {
      p_request_id: requestId,
      p_decision: decision,
    });
    const binding = ownedEnrollmentDecisionHash(c, requestId, decision);
    let challengeId = body.challengeId;
    if (phase === 'challenge') {
      const challenge = await this.ports.mfa.issueChallenge({
        userId: c.actorId,
        tenantId: c.tenantId,
        sessionId: c.sessionId,
        purpose: 'owned_synthetic_enrollment',
        boundResourceRef: decision.operationKey,
        boundPayloadSha256: binding,
        ttlMs: 300000,
      });
      if (!challenge.ok) throw Error('Owned deployment fresh MFA refused');
      challengeId = challenge.challengeId;
    } else {
      if (!body.code) throw Error('Owned deployment MFA code required');
      const verified = await this.ports.mfa.verifyChallenge({
        userId: c.actorId,
        tenantId: c.tenantId,
        sessionId: c.sessionId,
        challengeId: challengeId!,
        code: body.code,
        boundResourceRef: decision.operationKey,
        boundPayloadSha256: binding,
      });
      if (
        !verified.ok ||
        verified.purpose !== 'owned_synthetic_enrollment' ||
        verified.boundResourceRef !== decision.operationKey
      )
        throw Error('Owned deployment fresh MFA refused');
    }
    const result = await this.rpc(c, 'record_owned_deployment_mfa_phase', {
      p_request_id: requestId,
      p_phase: phase,
      p_decision: decision,
      p_challenge_id: challengeId,
    });
    const parsed =
      phase === 'challenge'
        ? z
            .object({
              phase: z.literal('challenge'),
              challenge: z
                .object({
                  challengeId: uuid,
                  expiresAt: z.iso.datetime({ offset: true }),
                  maxAttempts: z.number().int().min(1).max(10),
                })
                .strict(),
            })
            .strict()
            .parse(result)
        : z
            .object({ phase: z.literal('verify'), verified: z.literal(true) })
            .strict()
            .parse(result);
    return parsed.phase === 'challenge' ? { data: parsed.challenge } : { data: { verified: true } };
  }
  async revoke(
    c: OwnedDeploymentHuman,
    requestId: string,
    phase: 'revoke_challenge' | 'revoke_verify' | 'revoke',
    raw: unknown,
  ) {
    this.auth(c);
    uuid.parse(requestId);
    const body = ownedDeploymentRevocationMfaEnvelope.parse(raw),
      request = body.request;
    if (phase === 'revoke_challenge' && (body.challengeId || body.code))
      throw Error('Owned stop envelope refused');
    if (phase !== 'revoke_challenge' && !body.challengeId) throw Error('Owned stop MFA required');
    if (phase === 'revoke' && body.code) throw Error('Owned stop code must not be retained');
    const intent =
      phase === 'revoke_challenge'
        ? { phase, request }
        : { phase, request, challengeId: body.challengeId! };
    const prior = (await this.readOperation(c, requestId, phase, request.operationKey)).data;
    if (prior.outcome !== 'not_recorded') {
      const digest = createHash('sha256')
        .update(
          ownedDeploymentOperationCanonicalJSON({
            tenantId: c.tenantId,
            actorId: c.actorId,
            requestId,
            operationKey: request.operationKey,
            intent,
          }),
        )
        .digest('hex');
      if (
        prior.outcome !== 'recorded' ||
        prior.canonicalRequestHash !== digest ||
        ownedHash(prior.intent) !== ownedHash(intent)
      )
        throw Error('Owned stop outcome unconfirmed');
      if (phase === 'revoke') {
        if (
          !prior.result ||
          prior.result.state !== 'revoked' ||
          prior.result.approval?.approvalId !== request.expectedApprovalId
        )
          throw Error('Owned stop receipt refused');
        return { data: prior.result };
      }
      if (phase === 'revoke_challenge' && prior.phaseResult?.phase === 'revoke_challenge')
        return { data: prior.phaseResult.challenge };
      if (phase === 'revoke_verify' && prior.phaseResult?.phase === 'revoke_verify')
        return { data: { verified: true } };
      throw Error('Owned stop phase receipt refused');
    }
    const binding = ownedEnrollmentRevocationHash(c, requestId, request);
    z.object({
      requestId: z.literal(requestId),
      operationKey: z.literal(request.operationKey),
      boundPayloadSha256: z.literal(binding),
      purpose: z.literal('owned_synthetic_revocation'),
    })
      .strict()
      .parse(
        await this.rpc(c, 'prepare_owned_deployment_revocation', {
          p_request_id: requestId,
          p_request: request,
        }),
      );
    if (phase === 'revoke') {
      const consumed = await this.ports.mfa.consumeChallenge({
        userId: c.actorId,
        tenantId: c.tenantId,
        sessionId: c.sessionId,
        purpose: 'owned_synthetic_revocation',
        challengeId: body.challengeId,
        boundResourceRef: request.operationKey,
        boundPayloadSha256: binding,
        consumedFor: request.operationKey,
      });
      if (!consumed.ok) throw Error('Owned stop fresh MFA refused');
      const result = ownedDeploymentSummary.parse(
        await this.rpc(c, 'record_owned_deployment_revocation', {
          p_request_id: requestId,
          p_request: request,
          p_challenge_id: body.challengeId,
        }),
      );
      if (result.state !== 'revoked' || result.approval?.approvalId !== request.expectedApprovalId)
        throw Error('Owned stop outcome unconfirmed');
      return { data: result };
    }
    let challengeId = body.challengeId;
    if (phase === 'revoke_challenge') {
      const challenge = await this.ports.mfa.issueChallenge({
        userId: c.actorId,
        tenantId: c.tenantId,
        sessionId: c.sessionId,
        purpose: 'owned_synthetic_revocation',
        boundResourceRef: request.operationKey,
        boundPayloadSha256: binding,
        ttlMs: 300000,
      });
      if (!challenge.ok) throw Error('Owned stop challenge refused');
      challengeId = challenge.challengeId;
    } else {
      if (!body.code) throw Error('Owned stop code required');
      const verified = await this.ports.mfa.verifyChallenge({
        userId: c.actorId,
        tenantId: c.tenantId,
        sessionId: c.sessionId,
        challengeId: challengeId!,
        code: body.code,
        boundResourceRef: request.operationKey,
        boundPayloadSha256: binding,
      });
      if (
        !verified.ok ||
        verified.purpose !== 'owned_synthetic_revocation' ||
        verified.boundResourceRef !== request.operationKey
      )
        throw Error('Owned stop fresh MFA refused');
    }
    const result = await this.rpc(c, 'record_owned_deployment_revocation_mfa_phase', {
      p_request_id: requestId,
      p_phase: phase,
      p_request: request,
      p_challenge_id: challengeId,
    });
    if (phase === 'revoke_challenge')
      return {
        data: z
          .object({
            phase: z.literal('revoke_challenge'),
            challenge: z
              .object({
                challengeId: uuid,
                expiresAt: z.iso.datetime({ offset: true }),
                maxAttempts: z.number().int().min(1).max(10),
              })
              .strict(),
          })
          .strict()
          .parse(result).challenge,
      };
    z.object({ phase: z.literal('revoke_verify'), verified: z.literal(true) })
      .strict()
      .parse(result);
    return { data: { verified: true } };
  }
  async install(c: OwnedDeploymentHuman, requestId: string, raw: unknown) {
    return ownedDeploymentSummary.parse(
      await this.rpc(c, 'prepare_owned_deployment_install', {
        p_request_id: uuid.parse(requestId),
        p_request: ownedDeploymentInstall.parse(raw),
      }),
    );
  }
}
