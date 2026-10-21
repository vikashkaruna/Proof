/** Generate synthetic TS→SQL version8 parity vectors; no database or human authority. */
import { writeFileSync } from 'node:fs';
import { assetReportFixture } from '../../packages/report-kit/src/public-control-report-v4.test-helper.js';
import {
  encodeCoverageFirstSource,
  coverageFirstHash as hash,
} from '../../packages/report-kit/src/coverage-first-source.js';
import { sourcePacket } from '../../packages/report-kit/src/board-v2.fixture.js';
import { encodeQuestionnaireEvidenceSource } from '../../packages/report-kit/src/questionnaire-evidence-report.js';
import { encodeBrandedSource } from '../../packages/report-kit/src/branded-report.js';
import { canonicalJson } from '../../packages/ledger/src/index.js';
import { PUBLIC_COVERAGE_PAGES } from '../../packages/types/src/index.js';
import { ids } from '../../packages/report-kit/src/public-control-provenance.test-helper.js';
import { buildClarifiedReport } from '../../packages/report-kit/src/clarified-report.js';
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
    const branded = encodeBrandedSource(kind, inner.text, inner.sha256, 'Synthetic Company');
    const text = canonicalJson({
      schema_version: 8,
      kind: 'clarified_report_source',
      serialization: 'axiom-clarified-report-source-json-1',
      report_kind: kind,
      retained_source: branded,
      owner_clarification: null,
    });
    const input = { ...f.input, sourceText: text, sourceSha256: hash(text) };
    const publicSource = inner === coverage;
    vectors.push({ kind, input, document: publicSource ? null : buildClarifiedReport(input) });
    if (publicSource) {
      const payload = JSON.parse(f.human.capture.payload_text);
      const snapshot = {
        version: 1,
        disposition: 'owner_declarations_unverified',
        tenantId: ids.tenant,
        actorId: ids.actor,
        revisionId: ids.report,
        previousRevisionId: null,
        recordedAt: '2026-10-21T00:00:00Z',
        request: {
          version: 1,
          operationKey: ids.report,
          engagementId: ids.engagement,
          checkId: ids.check,
          payloadSha256: f.human.capture.payload_sha256,
          expectedPreviousRevisionId: null,
          clarifications: PUBLIC_COVERAGE_PAGES.map((page) => {
            const saved = payload.pages.find((p: { page: string }) => p.page === page);
            return {
              page,
              sourceState: saved?.state ?? 'unexamined',
              sourceTruncated: saved?.truncated ?? false,
              reasonCategory: 'needs_investigation',
              reason: 'Owner requests investigation of this incomplete public page coverage.',
              proposedPublicUrl: null,
            };
          }),
        },
      };
      const snapshotText = canonicalJson(snapshot);
      const sourceText = canonicalJson({
        ...JSON.parse(text),
        owner_clarification: {
          snapshot_text: snapshotText,
          snapshot_sha256: hash(snapshotText),
          receipt_id: '1',
        },
      });
      const publicInput = { ...input, sourceText, sourceSha256: hash(sourceText) };
      vectors.push({ kind, input: publicInput, document: buildClarifiedReport(publicInput) });
    }
  }
}
const json = JSON.stringify(vectors);
if (json.includes('$coverage180$')) throw Error('Synthetic delimiter refused');
const sql = `-- Generated from production TS source8/document8 codecs; synthetic fixtures only.
-- Execute only in an isolated migration test DB. Every table effect rolls back.
begin;
create function pg_temp.ok(v boolean,m text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'ASSERTION FAILED: %',m;end if;end$$;
do $$declare vector jsonb;i jsonb;d jsonb;s jsonb;txt text;oc jsonb;snap jsonb;receipt bigint;expected jsonb;existing uuid;begin
 for vector in select value from jsonb_array_elements($coverage180$${json}$coverage180$::jsonb)loop
  i:=vector->'input';expected:=vector->'document';
  if expected->'owner_coverage_clarification' is not null and expected->'owner_coverage_clarification'<>'null'::jsonb then
   -- Native codec parity scaffold, not an assertion of a live capture or owner MFA.
   -- All FKs and the append-only ledger path are real. No ledger sequence reset.
   s:=(i->>'sourceText')::jsonb;oc:=s->'owner_clarification';snap:=(oc->>'snapshot_text')::jsonb;
   insert into auth.users(id,email)values((snap->>'actorId')::uuid,'coverage180@example.invalid')on conflict do nothing;
   insert into public.users(id,email,full_name)values((snap->>'actorId')::uuid,'coverage180@example.invalid','Synthetic owner')on conflict do nothing;
   insert into public.tenants(id,slug,name)values((snap->>'tenantId')::uuid,'coverage180-fixture','Synthetic codec tenant')on conflict do nothing;
   insert into public.control_libraries(version,published_at,published_by,change_log,control_count)values('coverage180-fixture',now(),'fixture','Synthetic only',0)on conflict do nothing;
   if not exists(select 1 from public.engagements where id=(snap#>>'{request,engagementId}')::uuid) then
    insert into public.engagements(id,tenant_id,library_version,title)values((snap#>>'{request,engagementId}')::uuid,(snap->>'tenantId')::uuid,'coverage180-fixture','Synthetic codec engagement');
   end if;
   insert into public.public_website_checks(id,tenant_id,actor_id,correlation_id,requested_url,status,error_code)
    values((snap#>>'{request,checkId}')::uuid,(snap->>'tenantId')::uuid,(snap->>'actorId')::uuid,(snap#>>'{request,checkId}')::uuid,'https://example.invalid/','failed','synthetic_fixture')on conflict do nothing;
   select id into existing from controller_security.public_coverage_clarifications where tenant_id=(snap->>'tenantId')::uuid and engagement_id=(snap#>>'{request,engagementId}')::uuid and check_id=(snap#>>'{request,checkId}')::uuid and payload_sha256=snap#>>'{request,payloadSha256}';
   if existing is not null then
    -- Board and Auditor parity use the same immutable owner snapshot and receipt.
    select receipt_id into receipt from controller_security.public_coverage_clarifications where id=existing;
   else
   receipt:=public.append_ledger((snap->>'tenantId')::uuid,(snap#>>'{request,operationKey}')::uuid,'human',snap->>'actorId',null,null,null,'public_coverage.owner_clarified',snap->>'revisionId',null,oc->>'snapshot_sha256',null,null,null,null,'success','{}');
   insert into controller_security.public_coverage_clarifications(id,tenant_id,actor_id,engagement_id,check_id,payload_sha256,operation_key,request_text,request_sha256,snapshot_text,snapshot_sha256,receipt_id)
   values((snap->>'revisionId')::uuid,(snap->>'tenantId')::uuid,(snap->>'actorId')::uuid,(snap#>>'{request,engagementId}')::uuid,(snap#>>'{request,checkId}')::uuid,snap#>>'{request,payloadSha256}',(snap#>>'{request,operationKey}')::uuid,controller_security.canonical_questionnaire_json(snap->'request'),encode(sha256(convert_to(controller_security.canonical_questionnaire_json(snap->'request'),'UTF8')),'hex'),oc->>'snapshot_text',oc->>'snapshot_sha256',receipt);
   end if;
   s:=jsonb_set(s,'{owner_clarification,receipt_id}',to_jsonb(receipt::text));txt:=controller_security.canonical_questionnaire_json(s);
   i:=i||jsonb_build_object('sourceText',txt,'sourceSha256',encode(sha256(convert_to(txt,'UTF8')),'hex'));
   expected:=expected||jsonb_build_object('owner_clarification_receipt',receipt::text,'source_sha256',i->>'sourceSha256');
  end if;
  if vector->'document'='null'::jsonb then
   begin
    perform controller_security.coverage180_inner(vector->>'kind',i->>'sourceText',i->>'sourceSha256');
    raise exception 'incomplete public coverage without owner reasons accepted';
   exception when sqlstate '22023' then
    perform pg_temp.ok(sqlerrm='owner coverage explanation required','public null clarification refused for the correct reason');
   end;
  else
   d:=controller_security.coverage180_document(vector->>'kind',i->>'sourceText',i->>'sourceSha256',(i->>'tenantId')::uuid,(i->>'engagementId')::uuid,(i->>'assessmentRunId')::uuid,(i->>'requestId')::uuid,i->>'title',i->>'generatedAt');
   perform pg_temp.ok(d=expected,'production TS/SQL full document8 parity (only native receipt and resulting source digest rebound)');
   if expected->'owner_coverage_clarification'='null'::jsonb then
   perform pg_temp.ok(d->'owner_coverage_clarification'='null'::jsonb and d->'owner_clarification_receipt'='null'::jsonb,'questionnaire makes no public-page examination claim');
   s:=jsonb_set((i->>'sourceText')::jsonb,'{owner_clarification}',jsonb_build_object('snapshot_text','{}','snapshot_sha256',repeat('a',64),'receipt_id','1'));
   txt:=controller_security.canonical_questionnaire_json(s);
   begin
    perform controller_security.coverage180_inner(vector->>'kind',txt,encode(sha256(convert_to(txt,'UTF8')),'hex'));
    raise exception 'grafted questionnaire owner declaration accepted';
   exception when sqlstate '22023' then null;end;
   end if;
  end if;
 end loop;
end$$;
rollback;
`;
writeFileSync('tests/database/clarified-report-parity.test.sql', sql);
console.log(
  'Generated four production document8 parity vectors and two public missing-clarification refusal vectors; no SQL executed.',
);
