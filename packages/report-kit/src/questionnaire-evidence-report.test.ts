import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildPramaanAuditorArchive, buildPramaanBoardArchive } from './pramaan-archive';
import { canonicalJson } from '@axiom/ledger';
import { packetHash, sourcePacket } from './board-v2.fixture';
import {
  buildQuestionnaireEvidenceReport,
  encodeQuestionnaireEvidenceSource,
  renderQuestionnaireEvidenceDraft,
  renderReviewedQuestionnaireEvidenceReport,
  verifyQuestionnaireEvidenceSource,
  QuestionnaireEvidenceDocumentV6Schema,
} from './questionnaire-evidence-report';

const ids = {
  requestId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  engagementId: '33333333-3333-4333-8333-333333333333',
  assessmentRunId: '44444444-4444-4444-8444-444444444444',
};
const hash = (n: string) => n.repeat(64);

type Packet = ReturnType<typeof sourcePacket>;
function source1(kind: 'board' | 'auditor', packet: Packet = sourcePacket()) {
  const controlsText = JSON.stringify(packet.controls);
  const resultText = JSON.stringify(packet.result);
  const source = {
    schema_version: 1,
    serialization: 'postgres-jsonb-text-v1',
    kind: kind === 'board' ? 'board_source' : 'statutory_source',
    ...(kind === 'auditor' ? { report_kind: 'auditor' } : {}),
    request_id: ids.requestId,
    tenant_id: ids.tenantId,
    engagement_id: ids.engagementId,
    assessment_run_id: ids.assessmentRunId,
    library_version: 'test-v2',
    controls_text: controlsText,
    controls_sha256: packetHash(controlsText),
    result_text: resultText,
    result_sha256: packetHash(resultText),
    completed_at: '2026-10-17T05:00:00+00:00',
    finalized_at: '2026-10-17T05:01:00.000001+00:00',
    receipts: {
      started: { id: '10', entry_hash: hash('a') },
      completed: { id: '11', entry_hash: hash('b') },
      finalized: { id: '12', entry_hash: hash('c') },
    },
    limitations: ['Recorded questionnaire computation; no independent evidence verification.'],
  };
  return JSON.stringify(source);
}
function envelope(kind: 'board' | 'auditor', packet?: Packet) {
  const retained = source1(kind, packet);
  return encodeQuestionnaireEvidenceSource(kind, retained, packetHash(retained));
}
function build(kind: 'board' | 'auditor', packet?: Packet) {
  const s = envelope(kind, packet);
  return buildQuestionnaireEvidenceReport({
    ...ids,
    sourceText: s.text,
    sourceSha256: s.sha256,
    title: 'Board evidence review',
    generatedAt: '2026-10-17T06:00:00.000Z',
  });
}
const NUMERIC_LEAKS = /posture|exposure|score|band|123456|30%/i;

describe('questionnaire evidence report (source5/document6)', () => {
  it('withholds every metric and keeps original numbers out of the document', () => {
    for (const kind of ['board', 'auditor'] as const) {
      const d = build(kind);
      expect(d.metrics).toEqual({ state: 'withheld', compliance_conclusion: 'not_determined' });
      expect(d.kind).toBe(kind === 'board' ? 'board_report' : 'auditor_pack');
      expect(canonicalJson(d)).not.toMatch(NUMERIC_LEAKS);
    }
  });

  it('maps an unanswered questionnaire to Unknown and question-less controls to evidence workflow', () => {
    const d = build('board');
    expect(d.summary).toEqual({
      controls: 46,
      provenanceUnavailable: 0,
      unknown: 44,
      declaredNotApplicable: 0,
      notBooleanAssessable: 2,
      declarationsRecorded: 0,
    });
    expect(d.applicability).toEqual({
      sdfSelfAttested: null,
      processesChildren: null,
      processesHealth: null,
    });
  });

  it('a fully answered all-Yes questionnaire still withholds metrics', () => {
    const packet = sourcePacket();
    for (const c of packet.result.questionnaire_provenance.controls) {
      c.questions = c.questions.map((q) => ({ ...q, declaration: 'caller_affirmed' }));
      c.caller_affirmed_count = c.questions.length;
      c.unknown_count = 0;
      if (c.questions.length) c.answer_state = 'caller_declared_unverified';
    }
    const d = build('board', packet);
    expect(d.summary.declarationsRecorded).toBe(44);
    expect(d.metrics.state).toBe('withheld');
    expect(d.controls[0]).toMatchObject({
      state: 'declarations_recorded_unverified',
      answerCounts: { known: 2, affirmed: 2, denied: 0, unknown: 0 },
    });
  });

  it('reports unavailable provenance without inventing answers or applicability', () => {
    const packet = sourcePacket();
    delete (packet.result as { questionnaire_provenance?: unknown }).questionnaire_provenance;
    const d = build('auditor', packet);
    expect(d.questionnaire.provenance).toBe('unavailable');
    expect(d.applicability).toBeNull();
    expect(
      d.controls.every((c) => c.state === 'provenance_unavailable' && c.answerCounts === null),
    ).toBe(true);
  });

  it('refuses a source that is not questionnaire-only source1', () => {
    const retained = JSON.parse(source1('board'));
    retained.schema_version = 2;
    const text = JSON.stringify(retained);
    expect(() => encodeQuestionnaireEvidenceSource('board', text, packetHash(text))).toThrow(
      'questionnaire_source_refused',
    );
  });

  it('refuses a wrong scope, a tampered digest and non-canonical source text', () => {
    const s = envelope('board');
    expect(() =>
      verifyQuestionnaireEvidenceSource(s.text, s.sha256, { ...ids, tenantId: ids.engagementId }),
    ).toThrow();
    expect(() => verifyQuestionnaireEvidenceSource(s.text, hash('d'), ids)).toThrow();
    const spaced = s.text.replace('{', '{ ');
    expect(() => verifyQuestionnaireEvidenceSource(spaced, packetHash(spaced), ids)).toThrow();
  });

  it('renders HTML that names the withholding and carries no numeric estimate', () => {
    const s = envelope('board');
    const page = renderQuestionnaireEvidenceDraft({
      ...ids,
      sourceText: s.text,
      sourceSha256: s.sha256,
      title: 'Board evidence review <b>',
      generatedAt: '2026-10-17T06:00:00.000Z',
    });
    expect(page).toContain('Scores, score bands and financial exposure estimates are withheld');
    expect(page).toContain('Board evidence review &lt;b&gt;');
    expect(
      page.replace('Scores, score bands and financial exposure estimates are withheld', ''),
    ).not.toMatch(NUMERIC_LEAKS);
  });

  it('reviewed rendering refuses a grafted estimate or a document not recomputed from source', () => {
    const s = envelope('board');
    const d = build('board');
    const reportId = '55555555-5555-4555-8555-555555555555';
    const review = (documentText: string) =>
      JSON.stringify({
        schema_version: 1,
        report_id: reportId,
        content_sha256: packetHash(documentText),
        decision: 'approved',
        reviewer: { id: '66666666-6666-4666-8666-666666666666', display_name: 'Reviewer' },
        reviewed_at: '2026-10-17T07:00:00.000Z',
      });
    const render = (documentText: string) =>
      renderReviewedQuestionnaireEvidenceReport({
        ...ids,
        reportId,
        title: 'Board evidence review',
        sourceText: s.text,
        sourceSha256: s.sha256,
        documentText,
        documentSha256: packetHash(documentText),
        reviewText: review(documentText),
        reviewSha256: packetHash(review(documentText)),
      });
    expect(render(canonicalJson(d))).toContain('Human-reviewed evidence report');
    const grafted = canonicalJson({ ...d, posture_score: 30 });
    expect(() => render(grafted)).toThrow('questionnaire_review_refused');
    const altered = canonicalJson({ ...d, summary: { ...d.summary, unknown: 0 } });
    expect(() => render(altered)).toThrow('questionnaire_review_refused');
    expect(
      QuestionnaireEvidenceDocumentV6Schema.safeParse({ ...d, schema_version: 5 }).success,
    ).toBe(false);
  });
});

describe.each(['board', 'auditor'] as const)('Pramaan source5 %s exact provider bytes', (kind) => {
  it('validates the questionnaire source and retains the complete policy wrapper', () => {
    const frozen = envelope(kind);
    const pdfBytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(600)]);
    const reportId = '77777777-7777-4777-8777-777777777777';
    const input = {
      tenantId: ids.tenantId,
      engagementId: ids.engagementId,
      reportId,
      requestId: ids.requestId,
      title: 'Evidence review',
      sourceBytes: Buffer.from(frozen.text),
      pdfBytes,
      source: { id: ids.requestId, versionId: 'exact-source5', sha256: frozen.sha256 },
      pdf: { id: reportId, versionId: 'exact-reviewed6-pdf', sha256: '' },
    };
    input.pdf.sha256 = createHash('sha256').update(pdfBytes).digest('hex');
    const build = kind === 'board' ? buildPramaanBoardArchive : buildPramaanAuditorArchive;
    const files = unzipSync(build(input).archive);
    expect(Buffer.from(files['source/assessment.json']!).toString()).toBe(frozen.text);
    expect(() => build({ ...input, tenantId: ids.engagementId })).toThrow();
    for (const change of ['policy', 'nested-hash', 'kind'] as const) {
      const raw = JSON.parse(frozen.text);
      if (change === 'policy') raw.presentation_policy.metrics = 'published';
      if (change === 'nested-hash') raw.retained_source.sha256 = 'f'.repeat(64);
      if (change === 'kind') raw.report_kind = kind === 'board' ? 'auditor' : 'board';
      const text = canonicalJson(raw);
      expect(() =>
        build({
          ...input,
          sourceBytes: Buffer.from(text),
          source: { ...input.source, sha256: packetHash(text) },
        }),
      ).toThrow();
    }
  });
});
