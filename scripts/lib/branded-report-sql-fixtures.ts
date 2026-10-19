/** Generate synthetic TS→SQL version7 parity vectors; no database or human authority. */
import { writeFileSync } from 'node:fs';
import { assetReportFixture } from '../../packages/report-kit/src/public-control-report-v4.test-helper.js';
import {
  encodeCoverageFirstSource,
  coverageFirstHash as hash,
} from '../../packages/report-kit/src/coverage-first-source.js';
import { sourcePacket } from '../../packages/report-kit/src/board-v2.fixture.js';
import { encodeQuestionnaireEvidenceSource } from '../../packages/report-kit/src/questionnaire-evidence-report.js';
import {
  encodeBrandedSource,
  buildBrandedReport,
  BRANDED_PRESENTATION_V1,
} from '../../packages/report-kit/src/branded-report.js';
const vectors = [];
for (const kind of ['board', 'auditor'] as const) {
  const f = assetReportFixture(kind);
  const coverage = encodeCoverageFirstSource(kind, f.input.sourceText, f.input.sourceSha256);
  const packet = sourcePacket();
  const controlsText = JSON.stringify(packet.controls),
    resultText = JSON.stringify(packet.result);
  const original = JSON.stringify({
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: kind === 'board' ? 'board_source' : 'statutory_source',
    ...(kind === 'auditor' ? { report_kind: kind } : {}),
    request_id: f.input.requestId,
    tenant_id: f.input.tenantId,
    engagement_id: f.input.engagementId,
    assessment_run_id: f.input.assessmentRunId,
    library_version: packet.result.library_version,
    controls_text: controlsText,
    controls_sha256: hash(controlsText),
    result_text: resultText,
    result_sha256: hash(resultText),
    completed_at: '2026-10-17T05:00:00+00:00',
    finalized_at: '2026-10-17T05:01:00+00:00',
    receipts: {
      started: { id: '10', entry_hash: 'a'.repeat(64) },
      completed: { id: '11', entry_hash: 'b'.repeat(64) },
      finalized: { id: '12', entry_hash: 'c'.repeat(64) },
    },
    limitations: ['Synthetic questionnaire; no independent evidence.'],
  });
  const questionnaire = encodeQuestionnaireEvidenceSource(kind, original, hash(original));
  for (const inner of [coverage, questionnaire]) {
    const source = encodeBrandedSource(kind, inner.text, inner.sha256, 'Synthetic Company');
    const input = { ...f.input, sourceText: source.text, sourceSha256: source.sha256 };
    vectors.push({ kind, input, document: buildBrandedReport(input) });
  }
}
const json = JSON.stringify(vectors),
  policy = JSON.stringify(BRANDED_PRESENTATION_V1);
if (json.includes('$brand177$') || policy.includes('$brand177$'))
  throw Error('Synthetic delimiter refused');
const sql = `-- Generated from production TS codecs by branded-report-sql-fixtures.ts; synthetic only.
begin;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$ begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m;end if;end $$;
select pg_temp.ok(controller_security.brand177_policy()=$brand177$${policy}$brand177$::jsonb,'exact TS/SQL asset and presentation policy');
do $$ declare vector jsonb;i jsonb;d jsonb;s jsonb;begin
 for vector in select value from jsonb_array_elements($brand177$${json}$brand177$::jsonb) loop
  i:=vector->'input';
  d:=controller_security.brand177_document(vector->>'kind',i->>'sourceText',i->>'sourceSha256',(i->>'tenantId')::uuid,(i->>'engagementId')::uuid,(i->>'assessmentRunId')::uuid,(i->>'requestId')::uuid,i->>'title',i->>'generatedAt');
  perform pg_temp.ok(d=vector->'document','TS/SQL full document7 parity');
  perform pg_temp.ok(d->'metrics'=jsonb_build_object('state','withheld','compliance_conclusion','not_determined'),'branding never unlocks estimates');
  s:=jsonb_set((i->>'sourceText')::jsonb,'{presentation,revision}','"forged"');
  begin
   perform controller_security.brand177_inner(vector->>'kind',s::text,encode(sha256(convert_to(s::text,'UTF8')),'hex'));
   raise exception 'forged presentation accepted';
  exception when sqlstate '22023' then null;end;
 end loop;
end $$;
rollback;
`;
writeFileSync('tests/database/branded-report-parity.test.sql', sql);
console.log('Generated four synthetic branded parity vectors; no SQL executed.');
