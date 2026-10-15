import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import { parseCatalogueJson } from '@axiom/control-library';
import {
  publicControlPayloadV2Schema,
  publicControlBindingV2Schema,
  publicControlSourceV2Schema,
  type PublicControlPayloadV2,
} from '@axiom/types';

export const PUBLIC_EVIDENCE_V2_CODEC = 'axiom-public-evidence-v2-canonical-json-1' as const;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const retainedSchema = z
  .object({
    codec: z.literal(PUBLIC_EVIDENCE_V2_CODEC),
    payloadBytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_PAYLOAD_BYTES),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
function refused(): never {
  throw new Error('public_evidence_codec_refused');
}

/** IDs, assessment date and the digest itself are NEVER part of payload bytes.
 * Canonicalization is the existing ledger sorted-key JSON codec, UTF-8, no BOM,
 * whitespace or newline. Payload schema bounds integers and rejects lone surrogates.
 */
export function encodePublicEvidencePayloadV2(input: unknown) {
  const parsed = publicControlPayloadV2Schema.safeParse(input);
  if (!parsed.success) return refused();
  const payloadText = canonicalJson(parsed.data);
  const payloadBytes = new TextEncoder().encode(payloadText);
  if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) return refused();
  return {
    codec: PUBLIC_EVIDENCE_V2_CODEC,
    payloadText,
    payloadBytes,
    payloadSha256: hash(payloadBytes),
  };
}

/** Scope is supplied ONLY by the authenticated server's retained context.
 * This pure binder does not authenticate IDs, establish publication custody or
 * authorize capture. No placeholder IDs/hash or mutable browser context is used.
 */
export function bindPublicEvidenceV2(payload: unknown, binding: unknown) {
  const context = publicControlBindingV2Schema.safeParse(binding);
  if (!context.success) return refused();
  const admitted = publicControlPayloadV2Schema.safeParse(payload);
  if (!admitted.success) return refused();
  const parsed = admitted.data;
  const encoded = encodePublicEvidencePayloadV2(parsed);
  const source = publicControlSourceV2Schema.parse({
    ...parsed,
    ...context.data,
    projectionSha256: encoded.payloadSha256,
  });
  return { ...encoded, source };
}

function payloadFromSource(
  source: z.infer<typeof publicControlSourceV2Schema>,
): PublicControlPayloadV2 {
  return {
    version: source.version,
    extractorVersion: source.extractorVersion,
    pages: source.pages,
    candidates: source.candidates,
    candidatesTruncated: source.candidatesTruncated,
    scope: source.scope,
    requiresHumanReview: source.requiresHumanReview,
  };
}

/** Recomputes actual payload bytes/hash. Tenant and publication authentication
 * remain the controller's responsibility; this digest intentionally is not an
 * authentication envelope for the separately bound scope/date fields. */
export function verifyPublicControlSourceV2(input: unknown) {
  const parsed = publicControlSourceV2Schema.safeParse(input);
  if (!parsed.success) return refused();
  const encoded = encodePublicEvidencePayloadV2(payloadFromSource(parsed.data));
  if (encoded.payloadSha256 !== parsed.data.projectionSha256) return refused();
  return parsed.data;
}

/** Exact retained byte readback: rejects invalid UTF-8/BOM, duplicate decoded
 * keys, normalization, whitespace, alternate key ordering and mismatched hashes.
 * The independently authenticated scope is deliberately passed separately.
 */
export function readPublicEvidenceV2(retained: unknown, binding: unknown) {
  try {
    const record = retainedSchema.safeParse(retained);
    if (!record.success) return refused();
    // Copy once so even shared/mutable caller buffers cannot change validation.
    const bytes = Uint8Array.from(record.data.payloadBytes);
    if (hash(bytes) !== record.data.payloadSha256) return refused();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const payload = parseCatalogueJson(text, MAX_PAYLOAD_BYTES);
    const result = bindPublicEvidenceV2(payload, binding);
    if (
      result.payloadText !== text ||
      !Buffer.from(result.payloadBytes).equals(Buffer.from(bytes)) ||
      result.payloadSha256 !== record.data.payloadSha256
    )
      return refused();
    return result;
  } catch {
    return refused();
  }
}
