/** Disposable SQL-fixture emitter only; never opens a database connection. */
import { buildLibrarySeedForVersion } from '../../packages/control-library/src/library-versions';
import { publicControlCatalogueManifestText } from '../../packages/control-library/src/public-evidence-mapping-v2';
for (const version of ['0.1.1', '0.2.0']) {
  const seed = buildLibrarySeedForVersion(version);
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const manifest = publicControlCatalogueManifestText(seed.version);
  console.log(
    `insert into public.control_libraries(version,published_at,published_by,change_log,control_count) values(${literal(seed.version)},${literal(seed.publishedAt)},${literal(seed.publishedBy)},${literal(seed.changeLog)},${seed.controls.length});`,
  );
  console.log(
    `insert into public.controls select * from jsonb_populate_recordset(null::public.controls,${literal(JSON.stringify(seed.controls.map((row) => ({ ...row, created_at: '2026-10-19T00:00:00Z' }))))}::jsonb);`,
  );
  if (version === '0.2.0')
    console.log(
      `select public.publish_catalogue_manifest(${literal(seed.version)},${literal(manifest)});`,
    );
}
