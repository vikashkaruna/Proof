import { readFileSync } from 'node:fs';
import { parseDocument, visit, isAlias, isScalar } from 'yaml';
import { ConnectorManifestSchema, type ConnectorManifest } from '@axiom/types';

/** Reject aliases, duplicate keys, extra documents/tags and unbounded input. */
export function loadDescriptor(source: string): ConnectorManifest {
  if (Buffer.byteLength(source, 'utf8') > 65536) throw new Error('Descriptor exceeds 64 KiB');
  const doc = parseDocument(source, { schema: 'core', uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid descriptor YAML');
  visit(doc, (_key, node, path) => {
    if (path.length > 13) throw new Error('Descriptor nesting exceeds limit');
    if (
      isScalar(node) &&
      typeof node.value === 'number' &&
      !/^(0|[1-9][0-9]*)$/.test(node.source ?? '')
    )
      throw new Error('Descriptor numbers must be unsigned decimal integers');
    if (
      isAlias(node) ||
      (typeof node === 'object' &&
        node !== null &&
        (('tag' in node && node.tag) || ('anchor' in node && node.anchor)))
    )
      throw new Error('YAML aliases and tags are forbidden');
  });
  return ConnectorManifestSchema.parse(doc.toJS({ maxAliasCount: 0 }));
}
export function buildRegistry(sources: readonly string[]): ReadonlyMap<string, ConnectorManifest> {
  const result = new Map<string, ConnectorManifest>();
  const versions = new Set<string>();
  for (const source of sources) {
    const manifest = loadDescriptor(source);
    const version = `${manifest.target}/${manifest.version}/${manifest.targetBinding}`;
    if (result.has(manifest.id) || versions.has(version))
      throw new Error('Duplicate descriptor identity/version');
    versions.add(version);
    result.set(manifest.id, manifest);
  }
  return result;
}
// Reviewed catalogue only. Never load an operator-supplied URL or filesystem path.
export const connectorRegistry = buildRegistry([
  readFileSync(new URL('./descriptors/postgresql-production.yaml', import.meta.url), 'utf8'),
  readFileSync(new URL('./descriptors/postgresql-reference.yaml', import.meta.url), 'utf8'),
  // W4.6 MySQL: the second SQL engine of the read binding, same contract.
  readFileSync(new URL('./descriptors/mysql-production.yaml', import.meta.url), 'utf8'),
  // W4.7 REST pack: reference provenance, exercised against the reference
  // service only. Vendor-verified descriptors replace these per client tenant.
  ...['crm', 'hrms', 'data-warehouse', 'ticketing', 'code-repository'].map((target) =>
    readFileSync(new URL(`./descriptors/${target}-reference.yaml`, import.meta.url), 'utf8'),
  ),
]);
