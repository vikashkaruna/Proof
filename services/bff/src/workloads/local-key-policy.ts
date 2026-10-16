import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DispatchRefused } from './dispatch-payload.js';

const id = z.uuid().refine((v) => v === v.toLowerCase());
export const localKeyReference = z
  .string()
  .regex(/^axiom-local-dispatch:\/\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/versions\/[1-9][0-9]{0,8}$/)
  .superRefine((value, ctx) => {
    const parts = value.split('/');
    if (!id.safeParse(parts[2]).success || !id.safeParse(parts[3]).success)
      ctx.addIssue({ code: 'custom', message: 'Invalid local reference' });
  });
const policySchema = z
  .object({
    tenantId: id,
    revision: id,
    mode: z.enum(['local_demo', 'operator_managed']),
    validity: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('fixed_expiry'), expiresAt: z.number().int().safe().positive() })
        .strict(),
      z
        .object({
          kind: z.literal('until_revoked'),
          reviewDueAt: z.number().int().safe().positive(),
        })
        .strict(),
    ]),
    primary: localKeyReference,
    readable: z.array(localKeyReference).min(1).max(10),
  })
  .strict();
export type LocalKeyPolicyInput = z.input<typeof policySchema>;
export type LocalKeyOperation = 'provision' | 'wrap' | 'unwrap';
export interface LocalKeyCaller {
  readonly tenantId: string;
  readonly workloadId: string;
  readonly role: 'operator' | 'producer' | 'controller';
  /** Required only by the durable143 authority; supplied by trusted peer identity. */
  readonly servicePrincipal?: string;
  readonly originalRunId?: string;
}
export interface LocalKeyAuthorization {
  readonly kind: 'durable_local_custody_143';
  readonly commitment: string;
}
export interface LocalKeyAuthority {
  readonly value: { readonly primary: string };
  require(
    caller: LocalKeyCaller,
    operation: LocalKeyOperation,
    keyRef: string,
    deadline: number,
    admission?: LocalKeyAdmission,
    context?: Uint8Array | null,
  ): Promise<void | LocalKeyAuthorization>;
}
export interface LocalKeyAdmissionRequest {
  readonly tenantId: string;
  readonly revision: string;
  readonly mode: 'local_demo' | 'operator_managed';
  readonly policySha256: string;
  readonly keyRef: string;
  readonly operation: LocalKeyOperation;
  readonly workloadId: string;
  readonly deadline: number;
}
const admissionSchema = z
  .object({
    verified: z.literal(true),
    tenantId: id,
    revision: id,
    mode: z.enum(['local_demo', 'operator_managed']),
    policySha256: z.string().regex(/^[a-f0-9]{64}$/),
    keyRef: localKeyReference,
    operation: z.enum(['provision', 'wrap', 'unwrap']),
    workloadId: id,
    expiresAt: z.number().int().safe().positive(),
    revoked: z.literal(false),
    isDemo: z.boolean(),
    operatorActivated: z.literal(true),
    admissionReceiptId: id,
    exception: z
      .object({
        verified: z.literal(true),
        reasonSha256: z.string().regex(/^[a-f0-9]{64}$/),
        ownerRequest: z
          .object({
            receiptId: id,
            parentReceiptId: id.nullable(),
            actorId: id,
            policySha256: z.string().regex(/^[a-f0-9]{64}$/),
            at: z.number().int().safe().nonnegative(),
          })
          .strict(),
        founderApproval: z
          .object({
            receiptId: id,
            parentReceiptId: id.nullable(),
            actorId: id,
            policySha256: z.string().regex(/^[a-f0-9]{64}$/),
            at: z.number().int().safe().nonnegative(),
          })
          .strict(),
        operatorActivation: z
          .object({
            receiptId: id,
            parentReceiptId: id.nullable(),
            actorId: id,
            policySha256: z.string().regex(/^[a-f0-9]{64}$/),
            at: z.number().int().safe().nonnegative(),
          })
          .strict(),
        actionClass: z.literal('assessment_dispatch_key_custody'),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** expiresAt is the short-lived verified authority snapshot, NOT custody-policy expiry.
 * until_revoked reviewDueAt is reminder metadata and never automatic revocation.
 * This trusted port must verify durable approvals/current membership, stops,
 * workload identity, policy revision and live tenant state on EVERY call.
 * Merely setting is_demo is never authority. No default verifier is installed. */
export type LocalKeyAdmission = (request: Readonly<LocalKeyAdmissionRequest>) => Promise<unknown>;

export class LocalKeyPolicy {
  #pending = 0;
  readonly value: Readonly<
    Omit<z.output<typeof policySchema>, 'readable'> & { readonly readable: readonly string[] }
  >;
  readonly fingerprint: string;
  constructor(input: LocalKeyPolicyInput) {
    try {
      const parsed = policySchema.parse(input);
      if (
        new Set(parsed.readable).size !== parsed.readable.length ||
        !parsed.readable.includes(parsed.primary) ||
        parsed.readable.some((ref) => ref.split('/')[2] !== parsed.tenantId)
      )
        throw new DispatchRefused();
      this.value = Object.freeze({
        ...parsed,
        validity: Object.freeze({ ...parsed.validity }),
        readable: Object.freeze([...parsed.readable]),
      });
      this.fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            'axiom.local.dispatch.policy',
            1,
            parsed.tenantId,
            parsed.revision,
            parsed.mode,
            parsed.validity,
            parsed.primary,
            [...parsed.readable].sort(),
          ]),
        )
        .digest('hex');
      Object.freeze(this);
    } catch {
      throw new DispatchRefused();
    }
  }
  async require(
    caller: LocalKeyCaller,
    operation: LocalKeyOperation,
    keyRef: string,
    deadline: number,
    admission?: LocalKeyAdmission,
  ): Promise<void> {
    try {
      const role = { provision: 'operator', wrap: 'producer', unwrap: 'controller' }[operation];
      const now = Date.now();
      if (this.value.mode === 'operator_managed' && this.value.validity.kind !== 'until_revoked')
        throw new DispatchRefused();
      if (this.value.validity.kind === 'fixed_expiry' && this.value.validity.expiresAt <= now)
        throw new DispatchRefused();
      if (
        !admission ||
        !id.safeParse(caller.workloadId).success ||
        caller.role !== role ||
        caller.tenantId !== this.value.tenantId ||
        !Number.isSafeInteger(deadline) ||
        deadline <= now ||
        deadline > now + 5000 ||
        !this.value.readable.includes(keyRef) ||
        (operation === 'wrap' && keyRef !== this.value.primary)
      )
        throw new DispatchRefused();
      const request = Object.freeze({
        tenantId: this.value.tenantId,
        revision: this.value.revision,
        mode: this.value.mode,
        policySha256: this.fingerprint,
        keyRef,
        operation,
        workloadId: caller.workloadId,
        deadline,
      });
      if (this.#pending >= 8) throw new DispatchRefused();
      this.#pending++;
      const work = Promise.resolve()
        .then(() => admission(request))
        .finally(() => {
          this.#pending--;
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: unknown;
      try {
        result = await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new DispatchRefused()),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const record = admissionSchema.parse(result);
      for (const key of [
        'tenantId',
        'revision',
        'mode',
        'policySha256',
        'keyRef',
        'operation',
        'workloadId',
      ] as const)
        if (record[key] !== request[key]) throw new DispatchRefused();
      if (
        Date.now() >= deadline ||
        record.expiresAt <= Date.now() ||
        (this.value.mode === 'local_demo' ? !record.isDemo : !record.exception)
      )
        throw new DispatchRefused();
      if (
        record.exception &&
        [
          record.exception.ownerRequest,
          record.exception.founderApproval,
          record.exception.operatorActivation,
        ].some((e) => e.policySha256 !== this.fingerprint)
      )
        throw new DispatchRefused();
      if (
        record.exception &&
        (record.exception.ownerRequest.parentReceiptId !== null ||
          record.exception.founderApproval.parentReceiptId !==
            record.exception.ownerRequest.receiptId ||
          record.exception.operatorActivation.parentReceiptId !==
            record.exception.founderApproval.receiptId ||
          record.exception.ownerRequest.at > record.exception.founderApproval.at ||
          record.exception.founderApproval.at > record.exception.operatorActivation.at ||
          record.exception.operatorActivation.at > Date.now() ||
          new Set([
            record.exception.ownerRequest.receiptId,
            record.exception.founderApproval.receiptId,
            record.exception.operatorActivation.receiptId,
          ]).size !== 3)
      )
        throw new DispatchRefused();
    } catch {
      throw new DispatchRefused();
    }
  }
}
