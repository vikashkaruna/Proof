/** Pure verification of retained, human-declared asset scope. SQL must authenticate
 * the immutable operation/ledger bindings before freezing this packet. This
 * helper establishes neither live authority nor website ownership or custody. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
  PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
  PUBLIC_WEBSITE_ASSET_MAX_BYTES,
  parsePublicWebsiteAssetRequestText,
  parsePublicWebsiteAssetSnapshotText,
} from '@axiom/types';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptId = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const receipt = z.object({ id: receiptId, entry_hash: digest }).strict();
const retainedText = z
  .string()
  .min(2)
  .refine((v) => Buffer.byteLength(v, 'utf8') <= PUBLIC_WEBSITE_ASSET_MAX_BYTES);
const bundle = z
  .object({
    actor_id: uuid,
    operation_key: uuid,
    request_codec: z.literal(PUBLIC_WEBSITE_ASSET_REQUEST_CODEC),
    request_text: retainedText,
    request_sha256: digest,
    snapshot_codec: z.literal(PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC),
    snapshot_text: retainedText,
    snapshot_sha256: digest,
    receipt,
  })
  .strict();

export const FrozenPublicWebsiteAssetProvenanceSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('public_website_asset_binding'),
    tenant_id: uuid,
    estate_id: uuid,
    system_id: uuid,
    target: bundle,
    association: bundle,
    ownership_verified: z.literal(false),
    connector_access_granted: z.literal(false),
    review_required: z.literal(true),
  })
  .strict();
export type FrozenPublicWebsiteAssetProvenance = z.infer<
  typeof FrozenPublicWebsiteAssetProvenanceSchema
>;
export const PublicWebsiteAssetVerificationContextSchema = z
  .object({
    tenantId: uuid,
    estateId: uuid,
    checkId: uuid,
    payloadSha256: digest,
    captureReceipt: receipt,
    associationRef: z
      .object({
        associationId: uuid,
        associationSha256: digest,
        targetId: uuid,
        targetSha256: digest,
        associationReceipt: z.object({ id: receiptId, entryHash: digest }).strict(),
      })
      .strict(),
  })
  .strict();
export type PublicWebsiteAssetVerificationContext = z.infer<
  typeof PublicWebsiteAssetVerificationContextSchema
>;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const refused = () => Error('public_website_asset_provenance_refused');
function decode(value: z.infer<typeof bundle>, tenantId: string) {
  if (
    sha(value.request_text) !== value.request_sha256 ||
    sha(value.snapshot_text) !== value.snapshot_sha256
  )
    throw refused();
  const request = parsePublicWebsiteAssetRequestText(value.request_text);
  const snapshot = parsePublicWebsiteAssetSnapshotText(value.snapshot_text);
  if (
    request.operationKey !== value.operation_key ||
    snapshot.actorId !== value.actor_id ||
    snapshot.tenantId !== tenantId
  )
    throw refused();
  return { request, snapshot };
}
/** Derive only from exact frozen bytes and independently retained source context.
 * Receipts here are references, not independently authenticated signatures. */
export function verifyFrozenPublicWebsiteAssetProvenance(value: unknown, context: unknown) {
  try {
    const frozen = FrozenPublicWebsiteAssetProvenanceSchema.parse(value);
    const scope = PublicWebsiteAssetVerificationContextSchema.parse(context);
    const target = decode(frozen.target, frozen.tenant_id);
    const association = decode(frozen.association, frozen.tenant_id);
    const ref = scope.associationRef;
    if (
      frozen.tenant_id !== scope.tenantId ||
      frozen.estate_id !== scope.estateId ||
      target.request.kind !== 'register_target' ||
      target.snapshot.kind !== 'target' ||
      association.snapshot.kind !== 'association' ||
      (association.request.kind !== 'capture' && association.request.kind !== 'associate_capture')
    )
      throw refused();
    const t = target.snapshot;
    const a = association.snapshot;
    const request = association.request;
    if (
      t.estateId !== frozen.estate_id ||
      t.systemId !== frozen.system_id ||
      target.request.estateId !== t.estateId ||
      target.request.systemId !== t.systemId ||
      target.request.expectedEstateVersion !== t.estateVersion ||
      target.request.expectedSystemVersion !== t.systemVersion ||
      target.request.url !== t.url ||
      t.id !== ref.targetId ||
      frozen.target.snapshot_sha256 !== ref.targetSha256 ||
      a.id !== ref.associationId ||
      frozen.association.snapshot_sha256 !== ref.associationSha256 ||
      frozen.association.receipt.id !== ref.associationReceipt.id ||
      frozen.association.receipt.entry_hash !== ref.associationReceipt.entryHash ||
      frozen.target.receipt.id === frozen.association.receipt.id ||
      a.targetId !== t.id ||
      a.targetSha256 !== frozen.target.snapshot_sha256 ||
      request.targetId !== t.id ||
      request.expectedTargetSha256 !== frozen.target.snapshot_sha256 ||
      a.requestedUrl !== t.url ||
      a.checkId !== scope.checkId ||
      a.payloadSha256 !== scope.payloadSha256 ||
      a.captureReceipt.id !== scope.captureReceipt.id ||
      a.captureReceipt.entryHash !== scope.captureReceipt.entry_hash ||
      (request.kind === 'associate_capture' &&
        (request.checkId !== a.checkId ||
          request.expectedPayloadSha256 !== a.payloadSha256 ||
          request.expectedCaptureReceipt !== a.captureReceipt.id))
    )
      throw refused();
    return {
      label: 'human-declared asset scope' as const,
      tenant_id: frozen.tenant_id,
      estate: { id: t.estateId, name: t.estateName, version: t.estateVersion },
      system: { id: t.systemId, name: t.systemName, version: t.systemVersion },
      target: {
        id: t.id,
        version: t.targetVersion,
        url: t.url,
        sha256: frozen.target.snapshot_sha256,
        declared_by: frozen.target.actor_id,
        receipt: frozen.target.receipt,
      },
      association: {
        id: a.id,
        sha256: frozen.association.snapshot_sha256,
        declared_by: frozen.association.actor_id,
        receipt: frozen.association.receipt,
        check_id: a.checkId,
        payload_sha256: a.payloadSha256,
        capture_receipt: a.captureReceipt,
        requested_url: a.requestedUrl,
        final_url: a.finalUrl,
        checked_at: a.checkedAt,
      },
      ownership_verified: false as const,
      connector_access_granted: false as const,
      review_required: true as const,
      qualification:
        'Human-declared asset scope retained with this review. It does not verify website ownership, grant connector access, or establish current inventory or authority.' as const,
    };
  } catch {
    throw refused();
  }
}
