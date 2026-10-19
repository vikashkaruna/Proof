#!/usr/bin/env tsx
/** Seed immutable catalogue publications. Existing bootstrap order is preserved. */
import { z } from 'zod';
import { publicControlCatalogueManifestText } from '../src/public-evidence-mapping-v2';
import { createClient } from '@supabase/supabase-js';
import {
  CataloguePublicationError,
  publishCatalogue,
  publishCatalogueCandidate,
  bootstrapCatalogueReferences,
  type CatalogueTransport,
} from '../src/catalogue-publication';

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:55321';
const DEFAULT_LOCAL_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL ?? DEFAULT_LOCAL_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? DEFAULT_LOCAL_SERVICE_KEY;
  if (!url || !key) throw new Error('Catalogue configuration unavailable');
  const client = createClient(url, key, { auth: { persistSession: false } });
  const transport: CatalogueTransport = {
    async read(table, columns, filters) {
      let query = client.from(table).select(columns);
      for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
      const result = await query.limit(1001);
      return { data: result.data, error: result.error };
    },
    async insert(table, rows, conflict) {
      const payload = z
        .union([z.record(z.string(), z.json()), z.array(z.record(z.string(), z.json()))])
        .parse(rows);
      const result = await client
        .from(table)
        .upsert(payload, { onConflict: conflict, ignoreDuplicates: true });
      return { data: result.data, error: result.error };
    },
    async activate(version, count) {
      const result = await client
        .from('control_libraries')
        .update({ is_current: true })
        .eq('version', version)
        .eq('control_count', count)
        .select('version');
      return { data: result.data, error: result.error };
    },
    async rpc(name, args) {
      const result = await client.rpc(name, args);
      return { data: result.data, error: result.error };
    },
  };
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--publish-candidate' && args[1] === '0.2.0') {
    const verified = await publishCatalogueCandidate(transport, args[1]);
    const staged = await client.rpc('publish_catalogue_manifest', {
      p_library_version: args[1],
      p_manifest_text: publicControlCatalogueManifestText(args[1]),
    });
    if (staged.error) throw new Error('candidate_manifest_publication_refused');
    console.log('Candidate rows and manifest verified; founder approval still required:', verified);
    return;
  }
  if (args.length && (args.length !== 1 || args[0] !== '--bootstrap-reference-prerequisites'))
    throw new Error('Unknown catalogue bootstrap option');
  if (args[0] === '--bootstrap-reference-prerequisites') {
    const prerequisites = await bootstrapCatalogueReferences(transport);
    console.log('Immutable reference prerequisites verified:', prerequisites);
    return;
  }
  const verified = await publishCatalogue(transport);
  if (verified.partial) {
    console.log(
      'Control library verified. Partial bootstrap: sector publications skipped because the publisher user is absent; run seed:users before retrying.',
    );
    return;
  }
  console.log('Catalogue publication verified:', verified);
}
void main().catch((error: unknown) => {
  if (error instanceof CataloguePublicationError)
    console.error(error.message, {
      verified: error.verified,
      writeMayHaveCommitted: error.writeMayHaveCommitted,
    });
  else
    console.error(
      'Catalogue publication refused; no complete-publication evidence. Earlier writes may remain.',
    );
  process.exitCode = 1;
});
