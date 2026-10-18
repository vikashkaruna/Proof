/** Operator-reviewed metadata, not enrollment or mutation authority. A manifest
 * may only describe a new dedicated local synthetic boolean. Browser requests
 * select its digest; they cannot submit or overwrite this configuration. */
import { z } from 'zod';
import { assertOwnedDeploymentAncestors } from './owned-deployment-files.js';
import { ownedHash } from './owned-execution-plan.js';
import { readControllerFile } from '../workloads/controller-files.js';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';
const uuid = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ownedDeploymentManifest = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal('owned_synthetic_enrollment_v1'),
    environment: z.literal('local'),
    tenantId: uuid,
    engagementId: uuid,
    connectorId: uuid,
    fixtureId: uuid,
    resourceId: uuid,
    bindingId: uuid,
    custodyPolicyId: uuid,
    custodyEpoch: z.number().int().positive().safe(),
    scope: z.literal('owned_synthetic_config.audit_log_enable'),
    label: z.literal('Owned synthetic audit configuration'),
    source: z
      .object({
        engineSha256: sha,
        hostInstallerSha256: sha,
        issuerConfigurationSha256: sha,
        capabilitySha256: z.literal(
          'a5b3db560e0707307c69aa70dc6bd62ad4a4ae0612c39f9420db6d99c4a20fb9',
        ),
      })
      .strict(),
    deployment: z
      .object({
        controllerName: z
          .string()
          .regex(/^axiom-proof-local-owned-execution-controller(?:-[a-z0-9]{1,12})?$/),
        controllerImage: image,
        workerImage: image,
        bffImage: image,
        bffContainerId: sha,
        workloadApiVolume: z.string().regex(/^axiom-workload-api-[a-z0-9-]{1,64}$/),
        nodeId: z
          .string()
          .regex(
            /^spiffe:\/\/local\.axiomproof\.test\/spire\/agent\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+$/,
          ),
        spiffeId: z.literal('spiffe://local.axiomproof.test/agent/karya'),
        workerUid: z.literal(20005),
        controllerUid: z.literal(20106),
        socketGid: z.literal(20113),
        dockerGid: z.number().int().nonnegative().max(2147483647),
        brokerPort: z.number().int().min(1).max(65535),
        role: z.literal('owned_target_controller'),
        authenticator: z.literal('authenticator'),
        credentialLifetimeSeconds: z.number().int().min(60).max(900),
      })
      .strict(),
    rollback: z
      .object({
        revokeNewBindingAndCredential: z.literal(true),
        retainResourcesAndJournals: z.literal(true),
        retainSharedRoleAndIdentity: z.literal(true),
        deleteAuditOrEvidence: z.literal(false),
        reverseTargetSetting: z.literal(false),
        requiresFreshRemediationApprovalForTargetUndo: z.literal(true),
      })
      .strict(),
    reviewedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    limitations: z.array(z.string().min(1).max(300)).min(1).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set([value.fixtureId, value.resourceId, value.bindingId]).size !== 3)
      context.addIssue({
        code: 'custom',
        message: 'Distinct dedicated synthetic identifiers required',
      });
    const start = Date.parse(value.reviewedAt),
      end = Date.parse(value.expiresAt);
    if (end <= start || end - start > 86400000)
      context.addIssue({ code: 'custom', message: 'Reviewed manifest lifetime exceeds one day' });
  });
export type OwnedDeploymentManifest = z.infer<typeof ownedDeploymentManifest>;
const registry = z
  .object({ schemaVersion: z.literal(1), manifests: z.array(ownedDeploymentManifest).max(20) })
  .strict();
export function ownedDeploymentManifestSha256(value: unknown) {
  return ownedHash(ownedDeploymentManifest.parse(value));
}
export async function readOwnedDeploymentManifests(filename: string, now = Date.now()) {
  let bytes: Buffer | undefined;
  try {
    await assertOwnedDeploymentAncestors(filename);
    bytes = await readControllerFile(filename);
    const parsed = registry.parse(
      parsePrativedanAssessmentJson(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
    );
    const seen = new Set<string>();
    const used = new Set<string>();
    const result = new Map<string, OwnedDeploymentManifest>();
    for (const value of parsed.manifests) {
      const digest = ownedDeploymentManifestSha256(value);
      if (seen.has(digest)) throw Error();
      seen.add(digest);
      // A different digest must not ambiguously reuse a dedicated target identity.
      for (const identity of [value.bindingId, value.fixtureId, value.resourceId]) {
        if (used.has(identity)) throw Error();
        used.add(identity);
      }
      if (Date.parse(value.reviewedAt) > now || Date.parse(value.expiresAt) <= now) throw Error();
      result.set(digest, value);
    }
    return result;
  } catch {
    throw Error('Owned deployment manifest unavailable');
  } finally {
    bytes?.fill(0);
  }
}
