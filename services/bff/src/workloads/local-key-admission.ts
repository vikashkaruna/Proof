import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  localCustodyPolicySchema,
  localCustodyEventRequestSchema,
  LOCAL_CUSTODY_MAX_BYTES,
  parseLocalCustodyPolicyText,
  localCustodyEventReceiptSchema,
  encodeLocalCustodyEvent,
} from '@axiom/types';
import { LocalKeyPolicy, localKeyReference } from './local-key-policy.js';
import { dispatchKmsBinding } from './dispatch-key-policy.js';
import { DispatchRefused } from './dispatch-payload.js';
const uuid = z
  .uuid()
  .refine((v) =>
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v),
  );
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export function verifyLocalCustodyPolicy(text: string, expectedSha: string) {
  try {
    if (Buffer.byteLength(text, 'utf8') > LOCAL_CUSTODY_MAX_BYTES) throw new DispatchRefused();
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== expectedSha)
      throw new DispatchRefused();
    const p = parseLocalCustodyPolicyText(text);
    const policy = new LocalKeyPolicy({
      tenantId: p.tenantId,
      revision: p.policyId,
      mode: p.mode,
      validity: p.validity,
      primary: p.keyPolicy.primary,
      readable: p.keyPolicy.readable,
    });
    if (policy.fingerprint !== p.keyPolicySha256) throw new DispatchRefused();
    return p;
  } catch {
    throw new DispatchRefused();
  }
}
export function verifyLocalCustodyReceipt(
  value: unknown,
  expected: { tenantId: string; actorId: string; requestText: string },
) {
  try {
    if (Buffer.byteLength(expected.requestText, 'utf8') > LOCAL_CUSTODY_MAX_BYTES * 2)
      throw new DispatchRefused();
    const row = localCustodyEventReceiptSchema.parse(value),
      request = localCustodyEventRequestSchema.parse(JSON.parse(expected.requestText));
    if (encodeLocalCustodyEvent(request) !== expected.requestText) throw new DispatchRefused();
    const p = verifyLocalCustodyPolicy(request.policyText, request.policySha256);
    if (
      p.tenantId !== expected.tenantId ||
      row.tenantId !== expected.tenantId ||
      row.actorId !== expected.actorId ||
      row.requestText !== expected.requestText ||
      row.requestSha256 !== createHash('sha256').update(expected.requestText).digest('hex') ||
      row.operationKey !== request.operationKey ||
      row.transition !== request.transition ||
      row.previousEventId !== request.previousEventId ||
      row.policyId !== p.policyId ||
      row.policySha256 !== request.policySha256 ||
      row.keyPolicySha256 !== p.keyPolicySha256 ||
      (request.transition === 'review' && row.reviewDueAt !== request.nextReviewDueAt)
    )
      throw new DispatchRefused();
    return row;
  } catch {
    throw new DispatchRefused();
  }
}
const admissionSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    policyId: uuid,
    policySha256: sha,
    keyPolicySha256: sha,
    mode: z.enum(['local_demo', 'operator_managed']),
    operation: z.enum(['provision', 'wrap', 'unwrap']),
    keyRef: z.string().max(500),
    workloadId: uuid,
    principalKind: z.enum(['operator', 'producer', 'controller']),
    servicePrincipal: z.string().min(1).max(2048),
    contextSha256: sha.nullable(),
    kind: z.enum(['new_authority', 'accepted_job']),
    policyState: z.enum(['active', 'revoked']),
    currentIsDemo: z.boolean(),
    reviewOverdue: z.boolean(),
    reviewDueAt: z.number().int().safe().positive(),
    verifiedUntil: z.number().int().safe().positive(),
    policyText: z.string().max(16384),
    grant: z
      .object({
        jobId: uuid,
        runId: uuid,
        contextSha256: sha,
        grantSha256: sha,
        originalExpiresAt: z.number().int().safe().positive(),
        activationEventId: uuid,
        activationEpoch: z.number().int().safe().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type LocalCustodyAdmission = z.infer<typeof admissionSchema>;
export type LocalCustodyReadRpc = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;
/** Explicit trusted read-only credential port; never create a service-role or
 * human-writer client here. SQL attests actual tenant/workload from signed role.
 * This is NOT assignable to the old six-file key admission callback: accepted
 * authority retains the real revoked state rather than inventing revoked:false. */
export function createLocalCustodyAdmissionReader(read: LocalCustodyReadRpc) {
  let pending = 0;
  return async (input: {
    tenantId: string;
    policyId: string;
    policySha256: string;
    keyPolicySha256: string;
    workloadId: string;
    servicePrincipal: string;
    operation: 'provision' | 'wrap' | 'unwrap';
    keyRef: string;
    context: Uint8Array | null;
    expectedRunId: string | null;
    deadline: number;
  }): Promise<LocalCustodyAdmission> => {
    try {
      if (
        input.context !== null &&
        (!(input.context instanceof Uint8Array) || input.context.byteLength > 4096)
      )
        throw new DispatchRefused();
      const bound = Object.freeze({
        ...input,
        context: input.context === null ? null : Buffer.from(input.context),
      });
      for (const v of [bound.tenantId, bound.policyId, bound.workloadId]) uuid.parse(v);
      z.enum(['provision', 'wrap', 'unwrap']).parse(bound.operation);
      localKeyReference.parse(bound.keyRef);
      if (bound.keyRef.split('/')[2] !== bound.tenantId) throw new DispatchRefused();
      z.string().min(1).max(2048).parse(bound.servicePrincipal);
      sha.parse(bound.policySha256);
      sha.parse(bound.keyPolicySha256);
      if (
        !Number.isSafeInteger(bound.deadline) ||
        bound.deadline <= Date.now() ||
        bound.deadline > Date.now() + 5000 ||
        bound.keyRef.length > 500
      )
        throw new DispatchRefused();
      if ((bound.operation === 'unwrap') !== (bound.expectedRunId !== null))
        throw new DispatchRefused();
      if (bound.expectedRunId !== null) uuid.parse(bound.expectedRunId);
      const context = bound.context === null ? null : dispatchKmsBinding(bound.context);
      if (
        (bound.operation === 'provision') !== (context === null) ||
        (context && context.tenant !== bound.tenantId)
      )
        throw new DispatchRefused();
      if (pending >= 8) throw new DispatchRefused();
      pending++;
      const work = Promise.resolve()
        .then(() =>
          read(
            'read_local_custody_admission',
            {
              p_tenant_id: bound.tenantId,
              p_policy_id: bound.policyId,
              p_operation: bound.operation,
              p_key_ref: bound.keyRef,
              p_context_text: bound.context?.toString('utf8') ?? null,
              p_deadline_ms: bound.deadline,
            },
            AbortSignal.timeout(Math.max(1, bound.deadline - Date.now())),
          ),
        )
        .finally(() => {
          pending--;
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Awaited<ReturnType<LocalCustodyReadRpc>>;
      try {
        response = await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new DispatchRefused()),
              Math.max(1, bound.deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const { data, error } = response;
      if (error || Date.now() >= bound.deadline) throw new DispatchRefused();
      const row = admissionSchema.parse(data);
      const p = verifyLocalCustodyPolicy(row.policyText, bound.policySha256);
      if (
        p.tenantId !== bound.tenantId ||
        p.policyId !== bound.policyId ||
        row.tenantId !== bound.tenantId ||
        row.policyId !== bound.policyId ||
        row.policySha256 !== bound.policySha256 ||
        row.keyPolicySha256 !== bound.keyPolicySha256 ||
        row.keyPolicySha256 !== p.keyPolicySha256 ||
        row.mode !== p.mode ||
        row.workloadId !== bound.workloadId ||
        row.servicePrincipal !== bound.servicePrincipal ||
        row.principalKind !==
          ({ provision: 'operator', wrap: 'producer', unwrap: 'controller' } as const)[
            bound.operation
          ] ||
        row.workloadId !== p.targetWorkloadId ||
        row.servicePrincipal !==
          (bound.operation === 'provision'
            ? 'operator:' + p.nominatedOperatorId
            : p.servicePrincipals[bound.operation === 'wrap' ? 'producer' : 'controller']) ||
        row.operation !== bound.operation ||
        row.keyRef !== bound.keyRef ||
        row.contextSha256 !== (context?.digest ?? null) ||
        row.verifiedUntil <= Date.now() ||
        row.verifiedUntil > bound.deadline ||
        !p.keyPolicy.readable.includes(row.keyRef)
      )
        throw new DispatchRefused();
      if (row.kind === 'new_authority') {
        if (
          row.policyState !== 'active' ||
          row.grant !== null ||
          (bound.operation === 'wrap' && row.keyRef !== p.keyPolicy.primary) ||
          (row.mode === 'local_demo' && !row.currentIsDemo)
        )
          throw new DispatchRefused();
      } else {
        if (
          bound.operation !== 'unwrap' ||
          !bound.context ||
          !row.grant ||
          row.grant.contextSha256 !== context?.digest ||
          row.grant.originalExpiresAt <= Date.now() ||
          row.verifiedUntil > row.grant.originalExpiresAt ||
          row.grant.runId !== bound.expectedRunId
        )
          throw new DispatchRefused();
        const fields: unknown = JSON.parse(bound.context.toString('utf8'));
        const shape = z
          .tuple([
            z.literal('axiom.assessment.dispatch.dek'),
            z.literal(1),
            uuid,
            uuid,
            uuid,
            uuid,
            uuid.nullable(),
            uuid,
            uuid,
            sha,
          ])
          .parse(fields);
        if (row.grant.jobId !== shape[2]) throw new DispatchRefused();
      }
      return Object.freeze({ ...row, grant: row.grant && Object.freeze({ ...row.grant }) });
    } catch {
      throw new DispatchRefused();
    }
  };
}
export { localCustodyPolicySchema };
