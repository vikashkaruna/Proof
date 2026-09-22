import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { z } from 'zod';
import { TaskProof } from './tasks.js';

const canonicalId = z.uuid().transform((value) => value.toLowerCase());
export const dispatchContextSchema = z
  .object({
    jobId: canonicalId,
    tenantId: canonicalId,
    actorId: canonicalId,
    workloadId: canonicalId,
    estateId: canonicalId.nullable(),
    engagementId: canonicalId,
    correlationId: canonicalId,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type DispatchContext = z.infer<typeof dispatchContextSchema>;
export interface DispatchKeyWrapper {
  wrap(context: Uint8Array, key: Uint8Array): Promise<{ keyRef: string; wrappedKey: Uint8Array }>;
  /** Return caller-owned bytes: the payload adapter clears them after use. */
  unwrap(context: Uint8Array, keyRef: string, wrappedKey: Uint8Array): Promise<Uint8Array>;
}
const hex = (min: number, max: number) =>
  z
    .string()
    .regex(/^(?:[a-f0-9]{2})+$/)
    .refine((v) => v.length >= min * 2 && v.length <= max * 2);
export const sealedDispatchSchema = z
  .object({
    key_ref: z
      .string()
      .min(1)
      .max(500)
      .regex(/^[a-zA-Z0-9:/_.-]+$/),
    nonce: hex(12, 12),
    ciphertext: hex(60, 1048635),
    wrapped_key: hex(1, 16384),
  })
  .strict();
export type SealedDispatch = z.infer<typeof sealedDispatchSchema>;
export class DispatchRefused extends Error {
  constructor() {
    super('Private assessment dispatch was refused.');
    this.name = 'DispatchRefused';
  }
}
/** Explicit private-pipe handoff only; ordinary logs/JSON cannot serialize input/proof. */
export class PrivateAssessmentPayload {
  readonly #input: string;
  readonly #proof: TaskProof;
  constructor(
    readonly inputHash: string,
    input: string,
    proof: TaskProof,
  ) {
    this.#input = input;
    this.#proof = proof;
  }
  reveal(): { inputJson: string; taskProof: string } {
    return { inputJson: this.#input, taskProof: this.#proof.reveal() };
  }
  toJSON() {
    return '[REDACTED ASSESSMENT PAYLOAD]';
  }
  toString() {
    return this.toJSON();
  }
  [inspect.custom]() {
    return this.toJSON();
  }
}
/** AAD binds the immutable job-to-run assignment, all context and exact wire hash.
 * Versioned/domain-separated from connector credentials, MFA and approvals. */
export function dispatchWrappingContext(context: DispatchContext): Buffer {
  const c = dispatchContextSchema.parse(context);
  return Buffer.from(
    JSON.stringify([
      'axiom.assessment.dispatch.dek',
      1,
      c.jobId,
      c.tenantId,
      c.actorId,
      c.workloadId,
      c.estateId,
      c.engagementId,
      c.correlationId,
      c.inputHash,
    ]),
    'utf8',
  );
}
function dataContext(context: DispatchContext, keyRef: string): Buffer {
  return Buffer.from(
    JSON.stringify([
      'axiom.assessment.dispatch.data',
      1,
      dispatchWrappingContext(context).toString('base64'),
      keyRef,
    ]),
    'utf8',
  );
}
function validateInput(context: DispatchContext, input: string): void {
  if (
    !input ||
    Buffer.byteLength(input, 'utf8') > 1048576 ||
    createHash('sha256').update(input, 'utf8').digest('hex') !== context.inputHash
  )
    throw new DispatchRefused();
  const parsed: unknown = JSON.parse(input);
  const data = z
    .object({
      tenant_id: z.literal(context.tenantId),
      engagement_id: z.literal(context.engagementId),
      library_version: z.string().min(1).max(200),
      answers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      sdf_self_attested: z.boolean().optional(),
      processes_children: z.boolean().optional(),
      processes_health: z.boolean().optional(),
    })
    .strict();
  data.parse(parsed);
}
export async function sealDispatch(
  context: DispatchContext,
  input: string,
  proof: TaskProof,
  wrapper: DispatchKeyWrapper,
): Promise<SealedDispatch> {
  let key: Buffer | undefined, plaintext: Buffer | undefined;
  try {
    const c = dispatchContextSchema.parse(context);
    validateInput(c, input);
    key = randomBytes(32);
    const wrapped = await wrapper.wrap(dispatchWrappingContext(c), key);
    const nonce = randomBytes(12);
    plaintext = Buffer.concat([Buffer.from(proof.reveal(), 'ascii'), Buffer.from(input, 'utf8')]);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(dataContext(c, wrapped.keyRef));
    return sealedDispatchSchema.parse({
      key_ref: wrapped.keyRef,
      nonce: nonce.toString('hex'),
      ciphertext: Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString('hex'),
      wrapped_key: Buffer.from(wrapped.wrappedKey).toString('hex'),
    });
  } catch {
    throw new DispatchRefused();
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
  }
}
export async function openDispatch(
  context: DispatchContext,
  envelope: SealedDispatch,
  proofHash: string,
  wrapper: DispatchKeyWrapper,
): Promise<PrivateAssessmentPayload> {
  let key: Uint8Array | undefined, plaintext: Buffer | undefined;
  try {
    const c = dispatchContextSchema.parse(context),
      e = sealedDispatchSchema.parse(envelope);
    key = await wrapper.unwrap(
      dispatchWrappingContext(c),
      e.key_ref,
      Buffer.from(e.wrapped_key, 'hex'),
    );
    if (key.byteLength !== 32) throw new DispatchRefused();
    const ciphertext = Buffer.from(e.ciphertext, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.nonce, 'hex'));
    decipher.setAAD(dataContext(c, e.key_ref));
    decipher.setAuthTag(ciphertext.subarray(-16));
    plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    const proof = new TaskProof(plaintext.subarray(0, 43).toString('ascii'));
    if (createHash('sha256').update(proof.reveal(), 'ascii').digest('hex') !== proofHash)
      throw new DispatchRefused();
    const input = new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(43));
    validateInput(c, input);
    return new PrivateAssessmentPayload(c.inputHash, input, proof);
  } catch {
    throw new DispatchRefused();
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
  }
}
