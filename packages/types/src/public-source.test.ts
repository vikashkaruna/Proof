import { describe, expect, it } from 'vitest';
import {
  createPublicSourceBindingSchema,
  publicSourcePreviewSchema,
  publicSourceProjectionSchema,
  recordedPublicSourceBindingSchema,
} from './public-source.js';

const binding = {
  tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  engagement_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  check_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  root_content_sha256: 'a'.repeat(64),
  projection_sha256: 'b'.repeat(64),
  projection_version: 1,
};
const root = { page: 'root', status: 'checked', content_sha256: 'a'.repeat(64) };
const projection = { version: 1, pages: [root] };
const preview = { runtime_binding: binding, projection };
const metadata = {
  version: 1,
  scope: 'static_html_form_descendants',
  sourceSha256: 'a'.repeat(64),
  observedFormCount: 0,
  formsTruncated: false,
  forms: [],
};

describe('retained public source contract', () => {
  it('preserves legacy unexamined, observed zero and unavailable as distinct facts', () => {
    const parsed = publicSourceProjectionSchema.parse({
      version: 1,
      pages: [
        root,
        { ...root, page: 'privacy', form_metadata: metadata },
        { page: 'contact', status: 'unavailable' },
      ],
    });
    expect(parsed.pages[0]!.form_metadata).toBeUndefined();
    expect(parsed.pages[1]!.form_metadata!.observedFormCount).toBe(0);
    expect(parsed.pages[2]).toEqual({ page: 'contact', status: 'unavailable' });
  });

  it('normalizes validated binding identities without changing hash domains', () => {
    const parsed = publicSourcePreviewSchema.parse({
      ...preview,
      runtime_binding: { ...binding, tenant_id: binding.tenant_id.toUpperCase() },
    });
    expect(parsed.runtime_binding).toEqual(binding);
    expect(parsed.projection).toEqual(projection);
  });

  it.each([
    { version: 2, pages: [root] },
    { version: 1, pages: [] },
    { version: 1, pages: [{ ...root, page: 'contact' }, root] },
    { version: 1, pages: [root, root] },
    { version: 1, pages: [{ page: 'root', status: 'unavailable' }] },
    { version: 1, pages: [{ page: 'root', status: 'checked' }] },
    {
      version: 1,
      pages: [root, { page: 'contact', status: 'unavailable', content_sha256: 'b'.repeat(64) }],
    },
    {
      version: 1,
      pages: [root, { page: 'contact', status: 'unavailable', form_metadata: metadata }],
    },
    {
      version: 1,
      pages: [{ ...root, form_metadata: { ...metadata, sourceSha256: 'c'.repeat(64) } }],
    },
    { version: 1, pages: [{ ...root, url: 'https://private.example.invalid' }] },
    { version: 1, pages: [{ ...root, form_metadata: { ...metadata, rawValue: 'private' } }] },
    { version: 1, pages: [root], hosting_region: 'ap-south-1' },
  ])('rejects unsupported, invented or mismatched source attributes %#', (value) => {
    expect(publicSourceProjectionSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { ...preview, runtime_binding: { ...binding, root_content_sha256: 'c'.repeat(64) } },
    { ...preview, runtime_binding: { ...binding, projection_version: 2 } },
    { ...preview, binding_id: binding.check_id },
    { ...preview, creation_receipt: '1' },
    { ...preview, binding_id: binding.check_id, creation_receipt: '0' },
    { ...preview, source: 'caller-provided' },
  ])('refuses inconsistent authority/receipt bindings %#', (value) => {
    expect(publicSourcePreviewSchema.safeParse(value).success).toBe(false);
  });

  it('allows a retained prior binding without representing a new approval', () => {
    expect(
      publicSourcePreviewSchema.parse({
        ...preview,
        binding_id: binding.check_id,
        creation_receipt: '42',
      }),
    ).toMatchObject({ creation_receipt: '42' });
  });

  it.each([
    { created: true, replayed: true },
    { created: false, replayed: false },
    { created: 1, replayed: false },
    { created: true, replayed: 'false' },
  ])('refuses misleading creation or replay results %#', (flags) => {
    expect(
      recordedPublicSourceBindingSchema.safeParse({
        ...preview,
        binding_id: binding.check_id,
        creation_receipt: '42',
        ...flags,
      }).success,
    ).toBe(false);
  });

  it('accepts only IDs and expected database digests for creation', () => {
    const request = {
      checkId: binding.check_id,
      engagementId: binding.engagement_id,
      expectedRootSha256: binding.root_content_sha256,
      expectedProjectionSha256: binding.projection_sha256,
    };
    expect(createPublicSourceBindingSchema.parse(request)).toEqual(request);
    for (const extra of ['tenantId', 'actorId', 'projection', 'systems', 'field_hints']) {
      expect(createPublicSourceBindingSchema.safeParse({ ...request, [extra]: {} }).success).toBe(
        false,
      );
    }
  });
});
