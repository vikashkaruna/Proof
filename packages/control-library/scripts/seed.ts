#!/usr/bin/env tsx
/**
 * Seed the control library and sector packs into Supabase.
 *
 * Usage: pnpm seed:controls
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY env vars
 */

import { createClient } from '@supabase/supabase-js';
import {
  ALL_CONTROL_MAPPINGS,
  ALL_FRAMEWORK_CONTROLS,
  ALL_FRAMEWORKS,
  ALL_SECTOR_PACKS,
  buildLibrarySeed,
  validateLibrary,
  validateSectorPacks,
} from '../src/index';

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:55321';
const DEFAULT_LOCAL_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function main() {
  const url = process.env.SUPABASE_URL ?? DEFAULT_LOCAL_URL;
  const key = process.env.SUPABASE_SERVICE_KEY ?? DEFAULT_LOCAL_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
    process.exit(1);
  }

  const validation = validateLibrary();
  if (!validation.ok) {
    console.error('Library validation failed:', validation.errors);
    process.exit(1);
  }

  const sectorPackErrors = validateSectorPacks();
  if (sectorPackErrors.length > 0) {
    console.error('Sector pack validation failed:', sectorPackErrors);
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
  });
  const seed = buildLibrarySeed();

  // Check if this version is already seeded (controls are immutable)
  const { data: existingLib } = await supabase
    .from('control_libraries')
    .select('version, control_count')
    .eq('version', seed.version)
    .maybeSingle();

  let controlsAlreadySeeded = false;
  if (existingLib) {
    const { count } = await supabase
      .from('controls')
      .select('*', { count: 'exact', head: true })
      .eq('library_version', seed.version);

    if (count && count >= seed.controls.length) {
      console.log(
        `✓ Control library v${seed.version} is already seeded (${count} controls present; controls are immutable).`,
      );
      controlsAlreadySeeded = true;
    }
  }

  if (!controlsAlreadySeeded) {
    // Insert the library version row if not present
    const { error: libErr } = await supabase.from('control_libraries').upsert(
      {
        version: seed.version,
        published_at: seed.publishedAt,
        published_by: seed.publishedBy,
        change_log: seed.changeLog,
        control_count: seed.controls.length,
      },
      { onConflict: 'version', ignoreDuplicates: true },
    );
    if (libErr) {
      console.error('Library upsert failed:', libErr);
      process.exit(1);
    }

    // Bulk insert the controls with ignoreDuplicates so existing rows aren't updated (triggering immutability)
    const { error: ctrlErr } = await supabase
      .from('controls')
      .upsert(seed.controls, { onConflict: 'id,library_version', ignoreDuplicates: true });
    if (ctrlErr) {
      console.error('Controls insert failed:', ctrlErr);
      process.exit(1);
    }

    console.log(`✓ Seeded ${seed.controls.length} controls (library v${seed.version})`);
  }

  // Seed sector packs, frameworks, and mappings if publisher user exists
  const { data: publisher } = await supabase
    .from('users')
    .select('id')
    .eq('email', 'founder@axiomminds.ai')
    .maybeSingle();

  if (!publisher?.id) {
    console.log(
      'ℹ Sector packs require publisher user (run pnpm seed:users first if not yet seeded).',
    );
    return;
  }

  const publisherId = publisher.id;

  // 1. Publish frameworks and framework controls
  let frameworksPublished = 0;
  for (const framework of ALL_FRAMEWORKS) {
    const frameworkControls = ALL_FRAMEWORK_CONTROLS.filter(
      (fc) => fc.frameworkCode === framework.code,
    ).map((fc) => ({ ref: fc.ref, heading: fc.heading }));

    const { data: res } = await supabase.rpc('publish_regulatory_framework', {
      p_code: framework.code,
      p_regulator: framework.regulator,
      p_title: framework.title,
      p_description: framework.description,
      p_source_url: framework.sourceUrl,
      p_verified_on: framework.verifiedOn,
      p_verified_by: framework.verifiedBy,
      p_published_by: publisherId,
      p_controls: frameworkControls,
    });
    if (res && !res.error) frameworksPublished++;
  }

  // 2. Publish control mappings
  let mappingsRecorded = 0;
  for (const mapping of ALL_CONTROL_MAPPINGS) {
    const { data: res } = await supabase.rpc('record_control_mapping', {
      p_framework_code: mapping.frameworkCode,
      p_framework_ref: mapping.ref,
      p_control_id: mapping.controlId,
      p_library_version: seed.version,
      p_strength: mapping.mappingStrength,
      p_provenance: mapping.provenance,
      p_note: mapping.note,
      p_recorded_by: publisherId,
    });
    if (res && !res.error) mappingsRecorded++;
  }

  // 3. Publish sector packs
  let packsPublished = 0;
  for (const pack of ALL_SECTOR_PACKS) {
    const { data: res } = await supabase.rpc('publish_sector_pack', {
      p_code: pack.code,
      p_name: pack.name,
      p_sector: pack.sector,
      p_description: pack.description,
      p_library_version: seed.version,
      p_control_ids: pack.controlIds,
      p_framework_codes: pack.frameworkCodes,
      p_evidence_requirements: pack.evidenceRequirements,
      p_remediation_patterns: pack.remediationPatterns.map((p) => ({ pattern: p })),
      p_content_sha256: null,
      p_published_by: publisherId,
    });
    if (res && !res.error) packsPublished++;
  }

  console.log(
    `✓ Sector packs synced: ${packsPublished} new packs (out of ${ALL_SECTOR_PACKS.length}), ` +
      `${frameworksPublished} new frameworks (${ALL_FRAMEWORKS.length} total), ` +
      `${mappingsRecorded} new mappings (${ALL_CONTROL_MAPPINGS.length} total).`,
  );
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
