/** Authentication for the trusted local host administrator channel only.
 * This never authorizes enrollment/installation: every fixed action still
 * needs its distinct signed purpose, retained approval and current SQL claim.
 * Only mount on a fixed private/local channel, default off, without CORS or a
 * browser proxy. The installer receives no approval/signing/issuer secret. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { readControllerFile } from '../workloads/controller-files.js';
import { assertOwnedDeploymentAncestors } from './owned-deployment-files.js';
import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';
const transport = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal('owned_synthetic_installer_transport'),
    existingOperatorAccessToken: z
      .string()
      .min(32)
      .max(8192)
      .regex(/^[A-Za-z0-9._~-]+$/),
  })
  .strict();
export class OwnedDeploymentOperatorAuth {
  constructor(
    private readonly filename: string,
    private readonly enabled = false,
  ) {}
  async authenticate(headers: Headers): Promise<void> {
    let bytes: Buffer | undefined;
    let expected: Buffer | undefined;
    let received: Buffer | undefined;
    try {
      if (
        !this.enabled ||
        headers.has('Origin') ||
        headers.has('Referer') ||
        headers.has('Sec-Fetch-Site') ||
        headers.has('Cookie') ||
        headers.has('Authorization')
      )
        throw Error();
      const value = headers.get('X-Axiom-Local-Operator');
      if (!value || value.length > 8192 || !/^[A-Za-z0-9._~-]{32,8192}$/.test(value)) throw Error();
      await assertOwnedDeploymentAncestors(this.filename);
      bytes = await readControllerFile(this.filename);
      const current = transport.parse(
        parsePrativedanAssessmentJson(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
      );
      // Exact configured credential authentication. Decoded role claims, including
      // an otherwise valid service_role JWT from another issuer, grant nothing.
      expected = createHash('sha256').update(current.existingOperatorAccessToken, 'utf8').digest();
      received = createHash('sha256').update(value, 'utf8').digest();
      if (!timingSafeEqual(expected, received)) throw Error();
    } catch {
      throw Error('Owned deployment operator authentication refused');
    } finally {
      bytes?.fill(0);
      expected?.fill(0);
      received?.fill(0);
    }
  }
}
