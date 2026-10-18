import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_LIBRARY_VERSIONS,
  ApprovedLibraryVersionSchema,
  CatalogueVersionApprovalRequestSchema,
} from './catalogue-versions';
const migrations = new URL('../../../infra/supabase/migrations/', import.meta.url);
describe('catalogue version codec and live approval boundary', () => {
  it('parses supported candidates without claiming migration approval', () => {
    expect(APPROVED_LIBRARY_VERSIONS).toEqual(['0.1.1', '0.2.0']);
    const automaticallyApproved = readdirSync(migrations)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) =>
        [
          ...readFileSync(new URL(f, migrations), 'utf8').matchAll(
            /insert into public\.approved_catalogue_versions\s*\([^)]*\)\s*values\s*\('([0-9]+\.[0-9]+\.[0-9]+)'/gi,
          ),
        ].map((m) => m[1]),
      );
    expect(automaticallyApproved).toEqual(['0.1.1']);
  });
  it('refuses unsupported versions and extra approval authority fields', () => {
    for (const version of ['0.1.0', '0.3.0', '', '0.2.0 '])
      expect(ApprovedLibraryVersionSchema.safeParse(version).success).toBe(false);
    const request = {
      version: 1,
      operationKey: '11111111-1111-4111-8111-111111111111',
      libraryVersion: '0.2.0',
      rowsHash: 'a'.repeat(64),
      questionnaireDigest: 'b'.repeat(64),
      manifestSha256: 'c'.repeat(64),
      mappingVersion: 'public-evidence-1',
      reason: 'Reviewed source',
      confirmed: true,
    };
    expect(CatalogueVersionApprovalRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CatalogueVersionApprovalRequestSchema.safeParse({ ...request, approved: true }).success,
    ).toBe(false);
    expect(
      CatalogueVersionApprovalRequestSchema.safeParse({ ...request, confirmed: false }).success,
    ).toBe(false);
  });
});
