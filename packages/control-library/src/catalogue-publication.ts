import { z } from 'zod';
import { buildLibrarySeed } from './seed';
import { buildLibrarySeedForVersion } from './library-versions';
import {
  ALL_CONTROL_MAPPINGS,
  ALL_FRAMEWORK_CONTROLS,
  ALL_FRAMEWORKS,
  ALL_SECTOR_PACKS,
  validateSectorPacks,
} from './sector-packs';
import { validateLibrary } from './controls';

export interface CatalogueResult {
  data: unknown;
  error: unknown;
}
export interface CatalogueTransport {
  read(
    table: string,
    columns: string,
    filters: Readonly<Record<string, string | boolean>>,
  ): Promise<CatalogueResult>;
  insert(table: string, rows: unknown, conflict: string): Promise<CatalogueResult>;
  activate(version: string, count: number): Promise<CatalogueResult>;
  rpc(name: string, args: Readonly<Record<string, unknown>>): Promise<CatalogueResult>;
}
export interface PublicationSummary {
  libraryVerified: boolean;
  partial: boolean;
  frameworks: { created: number; existing: number };
  mappings: { created: number; existing: number };
  packs: { created: number; existing: number };
}
export class CataloguePublicationError extends Error {
  constructor(
    readonly phase: string,
    readonly verified: PublicationSummary,
    readonly writeMayHaveCommitted: boolean,
  ) {
    super(
      `Catalogue publication refused (${phase}); earlier writes may remain. Verified counts are incomplete.`,
    );
    this.name = 'CataloguePublicationError';
  }
}
const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  .refine((v) => v !== '00000000-0000-0000-0000-000000000000');
const instant = z.iso.datetime({ offset: true });
const rowsSchema = z.array(z.record(z.string(), z.json())).max(1000);
const frameworkReply = z.strictObject({
  framework: z.strictObject({
    id: uuid,
    code: z.string(),
    regulator: z.string(),
    title: z.string(),
    controlsCount: z.number().int().positive(),
    createdAt: instant,
  }),
});
const mappingReply = z.strictObject({
  mapping: z.strictObject({
    id: uuid,
    controlId: z.string(),
    libraryVersion: z.string(),
    frameworkControlId: uuid,
    strength: z.string(),
    provenance: z.string(),
    createdAt: instant,
  }),
});
const packReply = z.strictObject({
  pack: z.strictObject({
    id: uuid,
    code: z.string(),
    name: z.string(),
    sector: z.string(),
    libraryVersion: z.string(),
    controlsCount: z.number().int().positive(),
    frameworks: z.array(z.string()),
    createdAt: instant,
  }),
});
// Preserve fractional precision independently of JavaScript's millisecond clock.
// Validation remains ISO-only; the explicit bound prevents unbounded BigInt work.
function exactInstantNanos(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) return null;
  const whole = Date.parse(match[1]! + match[3]!);
  if (!Number.isFinite(whole)) return null;
  return BigInt(whole) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  return JSON.stringify(v) ?? 'undefined';
}
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function fields(v: Readonly<Record<string, unknown>>): string {
  return Object.keys(v).join(',');
}

export interface ReferencePrerequisiteSummary {
  libraryVerified: boolean;
  frameworks: PublicationSummary['frameworks'];
  packs: PublicationSummary['packs'];
  mappingContextsPublished: false;
  adoption: false;
}

/** Explicit immutable prerequisites only; neither legacy mappings nor adoption are written. */
export async function bootstrapCatalogueReferences(
  transport: CatalogueTransport,
): Promise<ReferencePrerequisiteSummary> {
  const verified = await publishCatalogueMode(transport, true);
  return {
    libraryVerified: verified.libraryVerified,
    frameworks: verified.frameworks,
    packs: verified.packs,
    mappingContextsPublished: false,
    adoption: false,
  };
}

/** Catalogue source is the reviewed package; persisted rows never supply replacement seed content. */
export async function publishCatalogue(transport: CatalogueTransport): Promise<PublicationSummary> {
  return publishCatalogueMode(transport, false);
}

async function publishCatalogueMode(
  transport: CatalogueTransport,
  prerequisitesOnly: boolean,
  candidateVersion?: string,
): Promise<PublicationSummary> {
  const summary: PublicationSummary = {
    libraryVerified: false,
    partial: false,
    frameworks: { created: 0, existing: 0 },
    mappings: { created: 0, existing: 0 },
    packs: { created: 0, existing: 0 },
  };
  let phase = 'validation',
    writeMayHaveCommitted = false;
  const refuse = (): never => {
    throw new CataloguePublicationError(phase, structuredClone(summary), writeMayHaveCommitted);
  };
  const read = async (
    table: string,
    columns: string,
    filters: Readonly<Record<string, string | boolean>>,
  ) => {
    const result = await transport.read(table, columns, filters);
    const parsed = rowsSchema.safeParse(result.data);
    if (result.error !== null || !parsed.success) return refuse();
    return parsed.data;
  };
  const check = (actual: unknown, expected: unknown): void => {
    if (!same(actual, expected)) refuse();
  };
  const write = async (call: () => Promise<CatalogueResult>) => {
    writeMayHaveCommitted = true;
    const result = await call();
    if (result.error !== null) refuse();
    return result.data;
  };
  const duplicate = (value: unknown, code: string): boolean =>
    z.strictObject({ error: z.literal(code) }).safeParse(value).success;
  try {
    if (!validateLibrary().ok || validateSectorPacks().length) refuse();
    const seed = candidateVersion
      ? buildLibrarySeedForVersion(candidateVersion)
      : buildLibrarySeed();
    const library = {
      version: seed.version,
      published_at: seed.publishedAt,
      published_by: seed.publishedBy,
      change_log: seed.changeLog,
      control_count: seed.controls.length,
    };
    const libraryColumns = fields(library);
    const verifyLibrary = (row: Record<string, unknown>) => {
      const parsedTime = instant.safeParse(row.published_at);
      if (
        !parsedTime.success ||
        exactInstantNanos(parsedTime.data) === null ||
        exactInstantNanos(parsedTime.data) !== exactInstantNanos(seed.publishedAt + 'T00:00:00Z')
      )
        refuse();
      check({ ...row, published_at: seed.publishedAt }, library);
    };
    phase = 'library_lookup';
    const existing = await read('control_libraries', libraryColumns, { version: seed.version });
    if (existing.length > 1) refuse();
    if (existing[0]) verifyLibrary(existing[0]);
    const controlsColumns = fields(seed.controls[0]!);
    phase = 'controls_lookup';
    const existingControls = await read('controls', controlsColumns, {
      library_version: seed.version,
    });
    const expectedControls = new Map(seed.controls.map((v) => [v.id, v]));
    const seen = new Set<string>();
    for (const row of existingControls) {
      if (typeof row.id !== 'string' || seen.has(row.id) || !expectedControls.has(row.id))
        return refuse();
      seen.add(row.id);
      check(row, expectedControls.get(row.id));
    }
    if (prerequisitesOnly && (!existing.length || existingControls.length !== seed.controls.length))
      refuse();
    if (!existing.length) {
      phase = 'library_insert';
      await write(() => transport.insert('control_libraries', library, 'version'));
    }
    if (existingControls.length !== seed.controls.length) {
      phase = 'controls_insert';
      await write(() => transport.insert('controls', seed.controls, 'id,library_version'));
    }
    phase = 'library_readback';
    const savedLibrary = await read('control_libraries', libraryColumns, { version: seed.version });
    if (savedLibrary.length !== 1) refuse();
    verifyLibrary(savedLibrary[0]!);
    phase = 'controls_readback';
    const savedControls = await read('controls', controlsColumns, {
      library_version: seed.version,
    });
    if (savedControls.length !== seed.controls.length) refuse();
    check(
      [...savedControls].sort((a, b) => String(a.id).localeCompare(String(b.id))),
      [...seed.controls].sort((a, b) => a.id.localeCompare(b.id)),
    );
    if (candidateVersion) {
      // Explicit operator publication stops before activation or overlay adoption.
      summary.libraryVerified = true;
      return summary;
    }
    phase = 'current_lookup';
    const current = await read('control_libraries', 'version', { is_current: true });
    if (current.length > 1 || (current[0] && !same(current[0], { version: seed.version })))
      refuse();
    if (!current.length) {
      if (prerequisitesOnly) refuse();
      phase = 'current_activation';
      const activated = await write(() => transport.activate(seed.version, seed.controls.length));
      check(activated, [{ version: seed.version }]);
    }
    phase = 'current_readback';
    check(await read('control_libraries', 'version', { is_current: true }), [
      { version: seed.version },
    ]);
    summary.libraryVerified = true;
    phase = 'publisher_lookup';
    const publishers = await read('users', 'id', { email: 'founder@axiomminds.ai' });
    if (publishers.length > 1) refuse();
    if (!publishers.length) {
      if (prerequisitesOnly) refuse();
      summary.partial = true;
      return summary;
    }
    const publisher = z.strictObject({ id: uuid }).safeParse(publishers[0]);
    if (!publisher.success) return refuse();
    const publisherId = publisher.data.id;
    // Validate only the overlay input now: base-only bootstrap and absent-publisher
    // behaviour retain their existing order. Never resolve conflicting immutable
    // identities by silently choosing a sector's note.
    phase = 'overlay_source';
    const declaredMappings = new Map<string, unknown>();
    for (const mapping of prerequisitesOnly ? [] : ALL_CONTROL_MAPPINGS) {
      const key = JSON.stringify([
        mapping.frameworkCode,
        mapping.ref,
        mapping.controlId,
        seed.version,
      ]);
      const previous = declaredMappings.get(key);
      if (previous !== undefined && !same(previous, mapping)) return refuse();
      declaredMappings.set(key, mapping);
    }

    const frameworkIds = new Map<string, string>();
    const frameworkControlIds = new Map<string, string>();
    for (const f of ALL_FRAMEWORKS) {
      phase = 'framework_publish';
      const controls = ALL_FRAMEWORK_CONTROLS.filter((c) => c.frameworkCode === f.code).map(
        (c) => ({ ref: c.ref, heading: c.heading }),
      );
      const result = await write(() =>
        transport.rpc('publish_regulatory_framework', {
          p_code: f.code,
          p_regulator: f.regulator,
          p_title: f.title,
          p_description: f.description,
          p_source_url: f.sourceUrl,
          p_verified_on: f.verifiedOn,
          p_verified_by: f.verifiedBy,
          p_published_by: publisherId,
          p_controls: controls,
        }),
      );
      const exists = duplicate(result, 'already_published');
      const reply = frameworkReply.safeParse(result);
      if (
        !exists &&
        (!reply.success ||
          reply.data.framework.code !== f.code ||
          reply.data.framework.regulator !== f.regulator ||
          reply.data.framework.title !== f.title ||
          reply.data.framework.controlsCount !== controls.length)
      )
        refuse();
      phase = 'framework_readback';
      const expected = {
        code: f.code,
        jurisdiction: 'IN',
        regulator: f.regulator,
        title: f.title,
        description: f.description,
        source_url: f.sourceUrl,
        verified_on: f.verifiedOn,
        verified_by: f.verifiedBy,
        published_by: publisherId,
      };
      const saved = await read('frameworks', 'id,' + fields(expected), { code: f.code });
      if (saved.length !== 1) refuse();
      const { id, ...content } = saved[0]!;
      if (!uuid.safeParse(id).success) refuse();
      check(content, expected);
      if (reply.success && reply.data.framework.id !== id) refuse();
      const frameworkId = String(id);
      frameworkIds.set(f.code, frameworkId);
      const savedControls = await read(
        'framework_controls',
        'id,framework_id,ref,heading,text_sha256',
        { framework_id: frameworkId },
      );
      if (savedControls.length !== controls.length) refuse();
      const savedIds = new Set<string>();
      const refs = new Set<string>();
      for (const row of savedControls) {
        const { id: controlId, ...content } = row;
        if (
          !uuid.safeParse(controlId).success ||
          savedIds.has(String(controlId)) ||
          typeof row.ref !== 'string' ||
          refs.has(row.ref)
        )
          return refuse();
        const expectedControl = controls.find((c) => c.ref === row.ref);
        if (!expectedControl) refuse();
        check(content, { framework_id: frameworkId, ...expectedControl, text_sha256: null });
        refs.add(row.ref);
        savedIds.add(String(controlId));
        frameworkControlIds.set(f.code + '\u0000' + row.ref, String(controlId));
      }
      summary.frameworks[exists ? 'existing' : 'created']++;
    }
    for (const m of prerequisitesOnly ? [] : ALL_CONTROL_MAPPINGS) {
      phase = 'mapping_publish';
      const frameworkControlId = frameworkControlIds.get(m.frameworkCode + '\u0000' + m.ref);
      if (!frameworkControlId) return refuse();
      const result = await write(() =>
        transport.rpc('record_control_mapping', {
          p_framework_code: m.frameworkCode,
          p_framework_ref: m.ref,
          p_control_id: m.controlId,
          p_library_version: seed.version,
          p_strength: m.mappingStrength,
          p_provenance: m.provenance,
          p_note: m.note,
          p_recorded_by: publisherId,
        }),
      );
      const exists = duplicate(result, 'already_mapped');
      const reply = mappingReply.safeParse(result);
      if (
        !exists &&
        (!reply.success ||
          !same(
            {
              controlId: reply.data.mapping.controlId,
              libraryVersion: reply.data.mapping.libraryVersion,
              frameworkControlId: reply.data.mapping.frameworkControlId,
              strength: reply.data.mapping.strength,
              provenance: reply.data.mapping.provenance,
            },
            {
              controlId: m.controlId,
              libraryVersion: seed.version,
              frameworkControlId,
              strength: m.mappingStrength,
              provenance: m.provenance,
            },
          ))
      )
        refuse();
      phase = 'mapping_readback';
      const expected = {
        control_id: m.controlId,
        library_version: seed.version,
        framework_control_id: frameworkControlId,
        mapping_strength: m.mappingStrength,
        provenance: m.provenance,
        note: m.note,
        recorded_by: publisherId,
      };
      const saved = await read('control_mappings', 'id,' + fields(expected), {
        control_id: m.controlId,
        library_version: seed.version,
        framework_control_id: frameworkControlId,
      });
      if (saved.length !== 1) refuse();
      const { id, ...content } = saved[0]!;
      if (!uuid.safeParse(id).success || (reply.success && reply.data.mapping.id !== id)) refuse();
      check(content, expected);
      summary.mappings[exists ? 'existing' : 'created']++;
    }
    for (const p of ALL_SECTOR_PACKS) {
      phase = 'pack_publish';
      if (p.frameworkCodes.some((code) => !frameworkIds.has(code))) refuse();
      const expected = {
        code: p.code,
        name: p.name,
        sector: p.sector,
        description: p.description,
        library_version: seed.version,
        control_ids: p.controlIds,
        framework_codes: p.frameworkCodes,
        evidence_requirements: p.evidenceRequirements,
        remediation_patterns: p.remediationPatterns.map((pattern) => ({ pattern })),
        content_sha256: null,
        published_by: publisherId,
      };
      const result = await write(() =>
        transport.rpc('publish_sector_pack', {
          p_code: p.code,
          p_name: p.name,
          p_sector: p.sector,
          p_description: p.description,
          p_library_version: seed.version,
          p_control_ids: p.controlIds,
          p_framework_codes: p.frameworkCodes,
          p_evidence_requirements: p.evidenceRequirements,
          p_remediation_patterns: expected.remediation_patterns,
          p_content_sha256: null,
          p_published_by: publisherId,
        }),
      );
      const exists = duplicate(result, 'already_published');
      const reply = packReply.safeParse(result);
      if (
        !exists &&
        (!reply.success ||
          !same(
            {
              code: reply.data.pack.code,
              name: reply.data.pack.name,
              sector: reply.data.pack.sector,
              libraryVersion: reply.data.pack.libraryVersion,
              controlsCount: reply.data.pack.controlsCount,
              frameworks: reply.data.pack.frameworks,
            },
            {
              code: p.code,
              name: p.name,
              sector: p.sector,
              libraryVersion: seed.version,
              controlsCount: p.controlIds.length,
              frameworks: p.frameworkCodes,
            },
          ))
      )
        refuse();
      phase = 'pack_readback';
      const saved = await read('sector_packs', 'id,' + fields(expected), { code: p.code });
      if (saved.length !== 1) refuse();
      const { id, ...content } = saved[0]!;
      if (!uuid.safeParse(id).success || (reply.success && reply.data.pack.id !== id)) refuse();
      check(content, expected);
      summary.packs[exists ? 'existing' : 'created']++;
    }
    return summary;
  } catch (error: unknown) {
    if (error instanceof CataloguePublicationError) throw error;
    return refuse();
  }
}

/** Explicit reviewed candidate publication; never makes a library current or approved. */
export async function publishCatalogueCandidate(
  transport: CatalogueTransport,
  version: string,
): Promise<PublicationSummary> {
  if (version !== '0.2.0') throw new Error('candidate_version_refused');
  return publishCatalogueMode(transport, false, version);
}
