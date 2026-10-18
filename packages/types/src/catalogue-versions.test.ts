import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPROVED_LIBRARY_VERSIONS, ApprovedLibraryVersionSchema } from './catalogue-versions';

const migrations = new URL('../../../infra/supabase/migrations/', import.meta.url);

describe('approved catalogue versions', () => {
  it('match the versions the migrations approve in public.approved_catalogue_versions', () => {
    const approved = readdirSync(migrations)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) => {
        const sql = readFileSync(new URL(f, migrations), 'utf8');
        return [
          ...sql.matchAll(
            /insert into public\.approved_catalogue_versions\s*\([^)]*\)\s*values\s*\('([0-9]+\.[0-9]+\.[0-9]+)'/gi,
          ),
        ].map((m) => m[1]);
      });
    expect(approved.sort()).toEqual([...APPROVED_LIBRARY_VERSIONS].sort());
  });

  it('refuses any version not approved, including 0.2.0', () => {
    expect(ApprovedLibraryVersionSchema.parse('0.1.1')).toBe('0.1.1');
    for (const v of ['0.2.0', '0.1.0', '', '0.1.1 ']) {
      expect(ApprovedLibraryVersionSchema.safeParse(v).success).toBe(false);
    }
  });
});
