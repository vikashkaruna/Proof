/** Synthetic source3: no live website, authenticated human, controller or receipt. */
import { canonicalJson } from '@axiom/ledger';
import {
  PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
  PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
  PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
  PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
} from '@axiom/types';
import { publicReportFixture, sha, ids } from './public-control-provenance.test-helper';
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
function bundle(
  request: unknown,
  snapshot: unknown,
  actor: string,
  key: string,
  receiptId: string,
) {
  const request_text = canonicalJson(request),
    snapshot_text = canonicalJson(snapshot);
  return {
    actor_id: actor,
    operation_key: key,
    request_codec: PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
    request_text,
    request_sha256: sha(request_text),
    snapshot_codec: PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
    snapshot_text,
    snapshot_sha256: sha(snapshot_text),
    receipt: { id: receiptId, entry_hash: 'c'.repeat(64) },
  };
}
export function assetReportFixture(kind: 'board' | 'auditor' = 'board') {
  const f = publicReportFixture(kind);
  f.human.capture.page_sources = f.human.capture.page_sources.map((p) => ({
    ...p,
    requestedUrl: p.requestedUrl?.replace('example.test', 'example.org') ?? null,
    finalUrl: p.finalUrl?.replace('example.test', 'example.org') ?? null,
  }));
  f.human.capture.page_sources_text = JSON.stringify(f.human.capture.page_sources, null, 1);
  f.human.capture.page_sources_sha256 = sha(f.human.capture.page_sources_text);
  const estate = id(20),
    system = id(21),
    targetId = id(22),
    associationId = id(23);
  const common = {
    version: 1,
    tenantId: ids.tenant,
    ownershipVerified: false,
    connectorAccessGranted: false,
  };
  const target = bundle(
    {
      version: 1,
      kind: 'register_target',
      operationKey: id(24),
      confirmed: true,
      estateId: estate,
      systemId: system,
      expectedEstateVersion: 1,
      expectedSystemVersion: 2,
      url: 'https://example.org/',
    },
    {
      ...common,
      kind: 'target',
      id: targetId,
      actorId: id(25),
      estateId: estate,
      systemId: system,
      estateVersion: 1,
      systemVersion: 2,
      targetVersion: 1,
      estateName: 'Declared <estate>',
      systemName: 'Declared <system>',
      url: 'https://example.org/',
    },
    id(25),
    id(24),
    '20',
  );
  const association = bundle(
    {
      version: 1,
      kind: 'associate_capture',
      operationKey: id(26),
      confirmed: true,
      targetId,
      expectedTargetSha256: target.snapshot_sha256,
      checkId: ids.check,
      expectedPayloadSha256: f.human.capture.payload_sha256,
      expectedCaptureReceipt: '11',
    },
    {
      ...common,
      kind: 'association',
      id: associationId,
      actorId: id(27),
      targetId,
      targetSha256: target.snapshot_sha256,
      checkId: ids.check,
      payloadSha256: f.human.capture.payload_sha256,
      captureReceipt: { id: '11', entryHash: 'a'.repeat(64) },
      requestedUrl: 'https://example.org/',
      finalUrl: 'https://example.org/',
      checkedAt: f.human.capture.checked_at,
    },
    id(27),
    id(26),
    '21',
  );
  const assetProvenance = {
    schema_version: 1,
    kind: 'public_website_asset_binding',
    tenant_id: ids.tenant,
    estate_id: estate,
    system_id: system,
    target,
    association,
    ownership_verified: false,
    connector_access_granted: false,
    review_required: true,
  };
  const associationRef = {
    associationId,
    associationSha256: association.snapshot_sha256,
    targetId,
    targetSha256: target.snapshot_sha256,
    associationReceipt: { id: '21', entryHash: 'c'.repeat(64) },
  };
  const request = {
    ...JSON.parse(f.human.review.request_text),
    version: 2,
    expectedEstateId: estate,
    associationRef,
  };
  const snapshot = {
    ...JSON.parse(f.human.review.snapshot_text),
    version: 2,
    estateId: estate,
    request,
    assetProvenance,
  };
  const human = {
    ...f.human,
    schema_version: 2,
    estate_id: estate,
    review: {
      ...f.human.review,
      request_codec: PUBLIC_CONTROL_REVIEW_REQUEST_CODEC_V2,
      snapshot_codec: PUBLIC_CONTROL_REVIEW_SNAPSHOT_CODEC_V2,
      request_text: canonicalJson(request),
      request_sha256: sha(canonicalJson(request)),
      snapshot_text: canonicalJson(snapshot),
      snapshot_sha256: sha(canonicalJson(snapshot)),
    },
  };
  const source = { ...f.source, schema_version: 3, human_control_review: human };
  return {
    ...f,
    human,
    source,
    input: {
      ...f.input,
      sourceText: JSON.stringify(source),
      sourceSha256: sha(JSON.stringify(source)),
    },
  };
}
