// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { QuestionnaireEvidencePreview } from './questionnaire-evidence-preview';
import { detailSchema } from './report-contract';
import { PREVIEW_BRANDED_PRESENTATION_V1 } from './report-preview-version';

afterEach(cleanup);
const id = '11111111-1111-4111-8111-111111111111';
function doc6(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 6,
    kind: 'board_report',
    title: 'Questionnaire review',
    engagement_id: id,
    metrics: { state: 'withheld', compliance_conclusion: 'not_determined' },
    questionnaire: { provenance: 'caller_declared_unverified', libraryVersion: '0.1.1' },
    summary: {
      controls: 46,
      provenanceUnavailable: 0,
      unknown: 40,
      declaredNotApplicable: 1,
      notBooleanAssessable: 2,
      declarationsRecorded: 3,
    },
    declarationsVerified: false,
    evidenceVerified: false,
    humanReviewRequired: true,
    ...overrides,
  };
}
function record(content: unknown, overrides: Record<string, unknown> = {}) {
  return detailSchema.parse({
    id,
    kind: 'board',
    title: 'Questionnaire review',
    engagementId: id,
    libraryVersion: '0.1.1',
    status: 'draft',
    generatedAt: '2026-10-17T00:00:00Z',
    generatedByAgent: 'board-report-builder',
    createdBy: id,
    contentHash: 'a'.repeat(64),
    reviewedContentHash: null,
    review: null,
    publishedAt: null,
    releasedBy: null,
    releasedArchiveHash: null,
    assurance: 'digest_bound',
    pack: null,
    contentText: JSON.stringify(content),
    ...overrides,
  });
}

it('shows withheld metrics and qualitative coverage counts for document6', () => {
  render(<QuestionnaireEvidencePreview report={record(doc6())} />);
  expect(
    screen.getByText('Scores, score bands and financial exposure estimates are withheld.'),
  ).toBeTruthy();
  expect(screen.getByText('Declarations recorded — unverified').nextSibling?.textContent).toBe('3');
  expect(screen.getByRole('link', { name: 'Preview readable report' })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/posture|exposure inr|%/i);
});

it('renders nothing for other documents, mismatched identity or a grafted metric state', () => {
  for (const content of [
    doc6({ schema_version: 5 }),
    doc6({ schema_version: 8 }),
    doc6({ title: 'Other' }),
    doc6({ metrics: { state: 'published', compliance_conclusion: 'not_determined' } }),
    doc6({ kind: 'auditor_pack' }),
  ]) {
    const { container } = render(<QuestionnaireEvidencePreview report={record(content)} />);
    expect(container.innerHTML).toBe('');
    cleanup();
  }
});

it.each(['board', 'auditor'] as const)(
  'shows exact branded questionnaire %s doc7 with unknown-only coverage',
  (kind) => {
    const content = doc6({
      schema_version: 7,
      underlying_document_version: 6,
      kind: kind === 'board' ? 'board_report' : 'auditor_pack',
      organization_name: 'Synthetic company',
      source_sha256: 'b'.repeat(64),
      underlying_source_sha256: 'c'.repeat(64),
      presentation: PREVIEW_BRANDED_PRESENTATION_V1,
    });
    render(<QuestionnaireEvidencePreview report={record(content, { kind })} />);
    expect(screen.getByRole('region', { name: 'Questionnaire evidence coverage' })).toBeTruthy();
    expect(
      screen.getByText('Scores, score bands and financial exposure estimates are withheld.'),
    ).toBeTruthy();
  },
);
