/** Private per-binding transport configuration. Decoding checks configuration;
 * PostgREST verifies the signature and SQL rechecks current approved enrollment.
 * This module cannot mint, enroll, approve, renew, or widen a credential. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertOwnedDeploymentAncestors } from './owned-deployment-files.js';
import { readControllerFile } from '../workloads/controller-files.js';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';
const uuid = z.uuid();
const epoch = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ownedTargetScope = z
  .object({
    tenantId: uuid,
    bindingId: uuid,
    enrollmentId: uuid,
    credentialId: uuid,
    custodyEpoch: epoch,
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type OwnedTargetScope = z.infer<typeof ownedTargetScope>;
const credential = ownedTargetScope
  .extend({ schemaVersion: z.literal(1), accessToken: z.string().min(100).max(8192) })
  .strict();
const claims = z
  .object({
    role: z.literal('owned_target_controller'),
    owned_target_purpose: z.literal('owned_synthetic_target_v1'),
    tenant_id: uuid,
    binding_id: uuid,
    enrollment_id: uuid,
    jti: uuid,
    custody_epoch: epoch,
    iat: epoch,
    exp: epoch,
    nbf: epoch.optional(),
  })
  .passthrough();
/** Same strict scope/claims validation for an unpublished issuer candidate.
 * Signature verification still requires the actual signed PostgREST call. */
export function ownedTargetCredentialValue(raw: unknown, expected: OwnedTargetScope): string {
  try {
    ownedTargetScope.parse(expected);
    const value = credential.parse(raw);
    if (
      value.tenantId !== expected.tenantId ||
      value.bindingId !== expected.bindingId ||
      value.enrollmentId !== expected.enrollmentId ||
      value.credentialId !== expected.credentialId ||
      value.custodyEpoch !== expected.custodyEpoch ||
      value.expiresAt !== expected.expiresAt
    )
      throw Error();
    const parts = value.accessToken.split('.');
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)) ||
      parts[2]!.length !== 43
    )
      throw Error();
    const decode = (part: string) =>
      parsePrativedanAssessmentJson(
        new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(part, 'base64url')),
      );
    z.object({ alg: z.literal('HS256'), typ: z.literal('JWT').optional() })
      .strict()
      .parse(decode(parts[0]!));
    const token = claims.parse(decode(parts[1]!));
    const now = Math.floor(Date.now() / 1000);
    if (
      token.tenant_id !== expected.tenantId ||
      token.binding_id !== expected.bindingId ||
      token.enrollment_id !== expected.enrollmentId ||
      token.jti !== expected.credentialId ||
      token.custody_epoch !== expected.custodyEpoch ||
      token.iat > now ||
      token.exp <= now ||
      token.exp <= token.iat ||
      token.exp - token.iat > 900 ||
      (token.nbf !== undefined && token.nbf > now) ||
      token.exp * 1000 !== Date.parse(expected.expiresAt)
    )
      throw Error();
    return value.accessToken;
  } catch {
    throw Error('Owned target credential refused');
  }
}
/** Call only after independently resolving exact tenant/binding from retained
 * server source. Neither a browser nor an agent supplies the file or digest. */
export async function withOwnedTargetCredential<T>(
  filename: string,
  expectedSha256: string,
  expected: OwnedTargetScope,
  consume: (accessToken: string) => Promise<T>,
): Promise<T> {
  let bytes: Buffer | undefined;
  let accessToken: string;
  try {
    ownedTargetScope.parse(expected);
    sha.parse(expectedSha256);
    await assertOwnedDeploymentAncestors(filename);
    bytes = await readControllerFile(filename);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw Error();
    if (bytes.length > 16384) throw Error();
    accessToken = ownedTargetCredentialValue(
      parsePrativedanAssessmentJson(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
      expected,
    );
  } catch {
    throw Error('Owned target credential refused');
  } finally {
    bytes?.fill(0);
  }
  // Provider errors are handled by the existing broker; never include this
  // configuration or bearer in error context/logs. No process.env assignment.
  return consume(accessToken);
}
