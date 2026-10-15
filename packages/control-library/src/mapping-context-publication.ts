import { z } from 'zod';
import { LIBRARY_VERSION } from './controls';
import {
  ALL_MAPPING_CONTEXTS,
  ALL_SECTOR_PACKS,
  ALL_FRAMEWORK_CONTROLS,
  MAPPING_CONTEXT_PUBLICATION_VERSION,
  MappingStrengthSchema,
  MappingProvenanceSchema,
} from './sector-packs';

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .refine((v) => v !== '00000000-0000-0000-0000-000000000000');
const bounded = (max: number) =>
  z
    .string()
    .refine(
      (v) =>
        Array.from(v).length >= 1 &&
        Array.from(v).length <= max &&
        new TextEncoder().encode(v).byteLength <= max * 4,
    );
export const mappingContextSchema = z
  .strictObject({
    sectorPackCode: bounded(64),
    frameworkCode: bounded(64),
    ref: bounded(300),
    controlId: bounded(100),
    mappingStrength: MappingStrengthSchema,
    provenance: MappingProvenanceSchema,
    note: bounded(2000),
  })
  .refine((m) => !(m.mappingStrength === 'equivalent' && m.provenance === 'reference'));
export const mappingContextPacketSchema = z
  .strictObject({
    publicationVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,79}$/),
    libraryVersion: bounded(100),
    contexts: z.array(mappingContextSchema).min(1).max(1000),
  })
  .superRefine((packet, ctx) => {
    const keys = new Set<string>();
    for (const m of packet.contexts) {
      const key = JSON.stringify([m.sectorPackCode, m.frameworkCode, m.ref, m.controlId]);
      if (keys.has(key)) ctx.addIssue({ code: 'custom', message: 'Duplicate context identity' });
      keys.add(key);
    }
  });
export type MappingContextPacket = z.infer<typeof mappingContextPacketSchema>;
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const receipt = z.strictObject({
  id: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
  entry_hash: sha,
});
/** Authority membership context, independently resolved by the server. It is not an audit home. */
export const mappingContextAuditBindingSchema = z.strictObject({
  authorityTenantId: uuid,
  publisherId: uuid,
  correlationId: uuid,
  sessionId: uuid,
});
export type MappingContextAuditBinding = z.infer<typeof mappingContextAuditBindingSchema>;
const proofSchema = z.strictObject({
  publicationVersion: bounded(80),
  libraryVersion: bounded(100),
  contextCount: z.number().int().min(1).max(1000),
  authorityTenantId: uuid,
  publisherId: uuid,
  correlationId: uuid,
  sessionId: uuid,
  requestText: bounded(1048576),
  requestSha256: sha,
  packetText: bounded(1048576),
  packetSha256: sha,
});
export type MappingContextPublicationProof = z.infer<typeof proofSchema>;
export const mappingContextAdoptionBindingSchema = z.strictObject({
  organisationId: uuid,
  actorId: uuid,
  sessionId: uuid,
  correlationId: uuid,
});
export const mappingContextAdoptionRequestSchema = z.strictObject({
  operationKey: uuid,
  publicationVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,79}$/),
  expectedPacketSha256: sha,
  sectorPackCode: bounded(64),
});
export type MappingContextAdoptionBinding = z.infer<typeof mappingContextAdoptionBindingSchema>;
export type MappingContextAdoptionRequest = z.infer<typeof mappingContextAdoptionRequestSchema>;
const adoptionProofSchema = mappingContextAdoptionBindingSchema
  .extend({
    operationKey: uuid,
    publicationVersion: bounded(80),
    libraryVersion: bounded(100),
    sectorPackCode: bounded(64),
    packetSha256: sha,
    requestText: bounded(4096),
    requestSha256: sha,
    receipt,
  })
  .strict();
export type MappingContextAdoptionProof = z.infer<typeof adoptionProofSchema>;
/** Required trusted server authorizer must independently verify the current authenticated
 * founder/internal account, session, MFA, kill state and reviewed action. No caller boolean
 * or bare UUID establishes those facts. Returned reviewed bytes must be the original human
 * approval. This source-only composition does not implement that adapter or prove MFA.
 */
export interface MappingContextPublicationPorts {
  authorizeCurrentHuman(binding: MappingContextAuditBinding): Promise<unknown>;
  publish(args: Readonly<Record<string, unknown>>): Promise<{ data: unknown; error: unknown }>;
  readProof(args: Readonly<Record<string, unknown>>): Promise<{ data: unknown; error: unknown }>;
}
export interface MappingContextAdoptionPorts {
  /** Independently load the immutable public PG packet; never synthesize from the request. */
  readPublication(
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ data: unknown; error: unknown }>;
  authorizeCurrentHuman(binding: MappingContextAdoptionBinding): Promise<unknown>;
  adopt(args: Readonly<Record<string, unknown>>): Promise<{ data: unknown; error: unknown }>;
  readProof(args: Readonly<Record<string, unknown>>): Promise<{ data: unknown; error: unknown }>;
}
export class MappingContextPublicationRefused extends Error {
  constructor(readonly publicationMayHaveCommitted: boolean) {
    super('Mapping context operation refused; reconcile exact retained state before retrying.');
  }
}
async function digest(text: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const aa = z.record(z.string(), z.unknown()).parse(a),
      bb = z.record(z.string(), z.unknown()).parse(b);
    return (
      Object.keys(aa).length === Object.keys(bb).length &&
      Object.keys(aa).every((k) => Object.hasOwn(bb, k) && same(aa[k], bb[k]))
    );
  }
  return a === b;
};
export function mappingContextSourcePacket(): MappingContextPacket {
  const packet = mappingContextPacketSchema.parse({
    publicationVersion: MAPPING_CONTEXT_PUBLICATION_VERSION,
    libraryVersion: LIBRARY_VERSION,
    contexts: ALL_MAPPING_CONTEXTS,
  });
  for (const m of packet.contexts) {
    const pack = ALL_SECTOR_PACKS.find((p) => p.code === m.sectorPackCode);
    if (
      !pack?.controlIds.includes(m.controlId) ||
      !pack.frameworkCodes.includes(m.frameworkCode) ||
      !ALL_FRAMEWORK_CONTROLS.some((fc) => fc.frameworkCode === m.frameworkCode && fc.ref === m.ref)
    ) {
      throw new MappingContextPublicationRefused(false);
    }
  }
  return packet;
}
/** Global provenance has exact source bytes and original reviewed bytes, no tenant ledger receipt. */
export async function verifyMappingContextPublicationProof(
  value: unknown,
  binding: MappingContextAuditBinding,
  packet: MappingContextPacket,
  reviewedRequestText: string,
): Promise<MappingContextPublicationProof> {
  binding = mappingContextAuditBindingSchema.parse(binding);
  packet = mappingContextPacketSchema.parse(packet);
  const proof = proofSchema.parse(value);
  if (
    !same(
      {
        authorityTenantId: proof.authorityTenantId,
        publisherId: proof.publisherId,
        correlationId: proof.correlationId,
        sessionId: proof.sessionId,
      },
      binding,
    ) ||
    proof.publicationVersion !== packet.publicationVersion ||
    proof.libraryVersion !== packet.libraryVersion ||
    proof.contextCount !== packet.contexts.length ||
    proof.requestText !== reviewedRequestText ||
    new TextEncoder().encode(proof.packetText).byteLength > 1048576 ||
    new TextEncoder().encode(reviewedRequestText).byteLength > 1048576 ||
    proof.packetSha256 !== (await digest(proof.packetText)) ||
    proof.requestSha256 !== (await digest(reviewedRequestText)) ||
    !same(mappingContextPacketSchema.parse(JSON.parse(proof.packetText)), packet) ||
    !same(mappingContextPacketSchema.parse(JSON.parse(reviewedRequestText)), packet)
  )
    throw new MappingContextPublicationRefused(true);
  return proof;
}
/** No hidden write retry; deployment/custody and real human authorization remain separate gates. */
export async function publishMappingContextSource(
  ports: MappingContextPublicationPorts,
  suppliedBinding: MappingContextAuditBinding,
): Promise<MappingContextPublicationProof> {
  let mayHaveCommitted = false;
  try {
    const binding = Object.freeze(mappingContextAuditBindingSchema.parse(suppliedBinding));
    const packet = mappingContextSourcePacket();
    let reviewedRequestText: string | undefined;
    const authorizeBound = async () => {
      const human = z
        .strictObject({
          binding: mappingContextAuditBindingSchema,
          reviewedRequestText: bounded(1048576),
        })
        .parse(await ports.authorizeCurrentHuman(binding));
      if (
        !same(human.binding, binding) ||
        !same(mappingContextPacketSchema.parse(JSON.parse(human.reviewedRequestText)), packet) ||
        new TextEncoder().encode(human.reviewedRequestText).byteLength > 1048576 ||
        (reviewedRequestText !== undefined && human.reviewedRequestText !== reviewedRequestText)
      )
        throw new MappingContextPublicationRefused(mayHaveCommitted);
      reviewedRequestText = human.reviewedRequestText;
      return human.reviewedRequestText;
    };
    const originalRequest = await authorizeBound();
    const args = {
      p_publication_version: packet.publicationVersion,
      p_library_version: packet.libraryVersion,
      p_contexts: structuredClone(packet.contexts),
      p_authority_tenant_id: binding.authorityTenantId,
      p_published_by: binding.publisherId,
      p_correlation_id: binding.correlationId,
      p_session_id: binding.sessionId,
      p_request_text: originalRequest,
    };
    mayHaveCommitted = true;
    const result = await ports.publish(args);
    if (result.error !== null) throw new MappingContextPublicationRefused(true);
    const written = await verifyMappingContextPublicationProof(
      result.data,
      binding,
      packet,
      originalRequest,
    );
    await authorizeBound();
    const read = await ports.readProof({
      p_publication_version: packet.publicationVersion,
      p_authority_tenant_id: binding.authorityTenantId,
      p_published_by: binding.publisherId,
      p_correlation_id: binding.correlationId,
      p_session_id: binding.sessionId,
      p_request_text: originalRequest,
    });
    if (read.error !== null) throw new MappingContextPublicationRefused(true);
    const retained = await verifyMappingContextPublicationProof(
      read.data,
      binding,
      packet,
      originalRequest,
    );
    if (!same(retained, written)) throw new MappingContextPublicationRefused(true);
    await authorizeBound();
    return retained;
  } catch {
    throw new MappingContextPublicationRefused(mayHaveCommitted);
  }
}
export const mappingContextReferenceProofSchema = z.strictObject({
  publicationVersion: bounded(80),
  libraryVersion: bounded(100),
  contextCount: z.number().int().min(1).max(1000),
  packetText: bounded(1048576),
  packetSha256: sha,
});
export type MappingContextReferenceProof = z.infer<typeof mappingContextReferenceProofSchema>;
export async function verifyMappingContextReferenceProof(
  value: unknown,
  request: MappingContextAdoptionRequest,
): Promise<MappingContextReferenceProof> {
  request = mappingContextAdoptionRequestSchema.parse(request);
  const proof = mappingContextReferenceProofSchema.parse(value);
  const packet = mappingContextPacketSchema.parse(JSON.parse(proof.packetText));
  if (
    proof.publicationVersion !== request.publicationVersion ||
    proof.packetSha256 !== request.expectedPacketSha256 ||
    proof.publicationVersion !== packet.publicationVersion ||
    proof.libraryVersion !== packet.libraryVersion ||
    proof.contextCount !== packet.contexts.length ||
    new TextEncoder().encode(proof.packetText).byteLength > 1048576 ||
    proof.packetSha256 !== (await digest(proof.packetText)) ||
    !packet.contexts.some((m) => m.sectorPackCode === request.sectorPackCode)
  )
    throw new MappingContextPublicationRefused(false);
  return proof;
}
export async function verifyMappingContextAdoptionProof(
  value: unknown,
  binding: MappingContextAdoptionBinding,
  request: MappingContextAdoptionRequest,
  reviewedRequestText: string,
  independentlyLoadedPublication: MappingContextReferenceProof,
): Promise<MappingContextAdoptionProof> {
  binding = mappingContextAdoptionBindingSchema.parse(binding);
  request = mappingContextAdoptionRequestSchema.parse(request);
  const publication = await verifyMappingContextReferenceProof(
    independentlyLoadedPublication,
    request,
  );
  const proof = adoptionProofSchema.parse(value);
  if (
    !same(
      {
        organisationId: proof.organisationId,
        actorId: proof.actorId,
        sessionId: proof.sessionId,
        correlationId: proof.correlationId,
      },
      binding,
    ) ||
    proof.libraryVersion !== publication.libraryVersion ||
    proof.operationKey !== request.operationKey ||
    proof.publicationVersion !== request.publicationVersion ||
    proof.sectorPackCode !== request.sectorPackCode ||
    proof.packetSha256 !== request.expectedPacketSha256 ||
    proof.requestText !== reviewedRequestText ||
    new TextEncoder().encode(reviewedRequestText).byteLength > 4096 ||
    proof.requestSha256 !== (await digest(reviewedRequestText)) ||
    !same(mappingContextAdoptionRequestSchema.parse(JSON.parse(reviewedRequestText)), request)
  )
    throw new MappingContextPublicationRefused(true);
  return proof;
}
export async function adoptMappingContextPublication(
  ports: MappingContextAdoptionPorts,
  suppliedBinding: MappingContextAdoptionBinding,
  suppliedRequest: MappingContextAdoptionRequest,
): Promise<MappingContextAdoptionProof> {
  let mayHaveCommitted = false;
  try {
    const binding = Object.freeze(mappingContextAdoptionBindingSchema.parse(suppliedBinding));
    const request = Object.freeze(mappingContextAdoptionRequestSchema.parse(suppliedRequest));
    let reviewedRequestText: string | undefined;
    const authorizeBound = async () => {
      const human = z
        .strictObject({
          binding: mappingContextAdoptionBindingSchema,
          reviewedRequestText: bounded(4096),
        })
        .parse(await ports.authorizeCurrentHuman(binding));
      if (
        !same(human.binding, binding) ||
        !same(
          mappingContextAdoptionRequestSchema.parse(JSON.parse(human.reviewedRequestText)),
          request,
        ) ||
        new TextEncoder().encode(human.reviewedRequestText).byteLength > 4096 ||
        (reviewedRequestText !== undefined && human.reviewedRequestText !== reviewedRequestText)
      )
        throw new MappingContextPublicationRefused(mayHaveCommitted);
      reviewedRequestText = human.reviewedRequestText;
      return human.reviewedRequestText;
    };
    const originalRequest = await authorizeBound();
    const loaded = await ports.readPublication({
      p_publication_version: request.publicationVersion,
    });
    if (loaded.error !== null) throw new MappingContextPublicationRefused(false);
    const publication = await verifyMappingContextReferenceProof(loaded.data, request);
    await authorizeBound();
    const args = {
      p_tenant_id: binding.organisationId,
      p_actor_id: binding.actorId,
      p_session_id: binding.sessionId,
      p_correlation_id: binding.correlationId,
      p_request_text: originalRequest,
    };
    mayHaveCommitted = true;
    const written = await ports.adopt(args);
    if (written.error !== null) throw new MappingContextPublicationRefused(true);
    const proof = await verifyMappingContextAdoptionProof(
      written.data,
      binding,
      request,
      originalRequest,
      publication,
    );
    await authorizeBound();
    const read = await ports.readProof({ ...args, p_operation_key: request.operationKey });
    if (read.error !== null) throw new MappingContextPublicationRefused(true);
    const retained = await verifyMappingContextAdoptionProof(
      read.data,
      binding,
      request,
      originalRequest,
      publication,
    );
    if (!same(proof, retained)) throw new MappingContextPublicationRefused(true);
    await authorizeBound();
    return retained;
  } catch {
    throw new MappingContextPublicationRefused(mayHaveCommitted);
  }
}
