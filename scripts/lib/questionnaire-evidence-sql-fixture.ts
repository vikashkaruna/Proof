/**
 * Generates tests/database/questionnaire-evidence-parity.test.sql: the exact
 * source5 text and document6 that @axiom/report-kit computes for fixed source1
 * inputs, which SQL 0155 must reproduce byte for byte. The committed SQL file
 * is checked against this generator by questionnaire-evidence-sql-fixture.test.ts.
 *
 *   pnpm exec tsx scripts/lib/questionnaire-evidence-sql-fixture.ts --write
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@axiom/ledger';
import {
  buildQuestionnaireEvidenceReport,
  encodeQuestionnaireEvidenceSource,
} from '../../packages/report-kit/src/questionnaire-evidence-report';

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
export const PARITY_SQL_PATH = join(
  __dirname,
  '../../tests/database/questionnaire-evidence-parity.test.sql',
);

type Answer = 'unknown' | 'caller_affirmed' | 'caller_denied';
interface Case {
  name: string;
  kind: 'board' | 'auditor';
  answer: Answer | 'mixed';
  provenance: boolean;
  sdf: boolean | null;
  title: string;
}
const CASES: Case[] = [
  {
    name: 'board_unknown',
    kind: 'board',
    answer: 'unknown',
    provenance: true,
    sdf: null,
    title: 'Board review',
  },
  {
    name: 'auditor_all_yes',
    kind: 'auditor',
    answer: 'caller_affirmed',
    provenance: true,
    sdf: false,
    title: 'Auditor pack — Q3 ✓',
  },
  {
    name: 'board_mixed_sdf',
    kind: 'board',
    answer: 'mixed',
    provenance: true,
    sdf: true,
    title: 'Board 🧾 review',
  },
  {
    name: 'auditor_unavailable',
    kind: 'auditor',
    answer: 'unknown',
    provenance: false,
    sdf: null,
    title: 'Auditor pack',
  },
];

function source1(c: Case, ids: Record<'request' | 'tenant' | 'engagement' | 'run', string>) {
  const controls = Array.from({ length: 5 }, (_, i) => ({
    id: `QE-${i + 1}`,
    title: i === 2 ? 'Notice in “plain” language — ✓' : `Control ${i + 1}`,
    domain: i % 2 ? 'CNS' : 'GOV',
    severity: 'high',
    library_version: 'qe-test',
    sdf_only: i === 3,
    children_only: false,
    assessment_questions: Array.from({ length: i === 4 ? 0 : 2 }, (_, q) => ({
      id: `QE-${i + 1}-${q}`,
      type: 'boolean',
    })),
  }));
  const controlsText = JSON.stringify(controls);
  const declared = (i: number, q: number): Answer =>
    c.answer === 'mixed'
      ? (['caller_affirmed', 'caller_denied', 'unknown'] as const)[(i + q) % 3]!
      : c.answer;
  const applicability = (sdfOnly: boolean) =>
    !sdfOnly
      ? 'unconditional'
      : c.sdf === false
        ? 'caller_declared_not_applicable_unverified'
        : c.sdf === null
          ? 'unknown'
          : 'caller_declared_applicable_unverified';
  const provenance = {
    version: 1,
    source_library_version: 'qe-test',
    source_library_digest: sha(controlsText),
    estimates: 'provisional',
    review_required: true,
    controls: controls.map((ctl, i) => {
      const questions = ctl.assessment_questions.map((q, n) => ({
        question_id: q.id,
        declaration: declared(i, n),
      }));
      const yes = questions.filter((q) => q.declaration === 'caller_affirmed').length;
      const no = questions.filter((q) => q.declaration === 'caller_denied').length;
      const unknown = questions.length - yes - no;
      return {
        control_id: ctl.id,
        questions,
        known_boolean_question_count: questions.length,
        caller_affirmed_count: yes,
        caller_denied_count: no,
        unknown_count: unknown,
        answer_state: !questions.length
          ? 'not_boolean_assessable'
          : unknown === questions.length
            ? 'unknown'
            : unknown
              ? 'partially_answered'
              : 'caller_declared_unverified',
        applicability_state: applicability(ctl.sdf_only),
      };
    }),
    applicability: {
      sdf_self_attested:
        c.sdf === null
          ? { value: null, provenance: 'unknown' }
          : { value: c.sdf, provenance: 'caller_declared_unverified' },
      processes_children: { value: null, provenance: 'unknown' },
      processes_health: { value: false, provenance: 'caller_declared_unverified' },
    },
  };
  const result = {
    library_version: 'qe-test',
    posture_score: 41.5,
    estimated_exposure_inr: 2500000,
    findings: controls.map((ctl) => ({ control_id: ctl.id, score: 41.5, rationale: 'Recorded.' })),
    ...(c.provenance ? { questionnaire_provenance: provenance } : {}),
  };
  const resultText = JSON.stringify(result);
  const receipt = (n: number, h: string) => ({ id: String(n), entry_hash: h.repeat(64) });
  return JSON.stringify({
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: c.kind === 'board' ? 'board_source' : 'statutory_source',
    ...(c.kind === 'auditor' ? { report_kind: 'auditor' } : {}),
    request_id: ids.request,
    tenant_id: ids.tenant,
    engagement_id: ids.engagement,
    assessment_run_id: ids.run,
    library_version: 'qe-test',
    controls_text: controlsText,
    controls_sha256: sha(controlsText),
    result_text: resultText,
    result_sha256: sha(resultText),
    completed_at: '2026-10-17T05:00:00.25+00:00',
    finalized_at: '2026-10-17T05:01:00.654321+00:00',
    receipts: { started: receipt(7, 'a'), completed: receipt(8, 'b'), finalized: receipt(9, 'c') },
    limitations: ['Recorded questionnaire computation; no independent evidence verification.'],
  });
}

const lit = (t: string) => `$q155$${t}$q155$`;

export function questionnaireEvidenceParitySql(): string {
  const out: string[] = [
    '-- GENERATED by scripts/lib/questionnaire-evidence-sql-fixture.ts. Do not edit by hand.',
    '-- 0155 must reproduce @axiom/report-kit source5 text and document6 exactly.',
    'begin;',
    "create function pg_temp.ok(v boolean, m text) returns void language plpgsql as $$ begin if v is distinct from true then raise exception 'ASSERTION FAILED: %', m; end if; end $$;",
    "create function pg_temp.refused(s text) returns void language plpgsql as $$ begin begin execute s; exception when sqlstate '22023' then return; end; raise exception 'not refused: %', s; end $$;",
  ];
  CASES.forEach((c, i) => {
    const id = (n: number) => `00000000-0000-4000-8155-${`${i + 1}${n}`.padStart(12, '0')}`;
    const ids = { request: id(1), tenant: id(2), engagement: id(3), run: id(4) };
    const retained = source1(c, ids);
    const envelope = encodeQuestionnaireEvidenceSource(c.kind, retained, sha(retained));
    const generatedAt = '2026-10-17T06:00:00.000Z';
    const document = buildQuestionnaireEvidenceReport({
      requestId: ids.request,
      tenantId: ids.tenant,
      engagementId: ids.engagement,
      assessmentRunId: ids.run,
      sourceText: envelope.text,
      sourceSha256: envelope.sha256,
      title: c.title,
      generatedAt,
    });
    out.push(
      `-- ${c.name}`,
      `select pg_temp.ok(controller_security.questionnaire155_wrap('${c.kind}', ${lit(retained)}) = ${lit(envelope.text)}, '${c.name}: source5 text parity');`,
      `select pg_temp.ok(controller_security.questionnaire155_document('${c.kind}', ${lit(envelope.text)}, '${envelope.sha256}', '${ids.tenant}', '${ids.engagement}', '${ids.run}', '${ids.request}', ${lit(c.title)}, '${generatedAt}') = ${lit(canonicalJson(document))}::jsonb, '${c.name}: document6 parity');`,
      `select pg_temp.ok(controller_security.canonical_questionnaire_json(controller_security.questionnaire155_document('${c.kind}', ${lit(envelope.text)}, '${envelope.sha256}', '${ids.tenant}', '${ids.engagement}', '${ids.run}', '${ids.request}', ${lit(c.title)}, '${generatedAt}')) = ${lit(canonicalJson(document))}, '${c.name}: document6 canonical bytes');`,
      `select pg_temp.refused(format('select controller_security.questionnaire155_document(%L,%L,%L,%L,%L,%L,%L,%L,%L)', '${c.kind}', ${lit(envelope.text)}, '${envelope.sha256}', '${ids.engagement}', '${ids.engagement}', '${ids.run}', '${ids.request}', 'x', '${generatedAt}'));`,
    );
  });
  // Refusals and INSERT-time selection, on the first case's source1.
  const c0 = CASES[0]!;
  const id0 = (n: number) => `00000000-0000-4000-8155-${`1${n}`.padStart(12, '0')}`;
  const base = JSON.parse(
    source1(c0, { request: id0(1), tenant: id0(2), engagement: id0(3), run: id0(4) }),
  );
  const variant = (patch: Record<string, unknown>) => lit(JSON.stringify({ ...base, ...patch }));
  const wrapped = encodeQuestionnaireEvidenceSource(
    'board',
    JSON.stringify(base),
    sha(JSON.stringify(base)),
  );
  out.push(
    '-- refusals',
    `select pg_temp.refused(format('select controller_security.questionnaire155_wrap(%L,%L)', 'board', ${variant({ schema_version: 2 })}));`,
    `select pg_temp.refused(format('select controller_security.questionnaire155_wrap(%L,%L)', 'board', ${variant({ result_sha256: 'd'.repeat(64) })}));`,
    `select pg_temp.refused(format('select controller_security.questionnaire155_wrap(%L,%L)', 'auditor', ${variant({})}));`,
    `select pg_temp.refused(format('select controller_security.questionnaire155_wrap(%L,%L)', 'board', ${variant({ posture_score: 41.5 })}));`,
    `select pg_temp.refused(format('select controller_security.questionnaire155_inner(%L,%L,%L)', 'board', ${lit(wrapped.text.replace('{', '{ '))}, '${sha(wrapped.text.replace('{', '{ '))}'));`,
    '-- INSERT-time selection wraps a questionnaire-only source1 and nothing else',
    'create temporary table qe_sources (source_text text, source_sha256 text);',
    'create trigger qe_select before insert on qe_sources for each row execute function controller_security.questionnaire155_select_board();',
    `insert into qe_sources values (${lit(JSON.stringify(base))}, 'x');`,
    `select pg_temp.ok((select source_text = ${lit(wrapped.text)} and source_sha256 = '${wrapped.sha256}' from qe_sources), 'source1 insert becomes source5');`,
    'truncate qe_sources;',
    `insert into qe_sources values ('{"schema_version":4}', 'y');`,
    `select pg_temp.ok((select source_text = '{"schema_version":4}' and source_sha256 = 'y' from qe_sources), 'other sources are untouched');`,
  );
  out.push('rollback;', '');
  return out.join('\n');
}

if (process.argv.includes('--write')) {
  writeFileSync(PARITY_SQL_PATH, questionnaireEvidenceParitySql());
  console.log(`wrote ${PARITY_SQL_PATH}`);
}
