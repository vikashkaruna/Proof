import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { encodeLocalCustodyPolicy, localCustodyPolicySchema } from '@axiom/types';
import { LocalKeyPolicy } from './local-key-policy.js';
import { verifyLocalCustodyPolicy } from './local-key-admission.js';

const uuid = z.uuid().refine((v) => v === v.toLowerCase());
export const localCustodyManifestInput = z
  .object({
    tenantId: uuid,
    targetWorkloadId: uuid,
    nominatedOperatorId: uuid,
    trustDomain: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    deploymentBindingSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reviewDueAt: z.number().int().safe().positive(),
    reason: z.string().min(1).max(2000),
  })
  .strict();

/** Operator-side, non-secret custody manifest for one tenant: the exact
 * policyText the owner pastes into Settings → Local custody, and its digest.
 * operator_managed only (D2). The policy is still inert until the owner
 * requests it, a founder approves and the nominated operator activates it,
 * each with MFA; nothing here touches the database. */
export function buildLocalCustodyManifest(
  value: z.input<typeof localCustodyManifestInput>,
  policyId: string = randomUUID(),
) {
  const input = localCustodyManifestInput.parse(value);
  const ref = `axiom-local-dispatch://${input.tenantId}/${uuid.parse(policyId)}/versions/1`;
  const validity = { kind: 'until_revoked' as const, reviewDueAt: input.reviewDueAt };
  const policy = localCustodyPolicySchema.parse({
    version: 1,
    policyId,
    tenantId: input.tenantId,
    mode: 'operator_managed',
    nominatedOperatorId: input.nominatedOperatorId,
    targetWorkloadId: input.targetWorkloadId,
    servicePrincipals: {
      producer: `spiffe://${input.trustDomain}/service/assessment-dispatch-producer`,
      controller: `spiffe://${input.trustDomain}/controller/assessment`,
    },
    validity,
    actionClass: 'assessment_dispatch_key_custody',
    keyPolicy: { primary: ref, readable: [ref] },
    keyPolicySha256: new LocalKeyPolicy({
      tenantId: input.tenantId,
      revision: policyId,
      mode: 'operator_managed',
      validity,
      primary: ref,
      readable: [ref],
    }).fingerprint,
    deploymentBindingSha256: input.deploymentBindingSha256,
    reason: input.reason,
    acceptedLimitations: [
      'hardware_backing_unverified',
      'disaster_recovery_unverified',
      'physical_custody_operator_managed',
    ],
    statutoryComplianceAsserted: false,
    ownershipVerified: false,
  });
  const policyText = encodeLocalCustodyPolicy(policy);
  const policySha256 = createHash('sha256').update(policyText, 'utf8').digest('hex');
  // Same verification the key service applies at startup.
  verifyLocalCustodyPolicy(policyText, policySha256);
  return { policyText, policySha256, primaryKeyRef: ref };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = process.argv[2];
  if (!raw) throw new Error('Usage: local-custody-manifest <input JSON>');
  const manifest = buildLocalCustodyManifest(JSON.parse(raw));
  process.stdout.write(
    JSON.stringify({ policyText: manifest.policyText, policySha256: manifest.policySha256 }) + '\n',
  );
}
