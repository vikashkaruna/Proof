import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  localCustodyCancellationSchema,
  localCustodyCancellationReceiptSchema,
  encodeLocalCustodyCancellation,
  localCustodyPolicySchema,
  localCustodyContextSchema,
  localCustodyEventRequestSchema,
  LOCAL_CUSTODY_MAX_BYTES,
  parseLocalCustodyPolicyText,
  localCustodyEventReceiptSchema,
  encodeLocalCustodyEvent,
} from '@axiom/types';
import { LocalKeyPolicy, localKeyReference, type LocalKeyAuthority } from './local-key-policy.js';
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
      const contextFields: unknown =
        bound.context === null ? null : JSON.parse(bound.context.toString('utf8'));
      const contextWorkload =
        contextFields === null ? null : z.array(z.unknown()).parse(contextFields)[5];
      if (
        (bound.operation === 'provision') !== (context === null) ||
        (context && (context.tenant !== bound.tenantId || contextWorkload !== bound.workloadId))
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

/** Unmounted durable143 adapter. The read port must hold an independently issued
 * least-privilege verifier credential. Neither a caller claim nor is_demo alone
 * establishes authority. Accepted grants retain their actual revoked state. */
export function createLocalCustodyKeyAuthority(
  policyText: string,
  policySha256: string,
  read: LocalCustodyReadRpc,
): LocalKeyAuthority {
  const p = verifyLocalCustodyPolicy(policyText, policySha256);
  const reader = createLocalCustodyAdmissionReader(read);
  const value = Object.freeze({ primary: p.keyPolicy.primary });
  const authority: LocalKeyAuthority = {
    value,
    async require(caller, operation, keyRef, deadline, legacyAdmission, context) {
      try {
        if (
          legacyAdmission !== undefined ||
          caller.role !==
            ({ provision: 'operator', wrap: 'producer', unwrap: 'controller' } as const)[
              operation
            ] ||
          caller.tenantId !== p.tenantId ||
          caller.workloadId !== p.targetWorkloadId ||
          !caller.servicePrincipal ||
          (operation === 'unwrap' ? !caller.originalRunId : caller.originalRunId !== undefined) ||
          (operation === 'provision' ? context !== null : !(context instanceof Uint8Array))
        )
          throw new DispatchRefused();
        const row = await reader({
          tenantId: p.tenantId,
          policyId: p.policyId,
          policySha256,
          keyPolicySha256: p.keyPolicySha256,
          workloadId: caller.workloadId,
          servicePrincipal: caller.servicePrincipal,
          operation,
          keyRef,
          context: context ?? null,
          expectedRunId: caller.originalRunId ?? null,
          deadline,
        });
        if ((operation === 'unwrap') !== (row.kind === 'accepted_job')) throw new DispatchRefused();
        return Object.freeze({
          kind: 'durable_local_custody_143' as const,
          // The original immutable grant may outlive policy revocation. Do not
          // put mutable policyState, reminders or short read expiry in this pin.
          commitment: createHash('sha256')
            .update(
              JSON.stringify([
                row.tenantId,
                row.policyId,
                row.policySha256,
                row.keyPolicySha256,
                row.operation,
                row.keyRef,
                row.workloadId,
                row.servicePrincipal,
                row.contextSha256,
                row.kind,
                row.grant && [
                  row.grant.jobId,
                  row.grant.runId,
                  row.grant.contextSha256,
                  row.grant.grantSha256,
                  row.grant.originalExpiresAt,
                  row.grant.activationEventId,
                  row.grant.activationEpoch,
                ],
              ]),
            )
            .digest('hex'),
        });
      } catch {
        throw new DispatchRefused();
      }
    },
  };
  return Object.freeze(authority);
}

/** A current context is read-only guidance; each transition still runs SQL preflight/MFA. */
export function verifyLocalCustodyContext(
  value: unknown,
  expected: { tenantId: string; actorId: string; policyId: string | null; historyPage: boolean },
) {
  const result = localCustodyContextSchema.parse(value);
  if (
    result.tenantId !== expected.tenantId ||
    result.actorId !== expected.actorId ||
    result.selectedPolicyId !== expected.policyId
  )
    throw new DispatchRefused();
  if (new Set(result.rows.map((x) => x.policyId)).size !== result.rows.length)
    throw new DispatchRefused();
  for (const row of result.rows) {
    const p = verifyLocalCustodyPolicy(row.policyText, row.policySha256);
    if (
      p.tenantId !== expected.tenantId ||
      p.policyId !== row.policyId ||
      p.keyPolicySha256 !== row.keyPolicySha256 ||
      new Set(row.actions).size !== row.actions.length
    )
      throw new DispatchRefused();
  }
  if (expected.policyId === null) {
    if (result.history.length || result.nextHistoryCursor !== null) throw new DispatchRefused();
  } else {
    if (
      result.rows.length !== 1 ||
      result.rows[0]!.policyId !== expected.policyId ||
      result.nextCursor !== null
    )
      throw new DispatchRefused();
    for (const event of result.history) {
      verifyLocalCustodyReceipt(event, {
        tenantId: expected.tenantId,
        actorId: event.actorId,
        requestText: event.requestText,
      });
      if (
        event.policyId !== expected.policyId ||
        event.policySha256 !== result.rows[0]!.policySha256
      )
        throw new DispatchRefused();
    }
    if (new Set(result.history.map((e) => e.eventId)).size !== result.history.length)
      throw new DispatchRefused();
    if (!expected.historyPage) {
      const latest = result.history[0],
        head = result.rows[0]!.head;
      const state =
        latest?.transition === 'request'
          ? 'requested'
          : latest?.transition === 'approve'
            ? 'approved'
            : latest?.transition === 'revoke'
              ? 'revoked'
              : 'active';
      if (
        !latest ||
        latest.eventId !== head.eventId ||
        latest.activationEpoch !== head.activationEpoch ||
        latest.reviewDueAt !== head.reviewDueAt ||
        head.state !== state
      )
        throw new DispatchRefused();
    }
    if (
      result.nextHistoryCursor !== null &&
      (result.history.length !== 20 ||
        result.history.at(-1)?.receipt.id !== result.nextHistoryCursor)
    )
      throw new DispatchRefused();
  }
  return result;
}

export function verifyLocalCustodyCancellation(
  value: unknown,
  expected: {
    tenantId: string;
    actorId: string;
    originalRequestText: string;
    cancellationText?: string;
  },
) {
  const row = localCustodyCancellationReceiptSchema.parse(value);
  const c = localCustodyCancellationSchema.parse(JSON.parse(row.cancellationText));
  const original = localCustodyEventRequestSchema.parse(JSON.parse(expected.originalRequestText));
  const policy = verifyLocalCustodyPolicy(original.policyText, original.policySha256);
  if (
    policy.tenantId !== expected.tenantId ||
    encodeLocalCustodyEvent(original) !== expected.originalRequestText ||
    row.tenantId !== expected.tenantId ||
    row.actorId !== expected.actorId ||
    row.originalRequestText !== expected.originalRequestText ||
    c.originalRequestText !== expected.originalRequestText ||
    row.originalOperationKey !== original.operationKey ||
    row.operationKey !== c.operationKey ||
    encodeLocalCustodyCancellation(c) !== row.cancellationText ||
    (expected.cancellationText !== undefined &&
      row.cancellationText !== expected.cancellationText) ||
    row.originalRequestSha256 !==
      createHash('sha256').update(expected.originalRequestText).digest('hex') ||
    row.cancellationSha256 !== createHash('sha256').update(row.cancellationText).digest('hex')
  )
    throw new DispatchRefused();
  return row;
}
