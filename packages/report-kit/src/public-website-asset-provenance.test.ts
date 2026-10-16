import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@axiom/ledger';
import {
  encodePublicWebsiteAssetRequest,
  PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
  PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
} from '@axiom/types';
import {
  FrozenPublicWebsiteAssetProvenanceSchema,
  verifyFrozenPublicWebsiteAssetProvenance,
} from './public-website-asset-provenance';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
function retained(request: unknown, snapshot: unknown, actor: string, op: string, n: number) {
  const request_text = encodePublicWebsiteAssetRequest(request);
  const snapshot_text = canonicalJson(snapshot);
  return {
    actor_id: actor,
    operation_key: op,
    request_codec: PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
    request_text,
    request_sha256: sha(request_text),
    snapshot_codec: PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
    snapshot_text,
    snapshot_sha256: sha(snapshot_text),
    receipt: { id: String(n), entry_hash: String(n).repeat(64).slice(0, 64) },
  };
}
function fixture(capture = false) {
  const common = {
    version: 1,
    tenantId: id(1),
    ownershipVerified: false,
    connectorAccessGranted: false,
  };
  const target = retained(
    {
      version: 1,
      kind: 'register_target',
      operationKey: id(10),
      confirmed: true,
      estateId: id(2),
      systemId: id(3),
      expectedEstateVersion: 4,
      expectedSystemVersion: 5,
      url: 'https://public.org/',
    },
    {
      ...common,
      actorId: id(4),
      id: id(6),
      kind: 'target',
      estateId: id(2),
      systemId: id(3),
      estateVersion: 4,
      systemVersion: 5,
      targetVersion: 2,
      estateName: 'Declared estate',
      systemName: 'Declared system',
      url: 'https://public.org/',
    },
    id(4),
    id(10),
    1,
  );
  const association = retained(
    {
      version: 1,
      kind: capture ? 'capture' : 'associate_capture',
      operationKey: id(11),
      confirmed: true,
      targetId: id(6),
      expectedTargetSha256: target.snapshot_sha256,
      ...(capture
        ? {}
        : { checkId: id(8), expectedPayloadSha256: 'a'.repeat(64), expectedCaptureReceipt: '3' }),
    },
    {
      ...common,
      actorId: id(5),
      id: id(7),
      kind: 'association',
      targetId: id(6),
      targetSha256: target.snapshot_sha256,
      checkId: id(8),
      payloadSha256: 'a'.repeat(64),
      captureReceipt: { id: '3', entryHash: '3'.repeat(64) },
      requestedUrl: 'https://public.org/',
      finalUrl: 'https://www.public.org/',
      checkedAt: '2026-10-16T00:00:00.000000Z',
    },
    id(5),
    id(11),
    2,
  );
  return {
    frozen: {
      schema_version: 1,
      kind: 'public_website_asset_binding',
      tenant_id: id(1),
      estate_id: id(2),
      system_id: id(3),
      target,
      association,
      ownership_verified: false,
      connector_access_granted: false,
      review_required: true,
    },
    scope: {
      tenantId: id(1),
      estateId: id(2),
      checkId: id(8),
      payloadSha256: 'a'.repeat(64),
      captureReceipt: { id: '3', entry_hash: '3'.repeat(64) },
      associationRef: {
        associationId: id(7),
        associationSha256: association.snapshot_sha256,
        targetId: id(6),
        targetSha256: target.snapshot_sha256,
        associationReceipt: { id: '2', entryHash: '2'.repeat(64) },
      },
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function rewrite(
  f: Fixture,
  which: 'target' | 'association',
  part: 'request' | 'snapshot',
  change: (v: Record<string, unknown>) => void,
) {
  const b = f.frozen[which];
  const textKey = part === 'request' ? 'request_text' : 'snapshot_text';
  const hashKey = part === 'request' ? 'request_sha256' : 'snapshot_sha256';
  const value = JSON.parse(b[textKey]) as Record<string, unknown>;
  change(value);
  b[textKey] = canonicalJson(value);
  b[hashKey] = sha(b[textKey]);
  if (part === 'snapshot') {
    if (which === 'target') f.scope.associationRef.targetSha256 = b[hashKey];
    else f.scope.associationRef.associationSha256 = b[hashKey];
  }
}
const verify = (f: Fixture) => verifyFrozenPublicWebsiteAssetProvenance(f.frozen, f.scope);

describe('frozen human-declared website asset provenance', () => {
  it.each([false, true])(
    'verifies capture=%s with distinct human creators and no ownership claim',
    (capture) => {
      const f = fixture(capture);
      const before = JSON.stringify(f);
      const appendix = verify(f);
      expect(appendix).toMatchObject({
        label: 'human-declared asset scope',
        estate: { id: id(2), name: 'Declared estate', version: 4 },
        system: { id: id(3), name: 'Declared system', version: 5 },
        target: { declared_by: id(4), url: 'https://public.org/', version: 2 },
        association: { declared_by: id(5), check_id: id(8), final_url: 'https://www.public.org/' },
        ownership_verified: false,
        connector_access_granted: false,
        review_required: true,
      });
      expect(appendix.qualification).toContain('does not verify website ownership');
      expect(JSON.stringify(f)).toBe(before);
    },
  );
  it.each(['ownership_verified', 'connector_access_granted', 'review_required'] as const)(
    'refuses changed qualification %s',
    (field) => {
      const f = fixture();
      expect(() =>
        verifyFrozenPublicWebsiteAssetProvenance(
          { ...f.frozen, [field]: field !== 'review_required' },
          f.scope,
        ),
      ).toThrow();
    },
  );
  it.each(['target', 'association'] as const)(
    'refuses well-formed forged request digest for %s',
    (which) => {
      const f = fixture();
      f.frozen[which].request_sha256 = 'f'.repeat(64);
      expect(() => verify(f)).toThrow();
    },
  );
  it('refuses caller labels and outer system overrides', () => {
    const f = fixture();
    expect(() =>
      verifyFrozenPublicWebsiteAssetProvenance(f.frozen, { ...f.scope, systemName: 'Override' }),
    ).toThrow();
    expect(() =>
      verifyFrozenPublicWebsiteAssetProvenance({ ...f.frozen, system_id: id(99) }, f.scope),
    ).toThrow();
  });
  it('does not silently treat missing/legacy provenance as bound', () => {
    const f = fixture();
    for (const value of [undefined, null, {}, { ...f.frozen, schema_version: 0 }])
      expect(() => verifyFrozenPublicWebsiteAssetProvenance(value, f.scope)).toThrow();
  });
  it('rejects bundle swaps and missing receipts', () => {
    const f = fixture();
    expect(() =>
      verifyFrozenPublicWebsiteAssetProvenance(
        { ...f.frozen, target: f.frozen.association, association: f.frozen.target },
        f.scope,
      ),
    ).toThrow();
    expect(() =>
      verifyFrozenPublicWebsiteAssetProvenance(
        { ...f.frozen, target: { ...f.frozen.target, receipt: undefined } },
        f.scope,
      ),
    ).toThrow();
  });
  it.each(['request', 'snapshot'] as const)('checks exact %s bytes and codec', (part) => {
    const f = fixture();
    const b = f.frozen.target;
    const key = part === 'request' ? 'request_text' : 'snapshot_text';
    b[key] += ' ';
    expect(() => verify(f)).toThrow();
    b[part === 'request' ? 'request_sha256' : 'snapshot_sha256'] = sha(b[key]);
    expect(() => verify(f)).toThrow();
    const clean = fixture();
    expect(() =>
      verifyFrozenPublicWebsiteAssetProvenance(
        { ...clean.frozen, target: { ...clean.frozen.target, [`${part}_codec`]: 'unrecognized' } },
        clean.scope,
      ),
    ).toThrow();
  });
  it.each(['request', 'snapshot'] as const)(
    'refuses duplicate keys in %s even with a refreshed digest',
    (part) => {
      const f = fixture();
      const b = f.frozen.target;
      const key = part === 'request' ? 'request_text' : 'snapshot_text';
      b[key] = b[key].replace('{', '{"version":1,');
      b[part === 'request' ? 'request_sha256' : 'snapshot_sha256'] = sha(b[key]);
      expect(() => verify(f)).toThrow();
    },
  );
  it.each(['tenantId', 'estateId', 'checkId', 'payloadSha256'] as const)(
    'rejects changed context %s',
    (field) => {
      const f = fixture();
      f.scope[field] = field === 'payloadSha256' ? 'b'.repeat(64) : id(99);
      expect(() => verify(f)).toThrow();
    },
  );
  it.each(['associationId', 'associationSha256', 'targetId', 'targetSha256'] as const)(
    'rejects changed association reference %s',
    (field) => {
      const f = fixture();
      f.scope.associationRef[field] = field.endsWith('Sha256') ? 'b'.repeat(64) : id(99);
      expect(() => verify(f)).toThrow();
    },
  );
  it.each(['id', 'entryHash'] as const)('binds association receipt %s', (field) => {
    const f = fixture();
    f.scope.associationRef.associationReceipt[field] = field === 'id' ? '99' : 'b'.repeat(64);
    expect(() => verify(f)).toThrow();
  });
  it.each(['id', 'entry_hash'] as const)('binds capture receipt %s', (field) => {
    const f = fixture();
    f.scope.captureReceipt[field] = field === 'id' ? '99' : 'b'.repeat(64);
    expect(() => verify(f)).toThrow();
  });
  it.each(['estateId', 'systemId', 'expectedEstateVersion', 'expectedSystemVersion', 'url'])(
    'binds target registration %s to snapshot',
    (field) => {
      const f = fixture();
      rewrite(f, 'target', 'request', (v) => {
        v[field] = field.startsWith('expected')
          ? 9
          : field === 'url'
            ? 'https://other.org/'
            : id(99);
      });
      expect(() => verify(f)).toThrow();
    },
  );
  it.each([
    'checkId',
    'expectedPayloadSha256',
    'expectedCaptureReceipt',
    'targetId',
    'expectedTargetSha256',
  ])('binds existing capture request %s', (field) => {
    const f = fixture();
    rewrite(f, 'association', 'request', (v) => {
      v[field] = field.endsWith('Sha256')
        ? 'b'.repeat(64)
        : field === 'expectedCaptureReceipt'
          ? '99'
          : id(99);
    });
    expect(() => verify(f)).toThrow();
  });
  it.each([
    'requestedUrl',
    'targetId',
    'targetSha256',
    'checkId',
    'payloadSha256',
    'actorId',
    'tenantId',
  ])('rejects self-hashed but contradictory association %s', (field) => {
    const f = fixture();
    rewrite(f, 'association', 'snapshot', (v) => {
      v[field] = field.endsWith('Sha256')
        ? 'b'.repeat(64)
        : field === 'requestedUrl'
          ? 'https://other.org/'
          : id(99);
    });
    expect(() => verify(f)).toThrow();
  });
  it('binds bundle actor and operation, with no requirement that creators are the reviewer', () => {
    for (const field of ['actor_id', 'operation_key'] as const) {
      const f = fixture();
      f.frozen.target[field] = id(99);
      expect(() => verify(f)).toThrow();
    }
  });
  it('refuses withdrawal records as positive retained association', () => {
    const f = fixture();
    f.frozen.association.request_text = encodePublicWebsiteAssetRequest({
      version: 1,
      kind: 'withdraw',
      operationKey: id(11),
      confirmed: true,
      subjectType: 'target',
      subjectId: id(6),
      expectedSubjectSha256: f.frozen.target.snapshot_sha256,
      reason: 'Replacement',
    });
    f.frozen.association.request_sha256 = sha(f.frozen.association.request_text);
    expect(() => verify(f)).toThrow();
  });
  it('enforces byte limits, strict fields, digest shape and bigint receipt range without echoing data', () => {
    const f = fixture();
    const changed = {
      ...f.frozen,
      target: { ...f.frozen.target, request_text: '😀'.repeat(5000) },
    };
    expect(FrozenPublicWebsiteAssetProvenanceSchema.safeParse(changed).success).toBe(false);
    for (const patch of [
      { request_sha256: 'not-a-digest' },
      { secret: 'hostile-input-marker' },
      { receipt: { id: '9223372036854775808', entry_hash: 'a'.repeat(64) } },
    ]) {
      expect(() =>
        verifyFrozenPublicWebsiteAssetProvenance(
          { ...f.frozen, target: { ...f.frozen.target, ...patch } },
          f.scope,
        ),
      ).toThrow('public_website_asset_provenance_refused');
    }
    expect(() =>
      verifyFrozenPublicWebsiteAssetProvenance(
        { ...f.frozen, secret: 'hostile-input-marker' },
        f.scope,
      ),
    ).toThrow(/^public_website_asset_provenance_refused$/);
  });
});
