import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CataloguePublicationError,
  publishCatalogue,
  type CatalogueResult,
  type CatalogueTransport,
} from './catalogue-publication';
import { buildLibrarySeed } from './seed';
import { ALL_CONTROL_MAPPINGS, ALL_FRAMEWORKS, ALL_SECTOR_PACKS } from './sector-packs';
// Controlled synthetic valid copy ONLY. Keeping one mapping per identity here
// exercises positive transport/readback paths; it is not clearance for the real
// catalogue, whose conflicting sector notes are tested separately below.
vi.mock('./sector-packs', async () => {
  const actual = await vi.importActual<typeof import('./sector-packs')>('./sector-packs');
  const seen = new Set<string>();
  return {
    ...actual,
    ALL_CONTROL_MAPPINGS: actual.ALL_CONTROL_MAPPINGS.filter((m) => {
      const key = JSON.stringify([m.frameworkCode, m.ref, m.controlId]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
});
const client = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client.current }));
type Row = Record<string, unknown>;
const PUBLISHER = '00000000-0000-4000-8000-000000000101';
const ok = (data: unknown): CatalogueResult => ({ data, error: null });
/** Synthetic persisted catalogue and transport, never a live publication or SQL proof. */
class CatalogueFake implements CatalogueTransport {
  tables = new Map<string, Row[]>();
  calls: string[] = [];
  serial = 1000;
  readFault: ((table: string, rows: Row[]) => CatalogueResult) | null = null;
  rpcFault: ((name: string, result: CatalogueResult) => CatalogueResult) | null = null;
  nextId() {
    return '00000000-0000-4000-8000-' + String(++this.serial).padStart(12, '0');
  }
  constructor() {
    const s = buildLibrarySeed();
    this.tables.set('control_libraries', [
      {
        version: s.version,
        published_at: s.publishedAt + 'T00:00:00+00:00',
        published_by: s.publishedBy,
        change_log: s.changeLog,
        control_count: s.controls.length,
        is_current: true,
      },
    ]);
    this.tables.set('controls', structuredClone(s.controls));
    this.tables.set('users', [{ id: PUBLISHER, email: 'founder@axiomminds.ai' }]);
    for (const t of ['frameworks', 'framework_controls', 'control_mappings', 'sector_packs'])
      this.tables.set(t, []);
  }
  async read(table: string, columns: string, filters: Readonly<Record<string, string | boolean>>) {
    this.calls.push('read:' + table);
    const rows = (this.tables.get(table) ?? [])
      .filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
      .map((r) => Object.fromEntries(columns.split(',').map((k) => [k, r[k]])));
    return this.readFault?.(table, rows) ?? ok(structuredClone(rows));
  }
  async insert(table: string, rows: unknown, conflict: string) {
    this.calls.push('insert:' + table);
    const values = Array.isArray(rows) ? rows : [rows];
    for (const v of values) {
      if (typeof v !== 'object' || v === null) throw new Error('bad synthetic row');
      const row = v as Row;
      const target = this.tables.get(table) ?? [];
      if (!target.some((r) => conflict.split(',').every((k) => r[k] === row[k])))
        target.push(
          table === 'control_libraries'
            ? {
                ...structuredClone(row),
                published_at: String(row.published_at) + 'T00:00:00+00:00',
              }
            : structuredClone(row),
        );
      this.tables.set(table, target);
    }
    return ok(null);
  }
  async activate(version: string, count: number) {
    this.calls.push('activate');
    const found = (this.tables.get('control_libraries') ?? []).filter(
      (r) => r.version === version && r.control_count === count,
    );
    for (const r of found) r.is_current = true;
    return ok(found.map((r) => ({ version: r.version })));
  }
  async rpc(name: string, args: Readonly<Record<string, unknown>>) {
    this.calls.push('rpc:' + name);
    const createdAt = '2026-10-13T00:00:00Z';
    let result: CatalogueResult;
    if (name === 'publish_regulatory_framework') {
      const table = this.tables.get('frameworks')!;
      const existing = table.find((r) => r.code === args.p_code);
      if (existing) result = ok({ error: 'already_published' });
      else {
        const id = this.nextId();
        table.push({
          id,
          code: args.p_code,
          jurisdiction: 'IN',
          regulator: args.p_regulator,
          title: args.p_title,
          description: args.p_description,
          source_url: args.p_source_url,
          verified_on: args.p_verified_on,
          verified_by: args.p_verified_by,
          published_by: args.p_published_by,
        });
        const controls = args.p_controls as Array<{ ref: string; heading: string }>;
        for (const c of controls)
          this.tables.get('framework_controls')!.push({
            id: this.nextId(),
            framework_id: id,
            ref: c.ref,
            heading: c.heading,
            text_sha256: null,
          });
        result = ok({
          framework: {
            id,
            code: args.p_code,
            regulator: args.p_regulator,
            title: args.p_title,
            controlsCount: controls.length,
            createdAt,
          },
        });
      }
    } else if (name === 'record_control_mapping') {
      const f = this.tables.get('frameworks')!.find((r) => r.code === args.p_framework_code)!;
      const fc = this.tables
        .get('framework_controls')!
        .find((r) => r.framework_id === f.id && r.ref === args.p_framework_ref)!;
      const table = this.tables.get('control_mappings')!;
      if (
        table.some(
          (r) =>
            r.control_id === args.p_control_id &&
            r.library_version === args.p_library_version &&
            r.framework_control_id === fc.id,
        )
      )
        result = ok({ error: 'already_mapped' });
      else {
        const id = this.nextId();
        table.push({
          id,
          control_id: args.p_control_id,
          library_version: args.p_library_version,
          framework_control_id: fc.id,
          mapping_strength: args.p_strength,
          provenance: args.p_provenance,
          note: args.p_note,
          recorded_by: args.p_recorded_by,
        });
        result = ok({
          mapping: {
            id,
            controlId: args.p_control_id,
            libraryVersion: args.p_library_version,
            frameworkControlId: fc.id,
            strength: args.p_strength,
            provenance: args.p_provenance,
            createdAt,
          },
        });
      }
    } else if (name === 'publish_sector_pack') {
      const table = this.tables.get('sector_packs')!;
      if (table.some((r) => r.code === args.p_code)) result = ok({ error: 'already_published' });
      else {
        const id = this.nextId();
        table.push({
          id,
          code: args.p_code,
          name: args.p_name,
          sector: args.p_sector,
          description: args.p_description,
          library_version: args.p_library_version,
          control_ids: args.p_control_ids,
          framework_codes: args.p_framework_codes,
          evidence_requirements: args.p_evidence_requirements,
          remediation_patterns: args.p_remediation_patterns,
          content_sha256: args.p_content_sha256,
          published_by: args.p_published_by,
        });
        result = ok({
          pack: {
            id,
            code: args.p_code,
            name: args.p_name,
            sector: args.p_sector,
            libraryVersion: args.p_library_version,
            controlsCount: (args.p_control_ids as string[]).length,
            frameworks: args.p_framework_codes,
            createdAt,
          },
        });
      }
    } else throw new Error('unknown synthetic RPC');
    return this.rpcFault?.(name, result) ?? result;
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});
describe('strict immutable catalogue publisher — synthetic transport proof', () => {
  it('verifies new publications then exact existing publications without row changes', async () => {
    const db = new CatalogueFake();
    const first = await publishCatalogue(db);
    expect(first).toMatchObject({
      partial: false,
      libraryVerified: true,
      frameworks: { created: ALL_FRAMEWORKS.length, existing: 0 },
      mappings: { created: ALL_CONTROL_MAPPINGS.length },
      packs: { created: ALL_SECTOR_PACKS.length },
    });
    const before = structuredClone([...db.tables]);
    const second = await publishCatalogue(db);
    expect(second.frameworks).toEqual({ created: 0, existing: ALL_FRAMEWORKS.length });
    expect(second.mappings.existing).toBe(ALL_CONTROL_MAPPINGS.length);
    expect(second.packs.existing).toBe(ALL_SECTOR_PACKS.length);
    expect([...db.tables]).toEqual(before);
  });
  it('preserves fresh bootstrap order and activates only after exact control readback', async () => {
    const db = new CatalogueFake();
    db.tables.set('control_libraries', []);
    db.tables.set('controls', []);
    await publishCatalogue(db);
    expect(db.calls.indexOf('insert:control_libraries')).toBeLessThan(
      db.calls.indexOf('insert:controls'),
    );
    expect(db.calls.indexOf('insert:controls')).toBeLessThan(db.calls.indexOf('activate'));
    expect(db.calls.indexOf('activate')).toBeLessThan(db.calls.indexOf('read:users'));
  });
  it('absent publisher is explicit partial after library verification with no overlay calls', async () => {
    const db = new CatalogueFake();
    db.tables.set('users', []);
    expect(await publishCatalogue(db)).toMatchObject({
      partial: true,
      libraryVerified: true,
      frameworks: { created: 0, existing: 0 },
    });
    expect(db.calls.some((c) => c.startsWith('rpc:'))).toBe(false);
  });
  for (const table of ['control_libraries', 'controls', 'users'])
    it('refuses ' + table + ' lookup errors rather than absence', async () => {
      const db = new CatalogueFake();
      db.readFault = (t, rows) =>
        t === table
          ? { data: rows, error: { message: 'sensitive synthetic exception' } }
          : ok(rows);
      await expect(publishCatalogue(db)).rejects.toBeInstanceOf(CataloguePublicationError);
      expect(db.calls.some((c) => c.startsWith('rpc:'))).toBe(false);
    });
  for (const body of [
    null,
    {},
    true,
    { error: 'invalid_request' },
    { error: 'already_published', extra: true },
    { framework: { id: PUBLISHER } },
  ])
    it('refuses malformed/refused RPC ' + JSON.stringify(body), async () => {
      const db = new CatalogueFake();
      db.rpcFault = () => ok(body);
      await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'framework_publish' });
      expect(db.calls.filter((c) => c.startsWith('rpc:'))).toHaveLength(1);
    });
  it('transport failure overrides even a success-shaped body, stops all later writes, and bounds diagnostics', async () => {
    const db = new CatalogueFake();
    db.rpcFault = (_n, r) => ({ ...r, error: { message: 'private-secret-value' } });
    let error: unknown;
    try {
      await publishCatalogue(db);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CataloguePublicationError);
    expect(String(error)).not.toContain('private-secret-value');
    expect(error).toMatchObject({
      phase: 'framework_publish',
      writeMayHaveCommitted: true,
      verified: { frameworks: { created: 0, existing: 0 } },
    });
    expect(db.calls.filter((c) => c.startsWith('rpc:'))).toHaveLength(1);
  });
  for (const field of ['code', 'id', 'controlsCount'])
    it('refuses wrong framework reply ' + field, async () => {
      const db = new CatalogueFake();
      db.rpcFault = (n, r) => {
        if (n !== 'publish_regulatory_framework') return r;
        const d = structuredClone(r.data) as { framework: Row };
        d.framework[field] = field === 'controlsCount' ? 999 : PUBLISHER;
        return ok(d);
      };
      await expect(publishCatalogue(db)).rejects.toBeInstanceOf(CataloguePublicationError);
      expect(db.calls.filter((c) => c.startsWith('rpc:'))).toHaveLength(1);
    });
  for (const mutation of ['id', 'title', 'scoring', 'duplicate', 'extra'])
    it(
      'equal-count immutable controls refuse ' + mutation + ' before activation/overlay',
      async () => {
        const db = new CatalogueFake();
        const rows = db.tables.get('controls')!;
        if (mutation === 'duplicate') rows[0] = structuredClone(rows[1]!);
        else if (mutation === 'extra')
          db.readFault = (t, data) =>
            ok(
              t === 'controls'
                ? data.map((row, i) => (i === 0 ? { ...row, unexpected: true } : row))
                : data,
            );
        else rows[0]![mutation] = mutation === 'scoring' ? { baseline: 0 } : 'changed';
        await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'controls_lookup' });
        expect(
          db.calls.some((c) => c === 'activate' || c.startsWith('rpc:') || c.startsWith('insert:')),
        ).toBe(false);
      },
    );
  it('refuses persisted library metadata drift', async () => {
    const db = new CatalogueFake();
    db.tables.get('control_libraries')![0]!.control_count = 999;
    await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'library_lookup' });
  });
  it('refuses replacing a different current library', async () => {
    const db = new CatalogueFake();
    db.tables
      .get('control_libraries')!
      .push({ ...db.tables.get('control_libraries')![0]!, version: 'other' });
    await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'current_lookup' });
    expect(db.calls).not.toContain('activate');
  });
  it('activation response alone cannot establish current publication', async () => {
    const db = new CatalogueFake();
    db.tables.get('control_libraries')![0]!.is_current = false;
    db.activate = async () => ok([{ version: '0.1.1' }]);
    await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'current_readback' });
  });
  for (const table of ['frameworks', 'framework_controls', 'control_mappings', 'sector_packs'])
    it('duplicate ' + table + ' requires exact immutable content', async () => {
      const db = new CatalogueFake();
      await publishCatalogue(db);
      const row = db.tables.get(table)![0]!;
      const key =
        table === 'frameworks'
          ? 'source_url'
          : table === 'framework_controls'
            ? 'heading'
            : table === 'control_mappings'
              ? 'note'
              : 'evidence_requirements';
      row[key] = key === 'evidence_requirements' ? [] : 'changed';
      await expect(publishCatalogue(db)).rejects.toBeInstanceOf(CataloguePublicationError);
    });
  for (const table of ['frameworks', 'framework_controls', 'control_mappings', 'sector_packs'])
    it(table + ' missing/readback outage never reports success', async () => {
      const db = new CatalogueFake();
      db.readFault = (t, rows) => ok(t === table ? [] : rows);
      await expect(publishCatalogue(db)).rejects.toBeInstanceOf(CataloguePublicationError);
    });
  it('preserves previously verified counts on later failure without claiming rollback', async () => {
    const db = new CatalogueFake();
    let n = 0;
    db.rpcFault = (_name, r) => (++n === 2 ? { data: r.data, error: { message: 'failure' } } : r);
    await expect(publishCatalogue(db)).rejects.toMatchObject({
      verified: { frameworks: { created: 1, existing: 0 } },
      writeMayHaveCommitted: true,
    });
    expect(db.tables.get('frameworks')).toHaveLength(2);
    expect(db.calls.filter((c) => c.startsWith('rpc:'))).toHaveLength(2);
  });
  it('rejects truncated control readback even after attempted missing-row insertion', async () => {
    const db = new CatalogueFake();
    db.readFault = (t, rows) => ok(t === 'controls' ? rows.slice(1) : rows);
    await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'controls_readback' });
  });
  it('equal-count duplicate framework refs refuse before mapping publication', async () => {
    const db = new CatalogueFake();
    db.readFault = (table, rows) =>
      ok(
        table === 'framework_controls' && rows.length > 1
          ? [rows[0], rows[0], ...rows.slice(2)]
          : rows,
      );
    await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'framework_readback' });
    expect(db.calls).not.toContain('rpc:record_control_mapping');
  });
});

describe('additional controlled transport refusal boundaries', () => {
  it('refuses a one-microsecond alteration of immutable publication time', async () => {
    const db = new CatalogueFake();
    db.tables.get('users')!.splice(0);
    db.tables.get('control_libraries')![0]!.published_at = '2026-09-20T00:00:00.000001Z';
    await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'library_lookup' });
    expect(
      db.calls.some((c) => c.startsWith('insert:') || c === 'activate' || c.startsWith('rpc:')),
    ).toBe(false);
  });

  it('refuses a one-nanosecond alteration without rounding away the token precision', async () => {
    const db = new CatalogueFake();
    db.tables.set('users', []);
    db.tables.get('control_libraries')![0]!.published_at = '2026-09-20T00:00:00.000000001Z';
    await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'library_lookup' });
  });
  it('accepts exact whole-second publication time represented in another timezone', async () => {
    const db = new CatalogueFake();
    db.tables.set('users', []);
    db.tables.get('control_libraries')![0]!.published_at = '2026-09-20T05:30:00.000000+05:30';
    expect(await publishCatalogue(db)).toMatchObject({ libraryVerified: true, partial: true });
  });

  for (const name of ['record_control_mapping', 'publish_sector_pack']) {
    for (const body of [null, {}, { error: 'publisher_not_found' }])
      it(name + ' malformed/refused body ' + JSON.stringify(body), async () => {
        const db = new CatalogueFake();
        db.rpcFault = (n, result) => (n === name ? ok(body) : result);
        await expect(publishCatalogue(db)).rejects.toBeInstanceOf(CataloguePublicationError);
        const calls = db.calls.filter((c) => c.startsWith('rpc:'));
        expect(calls.at(-1)).toBe('rpc:' + name);
        expect(calls.filter((c) => c === 'rpc:' + name)).toHaveLength(1);
      });
    it(name + ' transport error overrides success-shaped response', async () => {
      const db = new CatalogueFake();
      db.rpcFault = (n, result) =>
        n === name ? { ...result, error: { message: 'sensitive transport' } } : result;
      await expect(publishCatalogue(db)).rejects.toBeInstanceOf(CataloguePublicationError);
      expect(db.calls.filter((c) => c === 'rpc:' + name)).toHaveLength(1);
    });
  }
  for (const table of ['frameworks', 'framework_controls', 'control_mappings', 'sector_packs'])
    it(table + ' readback transport error is bounded refusal', async () => {
      const db = new CatalogueFake();
      db.readFault = (t, rows) =>
        t === table ? { data: rows, error: { message: 'private read failure' } } : ok(rows);
      await expect(publishCatalogue(db)).rejects.toBeInstanceOf(CataloguePublicationError);
    });
  it('thrown transport failure never leaks underlying content', async () => {
    const db = new CatalogueFake();
    db.rpc = async () => {
      throw new Error('private transport body');
    };
    await expect(publishCatalogue(db)).rejects.toThrow('Catalogue publication refused');
    await expect(publishCatalogue(db)).rejects.not.toThrow('private transport body');
  });
  it('refuses non-ISO publication timestamp even if Date.parse accepts it', async () => {
    const db = new CatalogueFake();
    db.tables.get('control_libraries')![0]!.published_at = '2026/09/20';
    await expect(publishCatalogue(db)).rejects.toMatchObject({ phase: 'library_lookup' });
  });
  it('duplicate mapping/pack returned IDs must bind actual retained row', async () => {
    for (const name of ['record_control_mapping', 'publish_sector_pack']) {
      const db = new CatalogueFake();
      db.rpcFault = (n, r) => {
        if (n !== name) return r;
        const data = structuredClone(r.data) as Record<string, Row>;
        data[name === 'record_control_mapping' ? 'mapping' : 'pack']!.id = PUBLISHER;
        return ok(data);
      };
      await expect(publishCatalogue(db)).rejects.toBeInstanceOf(CataloguePublicationError);
    }
  });
});

function mockSupabase(db: CatalogueFake) {
  return {
    rpc: (name: string, args: Readonly<Record<string, unknown>>) => db.rpc(name, args),
    from(table: string) {
      let columns = '*';
      const filters: Record<string, string | boolean> = {};
      let action: (() => Promise<CatalogueResult>) | null = null;
      const query = {
        select(value: string) {
          columns = value;
          return query;
        },
        eq(key: string, value: string | boolean) {
          filters[key] = value;
          return query;
        },
        limit() {
          return query;
        },
        upsert(rows: unknown, options: { onConflict: string }) {
          action = () => db.insert(table, rows, options.onConflict);
          return query;
        },
        update() {
          action = () => db.activate(String(filters.version), Number(filters.control_count));
          return query;
        },
        then(resolve: (value: CatalogueResult) => unknown, reject: (error: unknown) => unknown) {
          return (action ? action() : db.read(table, columns, filters)).then(resolve, reject);
        },
      };
      return query;
    },
  };
}
it('CLI actual adapter refuses transport failures; controlled source never claims sync', async () => {
  vi.resetModules();
  const db = new CatalogueFake();
  db.rpcFault = (_name, res) => ({ ...res, error: { message: 'sensitive transport string' } });
  client.current = mockSupabase(db);
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const path = new URL('../scripts/seed.ts', import.meta.url).href;
  await import(/* @vite-ignore */ path);
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(out.mock.calls.flat().join(' ')).not.toContain('verified');
  expect(err.mock.calls.flat().join(' ')).not.toContain('sensitive transport string');
  expect(db.calls.filter((c) => c.startsWith('rpc:'))).toHaveLength(1);
});
it('CLI partial bootstrap reports partial instead of full publication success', async () => {
  vi.resetModules();
  const db = new CatalogueFake();
  db.tables.set('users', []);
  client.current = mockSupabase(db);
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const path = new URL('../scripts/seed.ts', import.meta.url).href;
  await import(/* @vite-ignore */ path);
  await vi.waitFor(() => expect(out.mock.calls.flat().join(' ')).toContain('Partial bootstrap'));
  expect(process.exitCode).toBeUndefined();
  expect(db.calls.some((c) => c.startsWith('rpc:'))).toBe(false);
});
it('actual reviewed source ambiguity refuses all overlay writes while preserving base/absent-publisher bootstrap', async () => {
  const actual = await vi.importActual<typeof import('./sector-packs')>('./sector-packs');
  vi.doMock('./sector-packs', () => actual);
  vi.resetModules();
  const { publishCatalogue: actualPublish } = await import('./catalogue-publication');
  const db = new CatalogueFake();
  db.tables.set('controls', []);
  db.tables.set('control_libraries', []);
  await expect(actualPublish(db)).rejects.toMatchObject({
    phase: 'overlay_source',
    verified: { libraryVerified: true },
    writeMayHaveCommitted: true,
  });
  expect(db.calls.some((c) => c.startsWith('rpc:'))).toBe(false);
  expect(db.calls).toContain('activate');
  expect(db.tables.get('controls')).toHaveLength(buildLibrarySeed().controls.length);
  const partial = new CatalogueFake();
  partial.tables.set('users', []);
  expect(await actualPublish(partial)).toMatchObject({ partial: true, libraryVerified: true });
  expect(partial.calls.some((c) => c.startsWith('rpc:'))).toBe(false);
});

async function actualPrerequisites() {
  const actual = await vi.importActual<typeof import('./sector-packs')>('./sector-packs');
  vi.doMock('./sector-packs', () => actual);
  vi.resetModules();
  return (await import('./catalogue-publication')).bootstrapCatalogueReferences;
}
describe('explicit actual-source immutable reference prerequisites', () => {
  it('bootstraps all prerequisites despite ambiguous legacy mappings and verifies exact replay', async () => {
    const bootstrap = await actualPrerequisites();
    const db = new CatalogueFake();
    const first = await bootstrap(db);
    expect(first).toEqual({
      libraryVerified: true,
      frameworks: { created: ALL_FRAMEWORKS.length, existing: 0 },
      packs: { created: ALL_SECTOR_PACKS.length, existing: 0 },
      mappingContextsPublished: false,
      adoption: false,
    });
    expect(db.tables.get('control_mappings')).toEqual([]);
    expect(db.calls.filter((c) => c.startsWith('rpc:'))).toEqual([
      ...ALL_FRAMEWORKS.map(() => 'rpc:publish_regulatory_framework'),
      ...ALL_SECTOR_PACKS.map(() => 'rpc:publish_sector_pack'),
    ]);
    expect(await bootstrap(db)).toEqual({
      ...first,
      frameworks: { created: 0, existing: ALL_FRAMEWORKS.length },
      packs: { created: 0, existing: ALL_SECTOR_PACKS.length },
    });
  });
  it('refuses absent publisher without claiming prerequisite success', async () => {
    const bootstrap = await actualPrerequisites();
    const db = new CatalogueFake();
    db.tables.set('users', []);
    await expect(bootstrap(db)).rejects.toMatchObject({
      phase: 'publisher_lookup',
      verified: { libraryVerified: true },
    });
    expect(db.calls.some((c) => c.startsWith('rpc:'))).toBe(false);
  });
  for (const table of ['frameworks', 'framework_controls', 'sector_packs'])
    it(
      'refuses altered persisted ' + table + ' rather than replacing immutable content',
      async () => {
        const bootstrap = await actualPrerequisites();
        const db = new CatalogueFake();
        await bootstrap(db);
        const row = db.tables.get(table)![0]!;
        if (table === 'framework_controls') row.heading = 'Changed';
        else if (table === 'frameworks') row.source_url = 'https://changed.invalid';
        else row.control_ids = [];
        await expect(bootstrap(db)).rejects.toBeInstanceOf(Error);
        expect(db.tables.get('control_mappings')).toEqual([]);
      },
    );
  it('refuses missing framework controls before pack writes', async () => {
    const bootstrap = await actualPrerequisites();
    const db = new CatalogueFake();
    await bootstrap(db);
    db.tables.get('framework_controls')!.pop();
    db.calls = [];
    await expect(bootstrap(db)).rejects.toMatchObject({ phase: 'framework_readback' });
    expect(db.calls).not.toContain('rpc:publish_sector_pack');
  });
  it('retains ambiguous committed-write uncertainty and independently verifies recovery', async () => {
    const bootstrap = await actualPrerequisites();
    const db = new CatalogueFake();
    db.rpcFault = () => ({ data: null, error: { message: 'synthetic response loss' } });
    await expect(bootstrap(db)).rejects.toMatchObject({
      phase: 'framework_publish',
      writeMayHaveCommitted: true,
    });
    db.rpcFault = null;
    expect(await bootstrap(db)).toMatchObject({ frameworks: { existing: 1 }, adoption: false });
  });
  it('CLI explicit mode reports only prerequisites with no legacy overlay writes', async () => {
    await actualPrerequisites();
    const db = new CatalogueFake();
    client.current = mockSupabase(db);
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node',
      'seed.ts',
      '--bootstrap-reference-prerequisites',
    ]);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await import(/* @vite-ignore */ new URL('../scripts/seed.ts', import.meta.url).href);
    await vi.waitFor(() => expect(out).toHaveBeenCalled());
    expect(out.mock.calls[0]).toEqual([
      'Immutable reference prerequisites verified:',
      expect.objectContaining({ mappingContextsPublished: false, adoption: false }),
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(db.calls).not.toContain('rpc:record_control_mapping');
  });
});

it('CLI prerequisite mode refuses absent publisher instead of reporting ordinary partial success', async () => {
  await actualPrerequisites();
  const db = new CatalogueFake();
  db.tables.set('users', []);
  client.current = mockSupabase(db);
  vi.spyOn(process, 'argv', 'get').mockReturnValue([
    'node',
    'seed.ts',
    '--bootstrap-reference-prerequisites',
  ]);
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await import(/* @vite-ignore */ new URL('../scripts/seed.ts', import.meta.url).href);
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(out).not.toHaveBeenCalled();
  expect(db.calls.some((c) => c.startsWith('rpc:'))).toBe(false);
});

describe('reference prerequisites never bootstrap or activate the base library', () => {
  for (const missing of ['library', 'controls', 'current', 'publisher'])
    it('refuses missing ' + missing + ' with zero writes or activation', async () => {
      const bootstrap = await actualPrerequisites();
      const db = new CatalogueFake();
      if (missing === 'library') db.tables.set('control_libraries', []);
      if (missing === 'controls') db.tables.get('controls')!.pop();
      if (missing === 'current') db.tables.get('control_libraries')![0]!.is_current = false;
      if (missing === 'publisher') db.tables.set('users', []);
      await expect(bootstrap(db)).rejects.toBeInstanceOf(Error);
      expect(
        db.calls.filter((c) => c.startsWith('insert:') || c.startsWith('rpc:') || c === 'activate'),
      ).toEqual([]);
    });
});

it('explicitly publishes candidate rows without activation, approval or sector adoption', async () => {
  const { publishCatalogueCandidate } = await import('./catalogue-publication');
  const db = new CatalogueFake();
  const result = await publishCatalogueCandidate(db, '0.2.0');
  expect(result.libraryVerified).toBe(true);
  expect(db.tables.get('controls')?.filter((row) => row.library_version === '0.2.0')).toHaveLength(
    46,
  );
  expect(db.tables.get('control_libraries')?.find((row) => row.is_current)?.version).toBe('0.1.1');
  expect(db.calls.some((call) => call.startsWith('rpc:') || call.includes('activate'))).toBe(false);
  expect(db.tables.get('approved_catalogue_versions')).toBeUndefined();
  await expect(publishCatalogueCandidate(db, '0.3.0')).rejects.toThrow('candidate_version_refused');
});
