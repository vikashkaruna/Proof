// @vitest-environment jsdom
import { cleanup, isInaccessible, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CoverageFirstPreview } from './coverage-first-preview';
import { detailSchema } from './report-contract';
import { PREVIEW_BRANDED_PRESENTATION_V1 } from './report-preview-version';

afterEach(cleanup);
function visible(element: HTMLElement) {
  expect(isInaccessible(element)).toBe(false);
  expect(element.closest('details')).toBeNull();
}
const id = '11111111-1111-4111-8111-111111111111';
function record(overrides: Record<string, unknown> = {}) {
  return detailSchema.parse({
    id,
    kind: 'board',
    title: 'Recorded website review',
    engagementId: id,
    libraryVersion: '0.1.1',
    status: 'draft',
    generatedAt: '2026-10-16T00:00:00Z',
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
    contentText: JSON.stringify(document()),
    ...overrides,
  });
}
function document() {
  return {
    schema_version: 5,
    kind: 'board_report',
    title: 'Recorded website review',
    engagement_id: id,
    metrics: { state: 'withheld', compliance_conclusion: 'not_determined' },
    coverage: {
      wholeWebsiteExamined: false,
      internalEvidenceVerified: false,
      candidatesTruncated: true,
      pages: [{ page: 'privacy', state: 'examined' }],
    },
    summary: {
      controls: 46,
      questions: 73,
      omittedUnknown: 65,
      explicitUnknown: 2,
      humanYesUnverified: 1,
      humanNoUnverified: 1,
      notBooleanAssessable: 4,
    },
    provenance: { libraryVersion: '0.1.1' },
    declarationsVerified: false,
    evidenceVerified: false,
    humanReviewRequired: true,
  };
}

it('shows qualified coverage visibly without expanding raw content or inventing a score', () => {
  render(<CoverageFirstPreview report={record()} />);
  const region = screen.getByRole('region', { name: 'Website evidence coverage' });
  visible(within(region).getByText('Scores and financial exposure estimates are withheld.'));
  visible(within(region).getByText('Unknown — no judgment recorded'));
  visible(within(region).getByText('Human Yes — unverified'));
  visible(within(region).getByText('privacy: examined'));
  visible(within(region).getByText('The saved evidence candidate list is truncated.'));
  expect(region.textContent).not.toMatch(/32\.39|58\.44|₹|%|certified compliant/);
  expect(within(region).queryByRole('button')).toBeNull();
  const preview = within(region).getByRole('link', { name: 'Preview readable report' });
  expect(preview.getAttribute('href')).toBe(`/api/bff/v1/reports/statutory/${id}/html`);
  expect(preview.getAttribute('rel')).toBe('noopener noreferrer');
});

it.each([
  ['board', 'board_report', 'board'],
  ['auditor', 'auditor_pack', 'statutory'],
])('published %s offers only its existing retained PDF endpoint', (kind, contentKind, route) => {
  render(
    <CoverageFirstPreview
      report={record({
        kind,
        status: 'published',
        contentText: JSON.stringify({ ...document(), kind: contentKind }),
      })}
    />,
  );
  expect(screen.getByRole('link', { name: 'View retained PDF' }).getAttribute('href')).toBe(
    `/api/bff/v1/reports/${route}/${id}/pdf`,
  );
  expect(screen.queryByRole('link', { name: 'Preview readable report' })).toBeNull();
});

it('leaves historical, mismatched, unsupported and malformed records to the original view', () => {
  const bad = [
    '{',
    JSON.stringify({ ...document(), schema_version: 4 }),
    JSON.stringify({ ...document(), schema_version: 8 }),
    JSON.stringify({ ...document(), kind: 'auditor_pack' }),
    JSON.stringify({ ...document(), title: 'Different request' }),
    JSON.stringify({ ...document(), engagement_id: '22222222-2222-4222-8222-222222222222' }),
    JSON.stringify({
      ...document(),
      metrics: { state: 'published', compliance_conclusion: 'compliant' },
    }),
    JSON.stringify({ ...document(), evidenceVerified: true }),
    JSON.stringify({ ...document(), provenance: { libraryVersion: '0.2.0' } }),
    JSON.stringify({ ...document(), summary: { ...document().summary, questions: -1 } }),
    ' '.repeat(4 * 1024 * 1024 + 1),
  ];
  for (const contentText of bad) {
    const view = render(<CoverageFirstPreview report={record({ contentText })} />);
    expect(view.container.childNodes.length).toBe(0);
    view.unmount();
  }
});

it.each(['board', 'auditor'] as const)(
  'shows exact branded public %s doc7 through its original coverage projection',
  (kind) => {
    const content = {
      ...document(),
      schema_version: 7,
      underlying_document_version: 5,
      kind: kind === 'board' ? 'board_report' : 'auditor_pack',
      organization_name: 'Synthetic company',
      source_sha256: 'b'.repeat(64),
      underlying_source_sha256: 'c'.repeat(64),
      presentation: PREVIEW_BRANDED_PRESENTATION_V1,
    };
    render(
      <CoverageFirstPreview report={record({ kind, contentText: JSON.stringify(content) })} />,
    );
    expect(screen.getByRole('region', { name: 'Website evidence coverage' })).toBeTruthy();
    expect(screen.getByText('Scores and financial exposure estimates are withheld.')).toBeTruthy();
  },
);
