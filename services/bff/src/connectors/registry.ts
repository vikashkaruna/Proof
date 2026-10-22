import { readdirSync, readFileSync } from 'node:fs';
import { parseDocument, visit, isAlias, isScalar } from 'yaml';
import { ConnectorManifestSchema, type ConnectorManifest } from '@axiom/types';
import { pluginFor } from './framework/plugins.js';

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
/** Every reviewed descriptor file shipped beside this module, in name order.
 * The directory is part of the reviewed build (copied by
 * scripts/copy-connector-descriptors.mjs); never an operator-supplied path. */
export function reviewedDescriptorSources(
  directory: URL = new URL('./descriptors/', import.meta.url),
): string[] {
  return readdirSync(directory)
    .filter((name) => /^[a-z0-9]+(-[a-z0-9]+)*\.yaml$/.test(name))
    .sort()
    .map((name) => readFileSync(new URL(name, directory), 'utf8'));
}

/** A descriptor is admitted only when a connector plug-in can run it, so a
 * catalogue entry is always executable by the shared gate. */
export function buildPluggableRegistry(
  sources: readonly string[],
): ReadonlyMap<string, ConnectorManifest> {
  const registry = buildRegistry(sources);
  for (const manifest of registry.values())
    if (!pluginFor(manifest)) throw new Error('Descriptor has no connector plug-in');
  return registry;
}

// Reviewed catalogue only. Never load an operator-supplied URL or filesystem path.
// Adding a platform: a plug-in in framework/plugins.ts plus a YAML file here.
export const connectorRegistry = buildPluggableRegistry(reviewedDescriptorSources());
