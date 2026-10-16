import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import {
  publicControlReviewSetSnapshotV2Schema,
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
  PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
  PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
} from '@axiom/types';
import { reviewFixture, ids } from './control-review-fixture.test-helper';
export const assetIds = {
  estate: '77777777-7777-4777-8777-777777777777',
  system: '88888888-8888-4888-8888-888888888888',
  target: '99999999-9999-4999-8999-999999999999',
  association: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
export function linkedReviewFixture() {
  const f = reviewFixture(),
    hash = (v: string) => createHash('sha256').update(v).digest('hex');
  const targetRequest = {
    version: 1,
    kind: 'register_target',
    confirmed: true,
    operationKey: assetIds.target,
    estateId: assetIds.estate,
    systemId: assetIds.system,
    expectedEstateVersion: 1,
    expectedSystemVersion: 1,
    url: 'https://example.org/',
  };
  const targetSnapshot = {
    version: 1,
    kind: 'target',
    id: assetIds.target,
    tenantId: ids.tenant,
    actorId: ids.actor,
    ownershipVerified: false,
    connectorAccessGranted: false,
    estateId: assetIds.estate,
    systemId: assetIds.system,
    estateVersion: 1,
    systemVersion: 1,
    targetVersion: 1,
    estateName: 'Estate',
    systemName: 'Website',
    url: 'https://example.org/',
  };
  function bundle(request: unknown, snapshot: unknown, id: string) {
    const request_text = canonicalJson(request),
      snapshot_text = canonicalJson(snapshot);
    return {
      actor_id: ids.actor,
      operation_key: id,
      request_codec: PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
      request_text,
      request_sha256: hash(request_text),
      snapshot_codec: PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
      snapshot_text,
      snapshot_sha256: hash(snapshot_text),
      receipt: { id: '51', entry_hash: 'd'.repeat(64) },
    };
  }
  const target = bundle(targetRequest, targetSnapshot, assetIds.target);
  const associationRequest = {
    version: 1,
    kind: 'capture',
    confirmed: true,
    operationKey: assetIds.association,
    targetId: assetIds.target,
    expectedTargetSha256: target.snapshot_sha256,
  };
  const associationSnapshot = {
    version: 1,
    kind: 'association',
    id: assetIds.association,
    tenantId: ids.tenant,
    actorId: ids.actor,
    ownershipVerified: false,
    connectorAccessGranted: false,
    targetId: assetIds.target,
    targetSha256: target.snapshot_sha256,
    checkId: ids.check,
    payloadSha256: f.assessment.source.projectionSha256,
    captureReceipt: { id: '42', entryHash: 'e'.repeat(64) },
    requestedUrl: 'https://example.org/',
    finalUrl: 'https://example.org/',
    checkedAt: f.row.snapshot.checkedAt,
  };
  const association = bundle(associationRequest, associationSnapshot, assetIds.association);
  const reference = {
    targetId: assetIds.target,
    targetSha256: target.snapshot_sha256,
    associationId: assetIds.association,
    associationSha256: association.snapshot_sha256,
    associationReceipt: { id: association.receipt.id, entryHash: association.receipt.entry_hash },
  };
  const request = {
    ...f.request,
    version: 2 as const,
    expectedEstateId: assetIds.estate,
    associationRef: reference,
  };
  const snapshot = publicControlReviewSetSnapshotV2Schema.parse({
    ...f.row.snapshot,
    version: 2 as const,
    estateId: assetIds.estate,
    request,
    assetProvenance: {
      schema_version: 1,
      kind: 'public_website_asset_binding',
      tenant_id: ids.tenant,
      estate_id: assetIds.estate,
      system_id: assetIds.system,
      target,
      association,
      ownership_verified: false,
      connector_access_granted: false,
      review_required: true,
    },
  });
  const row = {
    ...f.row,
    estate_id: assetIds.estate,
    request_codec: PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
    request_text: canonicalJson(request),
    request_sha256: hash(canonicalJson(request)),
    snapshot_codec: PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
    snapshot_text: canonicalJson(snapshot),
    snapshot_sha256: hash(canonicalJson(snapshot)),
    snapshot,
  };
  const operation = { ...f.operation, requestText: row.request_text };
  const associationOperation = {
    state: 'recorded' as const,
    tenantId: ids.tenant,
    actorId: ids.actor,
    operationKey: assetIds.association,
    kind: 'capture' as const,
    requestCodec: association.request_codec,
    requestText: association.request_text,
    requestSha256: association.request_sha256,
    snapshotCodec: association.snapshot_codec,
    snapshotText: association.snapshot_text,
    snapshotSha256: association.snapshot_sha256,
    receipt: reference.associationReceipt,
    replayed: false,
  };
  return {
    ...f,
    request,
    row,
    operation,
    reference,
    targetSnapshot,
    associationSnapshot,
    targetRow: {
      id: assetIds.target,
      snapshotText: target.snapshot_text,
      snapshotSha256: target.snapshot_sha256,
      withdrawn: false,
      inventoryCurrent: true,
    },
    associationRow: {
      id: assetIds.association,
      snapshotText: association.snapshot_text,
      snapshotSha256: association.snapshot_sha256,
      operation: associationOperation,
      withdrawn: false,
    },
    head: { ...f.head, estateId: assetIds.estate, review: row },
  };
}
