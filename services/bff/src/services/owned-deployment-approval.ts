/** Enrollment approvals are isolated from remediation tokens. This service
 * signs only after current founder authority, retained actual preflight and
 * exact bound MFA have passed; its SQL writer must repeat those source locks. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApprovalEngine, type SignedApprovalToken } from '@axiom/approval-engine';
import {
  OWNED_DEPLOYMENT_PURPOSE,
  OWNED_DEPLOYMENT_STEPS,
  ownedDeploymentDecision,
  ownedDeploymentOperationReadback,
  ownedDeploymentOperationCanonicalJSON,
  ownedDeploymentSummary,
  type OwnedDeploymentDecision,
  type OwnedDeploymentSummary,
  type OwnedDeploymentStep,
} from '@axiom/types';
import {
  ownedDeploymentManifest,
  ownedDeploymentManifestSha256,
} from './owned-deployment-manifest.js';
import { ownedHash } from './owned-execution-plan.js';
const uuid = z.uuid();
export interface OwnedDeploymentHuman {
  tenantId: string;
  actorId: string;
  sessionId: string;
  expectedActorId: string;
}
const source = z
  .object({ summary: ownedDeploymentSummary, manifest: ownedDeploymentManifest })
  .strict();
export type OwnedDeploymentApprovalSource = z.infer<typeof source>;
export interface OwnedDeploymentApprovalPorts {
  /** Protected live global founder designation; ordinary owner/admin is refused. */
  authorizeFounder(context: OwnedDeploymentHuman): Promise<void>;
  /** Read-only operation recovery, authorized under the current human context. */
  recoverApproval(
    context: OwnedDeploymentHuman,
    requestId: string,
    decision: OwnedDeploymentDecision,
    challengeId: string,
  ): Promise<unknown>;
  /** Retained server source, never browser-declared proof/manifest. */
  loadCurrentSource(tenantId: string, requestId: string): Promise<unknown>;
  /** Private trusted read: current approved row+original signed token+decision;
   * no caller-declared source or unsigned UUID can replace this record. */
  loadApprovedInstallerSource(tenantId: string, requestId: string): Promise<unknown>;
  /** Exact new MFA purpose + decision digest + session + operation; current factor
   * and database-clock challenge verification/consume, not login MFA alone. */
  consumeBoundFounderMfa(
    context: OwnedDeploymentHuman,
    input: { requestId: string; operationKey: string; challengeId: string; decisionSha256: string },
  ): Promise<void>;
  /** Atomic trusted human writer: repeats current founder/MFA/source locks,
   * records only this exact token, appends ledger, and returns no bearer. */
  recordApproved(
    context: OwnedDeploymentHuman,
    input: {
      requestId: string;
      decision: OwnedDeploymentDecision;
      challengeId: string;
      decisionSha256: string;
      token: SignedApprovalToken;
    },
  ): Promise<unknown>;
}
function contextCurrent(context: OwnedDeploymentHuman) {
  uuid.parse(context.tenantId);
  uuid.parse(context.actorId);
  uuid.parse(context.sessionId);
  if (context.actorId !== context.expectedActorId) throw Error('Owned deployment approval refused');
}
export function ownedEnrollmentActionId(requestId: string, step: OwnedDeploymentStep) {
  const bytes = Buffer.from(
    ownedHash({
      domain: 'axiom.owned-synthetic.enrollment-action.v1',
      requestId: uuid.parse(requestId),
      step,
    }),
    'hex',
  ).subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x80;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function ownedEnrollmentDecisionHash(
  context: OwnedDeploymentHuman,
  requestId: string,
  raw: unknown,
) {
  return ownedHash({
    domain: OWNED_DEPLOYMENT_PURPOSE,
    tenantId: context.tenantId,
    actorId: context.actorId,
    sessionId: context.sessionId,
    requestId: uuid.parse(requestId),
    decision: ownedDeploymentDecision.parse(raw),
  });
}
function assertSource(
  current: OwnedDeploymentApprovalSource,
  tenantId: string,
  requestId: string,
  requireFreshPreflight = true,
) {
  const { summary: s, manifest: m } = current;
  if (
    s.tenantId !== tenantId ||
    s.requestId !== requestId ||
    m.tenantId !== tenantId ||
    m.engagementId !== s.engagementId ||
    m.connectorId !== s.connectorId ||
    m.bindingId !== s.bindingId ||
    m.fixtureId !== s.fixtureId ||
    m.resourceId !== s.resourceId ||
    m.custodyPolicyId !== s.custodyPolicyId ||
    m.custodyEpoch !== s.custodyEpoch ||
    ownedDeploymentManifestSha256(m) !== s.manifestSha256 ||
    Date.parse(m.reviewedAt) > Date.now() ||
    Date.parse(m.expiresAt) <= Date.now() ||
    Date.parse(s.expiresAt) !== Date.parse(m.expiresAt) ||
    Date.parse(s.expiresAt) <= Date.now() ||
    !s.preflight?.dryRunCompleted ||
    !s.preflight.rollbackValidated ||
    s.preflight.checks.some((check) => check.outcome !== 'passed') ||
    Date.parse(s.preflight.completedAt) > Date.now() ||
    (requireFreshPreflight && Date.parse(s.preflight.expiresAt) <= Date.now()) ||
    Date.parse(s.preflight.expiresAt) - Date.parse(s.preflight.completedAt) > 300000
  )
    throw Error('Owned deployment approval refused');
}
function signedScope(current: OwnedDeploymentApprovalSource, decision: OwnedDeploymentDecision) {
  const { summary: s } = current;
  if (!s.preflight) throw Error('Owned deployment approval refused');
  return {
    purpose: OWNED_DEPLOYMENT_PURPOSE,
    tenantId: s.tenantId,
    enrollmentId: s.requestId,
    bindingId: s.bindingId,
    manifestSha256: s.manifestSha256,
    preflightSha256: s.preflight.sha256,
    rollbackSha256: s.preflight.rollbackSha256,
    custodyPolicyId: s.custodyPolicyId,
    custodyEpoch: s.custodyEpoch,
    scopeExpiresAt: current.manifest.expiresAt,
    decisionSha256: ownedHash(decision),
  };
}
const signedEnrollment = z
  .object({
    spec: z
      .object({
        planId: uuid,
        actionIds: z.array(uuid).length(6),
        approverId: uuid,
        mode: z.literal('batch'),
        concurrency: z.literal(1),
        stopOnFailure: z.literal(true),
        expiresAt: z.iso.datetime({ offset: true }),
        nonce: z.string().regex(/^[a-f0-9]{32}$/),
        conditions: z.record(z.string(), z.unknown()),
        contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const installerSource = z
  .object({ source, decision: ownedDeploymentDecision, token: signedEnrollment })
  .strict();
export class OwnedDeploymentApprovals {
  constructor(
    private readonly ports: OwnedDeploymentApprovalPorts,
    private readonly engine: Pick<ApprovalEngine, 'issue' | 'sign'>,
  ) {}
  async approve(
    context: OwnedDeploymentHuman,
    requestId: string,
    raw: unknown,
    challengeId: string,
  ): Promise<OwnedDeploymentSummary> {
    contextCurrent(context);
    uuid.parse(requestId);
    uuid.parse(challengeId);
    const decision = ownedDeploymentDecision.parse(raw);
    await this.ports.authorizeFounder(context);
    // A lost reply is resolved before attempting to consume the same MFA again.
    const prior = await this.ports.recoverApproval(context, requestId, decision, challengeId);
    if (prior) {
      const recovery = ownedDeploymentOperationReadback.parse(prior).data;
      if (
        recovery.tenantId !== context.tenantId ||
        recovery.actorId !== context.actorId ||
        recovery.requestId !== requestId ||
        recovery.phase !== 'approve' ||
        recovery.operationKey !== decision.operationKey
      )
        throw Error('Owned deployment approval refused');
      if (recovery.outcome !== 'not_recorded') {
        const canonical = ownedDeploymentOperationCanonicalJSON({
          tenantId: context.tenantId,
          actorId: context.actorId,
          requestId,
          operationKey: decision.operationKey,
          intent: { phase: 'approve', request: decision, challengeId },
        });
        if (
          recovery.canonicalRequestHash !==
            createHash('sha256').update(canonical, 'utf8').digest('hex') ||
          ownedHash(recovery.intent) !==
            ownedHash({ phase: 'approve', request: decision, challengeId }) ||
          recovery.outcome !== 'recorded' ||
          !recovery.result ||
          recovery.result.approval?.approvedBy !== context.actorId
        )
          throw Error('Owned deployment approval unconfirmed');
        return recovery.result;
      }
    }
    const current = source.parse(await this.ports.loadCurrentSource(context.tenantId, requestId));
    assertSource(current, context.tenantId, requestId);
    if (
      current.summary.state !== 'preflight_ready' ||
      decision.expectedManifestSha256 !== current.summary.manifestSha256 ||
      decision.expectedPreflightSha256 !== current.summary.preflight!.sha256 ||
      decision.expectedRollbackSha256 !== current.summary.preflight!.rollbackSha256
    )
      throw Error('Owned deployment approval refused');
    const decisionSha256 = ownedEnrollmentDecisionHash(context, requestId, decision);
    await this.ports.consumeBoundFounderMfa(context, {
      requestId,
      operationKey: decision.operationKey,
      challengeId,
      decisionSha256,
    });
    // Re-read after MFA; no valid code can authorize a changed/expired preflight.
    const fresh = source.parse(await this.ports.loadCurrentSource(context.tenantId, requestId));
    assertSource(fresh, context.tenantId, requestId);
    if (ownedHash(fresh) !== ownedHash(current)) throw Error('Owned deployment approval refused');
    await this.ports.authorizeFounder(context);
    const conditions = signedScope(fresh, decision);
    const token = await this.engine.issue(context.tenantId, {
      planId: requestId,
      actionIds: OWNED_DEPLOYMENT_STEPS.map((step) => ownedEnrollmentActionId(requestId, step)),
      approverId: context.actorId,
      mode: 'batch',
      concurrency: 1,
      stopOnFailure: true,
      expiresAt: new Date(
        Math.min(
          Date.now() + 900000,
          Date.parse(fresh.summary.expiresAt),
          Date.parse(fresh.summary.preflight!.expiresAt),
        ),
      ).toISOString(),
      conditions,
      contentDigest: ownedHash({
        domain: OWNED_DEPLOYMENT_PURPOSE,
        manifest: fresh.manifest,
        conditions,
      }),
    });
    return ownedDeploymentSummary.parse(
      await this.ports.recordApproved(context, {
        requestId,
        decision,
        challengeId,
        decisionSha256,
        token,
      }),
    );
  }
  /** Called for every fixed installer action after private transport Auth.
   * HMAC + exact persisted token/source are necessary, not service_role alone.
   * SQL must additionally claim the exact next durable step under current locks. */
  async verifyInstallerToken(
    tenantId: string,
    requestId: string,
    rawToken: unknown,
    step: OwnedDeploymentStep,
  ): Promise<void> {
    uuid.parse(tenantId);
    uuid.parse(requestId);
    if (!OWNED_DEPLOYMENT_STEPS.includes(step)) throw Error('Owned deployment approval refused');
    const token = signedEnrollment.parse(rawToken);
    const approved = installerSource.parse(
      await this.ports.loadApprovedInstallerSource(tenantId, requestId),
    );
    return this.verifyRetainedApproval(approved, token, step, true, tenantId, requestId);
  }
  /** Read-only authorization for renewal of an already active exact enrollment.
   * Does not authorize role/SPIRE/controller installation or a target write.
   * The existing issuer still enforces max15m and this signed scope expiry. */
  async verifyCredentialRenewal(tenantId: string, requestId: string) {
    uuid.parse(tenantId);
    uuid.parse(requestId);
    const approved = installerSource.parse(
      await this.ports.loadApprovedInstallerSource(tenantId, requestId),
    );
    if (approved.source.summary.state !== 'active')
      throw Error('Owned deployment approval refused');
    await this.verifyRetainedApproval(
      approved,
      approved.token,
      'publish_scoped_credential',
      false,
      tenantId,
      requestId,
    );
    const s = approved.source.summary;
    return {
      tenantId: s.tenantId,
      bindingId: s.bindingId,
      enrollmentId: s.requestId,
      custodyEpoch: s.custodyEpoch,
      scopeExpiresAt: approved.source.manifest.expiresAt,
      maxCredentialLifetimeSeconds: approved.source.manifest.deployment.credentialLifetimeSeconds,
    };
  }
  private async verifyRetainedApproval(
    approved: z.infer<typeof installerSource>,
    token: z.infer<typeof signedEnrollment>,
    step: OwnedDeploymentStep,
    requireFreshInstaller: boolean,
    tenantId: string,
    requestId: string,
  ): Promise<void> {
    const current = approved.source,
      decision = approved.decision,
      expectedToken = approved.token;
    assertSource(current, tenantId, requestId, requireFreshInstaller);
    const { summary: s } = current;
    if (
      !['approved', 'installing', 'active'].includes(s.state) ||
      !s.approval ||
      token.spec.approverId !== s.approval.approvedBy ||
      token.spec.planId !== s.requestId ||
      token.spec.mode !== 'batch' ||
      token.spec.concurrency !== 1 ||
      token.spec.stopOnFailure !== true ||
      (requireFreshInstaller && Date.parse(token.spec.expiresAt) <= Date.now()) ||
      Date.parse(s.approval.expiresAt) !== Date.parse(current.manifest.expiresAt) ||
      Date.parse(token.spec.expiresAt) > Date.parse(s.approval.expiresAt) ||
      ownedHash(token) !== ownedHash(expectedToken) ||
      ownedHash(token.spec.conditions) !== ownedHash(signedScope(current, decision)) ||
      token.spec.contentDigest !==
        ownedHash({
          domain: OWNED_DEPLOYMENT_PURPOSE,
          manifest: current.manifest,
          conditions: signedScope(current, decision),
        }) ||
      ownedHash([...token.spec.actionIds].sort()) !==
        ownedHash(
          OWNED_DEPLOYMENT_STEPS.map((item) => ownedEnrollmentActionId(s.requestId, item)).sort(),
        ) ||
      !token.spec.actionIds.includes(ownedEnrollmentActionId(s.requestId, step))
    )
      throw Error('Owned deployment approval refused');
    const expected = await this.engine.sign(s.tenantId, token.spec);
    if (
      !/^[a-f0-9]{64}$/.test(token.signature) ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(token.signature))
    )
      throw Error('Owned deployment approval refused');
  }
}
