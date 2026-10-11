import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { StatutoryReportService } from './statutory-reports';
import {
  interpretAssessmentReport,
  assessmentReviewRecommendation,
} from '@axiom/report-kit/assessment-interpretation';
import type { EvidenceDatabase } from './evidence-ingestion';
function boardV2Fixture(legacy = false) {
  const controls = [0, 1].map((i) => ({
    id: `C-${i}`,
    library_version: 'v1',
    sdf_only: false,
    children_only: false,
    assessment_questions: i ? [] : [{ id: 'Q', type: 'boolean' }],
  }));
  const digest = createHash('sha256').update(JSON.stringify(controls)).digest('hex');
  const result: Record<string, unknown> = {
    library_version: 'v1',
    posture_score: 30,
    estimated_exposure_inr: 123456,
    findings: controls.map((c) => ({ control_id: c.id, score: 30 })),
    questionnaire_provenance: {
      version: 1,
      source_library_version: 'v1',
      source_library_digest: digest,
      estimates: 'provisional',
      review_required: true,
      controls: controls.map((c) => ({
        control_id: c.id,
        questions: c.assessment_questions.map((q) => ({
          question_id: q.id,
          declaration: 'unknown',
        })),
        known_boolean_question_count: c.assessment_questions.length,
        caller_affirmed_count: 0,
        caller_denied_count: 0,
        unknown_count: c.assessment_questions.length,
        answer_state: c.assessment_questions.length ? 'unknown' : 'not_boolean_assessable',
        applicability_state: 'unconditional',
      })),
      applicability: {
        sdf_self_attested: { value: null, provenance: 'unknown' },
        processes_children: { value: null, provenance: 'unknown' },
        processes_health: { value: null, provenance: 'unknown' },
      },
    },
  };
  if (legacy) delete result.questionnaire_provenance;
  const interpreted = interpretAssessmentReport(result, controls, digest, 'Compatibility test');
  return {
    documentText: JSON.stringify({
      schema_version: 2,
      kind: 'board_report',
      title: 'Compatibility test',
      tenant_id: '11111111-1111-4111-8111-111111111111',
      engagement_id: '22222222-2222-4222-8222-222222222222',
      assessment_run_id: '33333333-3333-4333-8333-333333333333',
      assessment_result_digest: 'a'.repeat(64),
      library_version: 'v1',
      library_digest: digest,
      generated_at: '2026-10-01T12:00:00.000Z',
      branding: {
        product: 'Axiom Proof',
        company: 'Axiom Minds Private Limited',
        company_url: 'https://axiomminds.ai',
      },
      questionnaire_interpretation: interpreted.interpretation,
      executive_summary: interpreted.summary,
      key_findings: interpreted.findings.map((f) => ({
        ...f,
        domain: 'Security',
        severity: 'critical',
        title: 'Control',
        score: 30,
        gap_summary: 'Recorded unknown assessment.',
        remediation_recommendation: assessmentReviewRecommendation(f.display_state),
      })),
      action_plan: [],
      signatures: {
        prepared_by: {
          name: 'Axiom Proof board report builder',
          role: 'Deterministic assessment renderer',
          agent: 'board-report-builder',
        },
        approved_by: null,
      },
    }),
  };
}
function service() {
  return new StatutoryReportService({} as EvidenceDatabase);
}
describe('statutory board content version compatibility', () => {
  it('accepts V2 truthful unknown interpretation in existing statutory rendering', () => {
    const input = boardV2Fixture(),
      raw = JSON.parse(input.documentText);
    const { html, validatedContent } = service().validateAndRender('board', raw);
    expect(validatedContent).toEqual(raw);
    expect(html).toContain('Unknown answers or applicability');
    expect(html).toContain('No Boolean assessment questions');
    expect(html).toContain('DRAFT · PENDING FOUNDER APPROVAL');
    expect(html).not.toContain('REVIEWER APPROVAL RECORDED');
  });
  it('preserves historical V1 document bytes and content digest', () => {
    const raw = JSON.parse(boardV2Fixture(true).documentText);
    raw.schema_version = 1;
    delete raw.questionnaire_interpretation;
    raw.executive_summary = {
      posture_score: 30,
      total_controls: 2,
      passed_controls: 0,
      failed_controls: 2,
      critical_gaps: 2,
      high_gaps: 0,
      medium_gaps: 0,
      low_gaps: 0,
      estimated_exposure_inr: 123456,
      narrative: 'Historical deterministic report requiring evidence review.',
    };
    raw.key_findings = raw.key_findings.map((f: Record<string, unknown>) => {
      const {
        display_state: _,
        answer_state: _a,
        applicability_state: _b,
        answer_counts: _c,
        score_band: _d,
        ...original
      } = f;
      return original;
    });
    const text = JSON.stringify(raw),
      hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const result = service().validateAndRender('board', raw);
    expect(JSON.stringify(result.validatedContent)).toBe(text);
    expect(hash(JSON.stringify(result.validatedContent))).toBe(hash(text));
    expect(result.html).toContain('Historical report: questionnaire provenance is unavailable');
  });
  it('refuses malformed V2 without falling back to V1 numeric summaries', () => {
    const raw = JSON.parse(boardV2Fixture().documentText);
    raw.key_findings[0].display_state = 'provisional_score_band';
    raw.key_findings[0].score_band = 'under_40';
    expect(() => service().validateAndRender('board', raw)).toThrow();
    raw.schema_version = 3;
    expect(() => service().validateAndRender('board', raw)).toThrow();
  });
});
