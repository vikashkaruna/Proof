// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { publicControlAssessmentV2Schema } from '@axiom/types';
import {
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
  publicControlCatalogueV2Manifest,
} from '@axiom/control-library';
import { reviewFixture } from './control-review-fixture.test-helper';
import { PublicControlReview } from './public-control-review';
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
const tenantId = '11111111-1111-4111-8111-111111111111',
  engagementId = '22222222-2222-4222-8222-222222222222',
  checkId = '33333333-3333-4333-8333-333333333333';
const props = { tenantId, engagementId, checkId };
function response() {
  const manifest = publicControlCatalogueV2Manifest();
  const unknown = { state: 'internal_unknown', candidateOrdinals: [], requiresHumanReview: true };
  const assessment = publicControlAssessmentV2Schema.parse({
    version: 2,
    source: {
      version: 2,
      extractorVersion: 'static-public-2',
      ...props,
      projectionSha256: 'a'.repeat(64),
      assessmentDate: '2026-10-15',
      pages: [
        {
          page: 'root',
          state: 'examined',
          contentSha256: 'b'.repeat(64),
          truncated: true,
          coverageReasons: ['unsupported_foreign_markup', 'excerpt_limit'],
        },
        { page: 'privacy', state: 'unavailable', truncated: false, coverageReasons: [] },
        {
          page: 'consent',
          state: 'examined',
          contentSha256: 'c'.repeat(64),
          truncated: false,
          coverageReasons: [],
        },
      ],
      candidates: [
        {
          ordinal: 1,
          facet: 'consent_ui',
          kind: 'static_observation',
          context: 'demo',
          locator: { page: 'consent', contentSha256: 'c'.repeat(64), elementOrdinal: 7 },
          staticControl: {
            element: 'input',
            inputType: 'checkbox',
            likelyDataCategory: 'other',
            checkedAttribute: true,
            requiredAttribute: false,
            disabledAttribute: true,
          },
          excerpt: 'Consent demonstration only; operation unverified.',
          textDisposition: 'redacted_public_text',
          requiresHumanReview: true,
        },
      ],
      candidatesTruncated: false,
      scope: 'bounded_public_pages',
      requiresHumanReview: true,
    },
    catalogue: {
      libraryVersion: '0.1.1',
      baseline: 'IN-DPDP@2026-09-20',
      manifestSha256: 'd'.repeat(64),
      mappingVersion: 'public-evidence-1',
      defaultEffectiveFrom: '2027-05-13',
      perControlEffectiveDates: 'not_present_in_source',
      effectiveStatus: 'requires_assessment_date_and_legal_review',
    },
    controls: manifest.controls.map((control) => ({
      controlId: control.control.id,
      applicability: control.applicability === 'general' ? 'general' : 'conditional_unknown',
      questions: control.questions.map((q) => ({ questionId: q.questionId, evidence: unknown })),
      evidenceRequirements: control.evidenceRequirements.map((r) => ({
        index: r.index,
        evidence: unknown,
        internalVerificationRequired: true,
      })),
      requiresHumanReview: true,
    })),
    requiresHumanReview: true,
  });
  return {
    data: {
      assessment,
      catalogueManifestText: PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
      captureReceipt: '42',
    },
  };
}
function click() {
  fireEvent.click(screen.getByRole('button', { name: 'Review website against DPDPA controls' }));
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('loads scoped read-only evidence and renders all controls with plain source limits and human proof requirements', async () => {
  const value = response(),
    original = JSON.stringify(value);
  const fetcher = vi.fn().mockResolvedValue(Response.json(value));
  vi.stubGlobal('fetch', fetcher);
  render(<PublicControlReview {...props} />);
  expect(fetcher).not.toHaveBeenCalled();
  click();
  await screen.findByText(/Human review required · 46 controls/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe(
    `/api/bff/v1/public-website-checks/${checkId}/control-review?engagementId=${engagementId}`,
  );
  expect(init.method).toBe('GET');
  expect(init.headers['X-Tenant-Id']).toBe(tenantId);
  expect(init.body).toBeUndefined();
  expect(init.headers['Idempotency-Key']).toBeUndefined();
  expect(screen.getByText('Unsupported SVG or other foreign markup excluded')).toBeTruthy();
  expect(screen.getByText('Retained excerpt length limit reached')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Public page coverage' }).textContent).toContain(
    'privacy: Page unavailable',
  );
  expect(screen.getByText(/Context: demo/)).toBeTruthy();
  expect(screen.getByText(/Checked attribute: present/)).toBeTruthy();
  expect(screen.getByText(/not a separately recorded agent assessment/)).toBeTruthy();
  expect(screen.getByText(/Individual control effective dates are not present/)).toBeTruthy();
  const library = publicControlCatalogueV2Manifest();
  for (const control of library.controls)
    expect(screen.getByText(`${control.control.id} · ${control.control.title}`)).toBeTruthy();
  expect(
    screen.getAllByText(/Internal evidence required; public pages cannot establish this/).length,
  ).toBeGreaterThan(46);
  expect(screen.getByText(library.controls[0]!.control.obligation)).toBeTruthy();
  expect(
    screen.getByText(`Q1: ${library.controls[0]!.control.assessmentQuestions[0]!.prompt}`),
  ).toBeTruthy();
  expect(screen.getByText('42')).toBeTruthy();
  expect(JSON.stringify(value)).toBe(original);
});
it('explains selection prerequisites and never starts a request without both selected identities', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<PublicControlReview {...props} checkId="" />);
  expect(
    (
      screen.getByRole('button', {
        name: 'Review website against DPDPA controls',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText('Select an engagement and saved website check above.')).toBeTruthy();
  click();
  expect(fetcher).not.toHaveBeenCalled();
});
it('offers a fresh capture for a typed legacy-check refusal without exposing raw server details', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        { error: { code: 'website_recapture_required', message: 'PRIVATE_DATABASE_DETAIL' } },
        { status: 409 },
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<PublicControlReview {...props} />);
  click();
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('Capture fresh evidence'),
  );
  expect(
    screen.getByRole('link', { name: 'Audit website again in Connectors' }).getAttribute('href'),
  ).toBe('/connectors');
  expect(document.body.textContent).not.toContain('PRIVATE_DATABASE_DETAIL');
  expect(fetcher.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
});
it.each(['tenant', 'engagement', 'check', 'manifest', 'rows', 'malformed'])(
  'refuses %s mismatch without displaying source text',
  async (kind) => {
    const value = response();
    if (kind === 'manifest') value.data.catalogueManifestText += ' ';
    else if (kind === 'rows') value.data.assessment.controls.reverse();
    else if (kind === 'malformed') Object.assign(value.data, { unknown: 'PRIVATE_RAW_DETAIL' });
    else
      value.data.assessment.source[
        kind === 'tenant' ? 'tenantId' : kind === 'engagement' ? 'engagementId' : 'checkId'
      ] = '44444444-4444-4444-8444-444444444444';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)));
    render(<PublicControlReview {...props} />);
    click();
    await screen.findByRole('alert');
    expect(screen.queryByText(/Consent demonstration only/)).toBeNull();
    expect(document.body.textContent).not.toContain('PRIVATE_RAW_DETAIL');
  },
);
it('aborts and withholds an old tenant response after a committed scope switch', async () => {
  let complete: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  const fetcher = vi.fn().mockReturnValue(pending);
  vi.stubGlobal('fetch', fetcher);
  const view = render(<PublicControlReview {...props} />);
  click();
  const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
  view.rerender(<PublicControlReview {...props} tenantId="44444444-4444-4444-8444-444444444444" />);
  expect(signal.aborted).toBe(true);
  complete(Response.json(response()));
  await waitFor(() => expect(screen.queryByText(/Human review required · 46/)).toBeNull());
  expect(screen.queryByRole('alert')).toBeNull();
});
it('aborts on unmount and never performs a new read automatically', () => {
  const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<PublicControlReview {...props} />);
  click();
  const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['empty', 'declaration'])(
  'keeps %s evidence honest without inventing collection or compliance',
  async (mode) => {
    const value = response();
    if (mode === 'empty') {
      value.data.assessment.source.candidates = [];
      value.data.assessment.source.candidatesTruncated = true;
      value.data.assessment.source.pages[0]!.coverageReasons = ['candidate_limit'];
    } else {
      const candidate = value.data.assessment.source.candidates[0]!;
      candidate.kind = 'public_declaration';
      candidate.context = 'quoted';
      candidate.excerpt = 'Privacy policy statement; implementation unverified.';
      delete candidate.staticControl;
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)));
    render(<PublicControlReview {...props} />);
    click();
    await screen.findByText(/Human review required · 46 controls/);
    if (mode === 'empty') {
      expect(screen.getByText(/No candidates retained/)).toBeTruthy();
      expect(
        screen.getByText(
          'Evidence candidates were capped; additional candidates remain unrecorded.',
        ),
      ).toBeTruthy();
    } else {
      expect(
        screen.getByText(/Public declaration; implementation unverified · Context: quoted/),
      ).toBeTruthy();
      expect(screen.queryByText(/Checked attribute:/)).toBeNull();
    }
  },
);
it('connects a qualified control disposition to its exact retained evidence ordinals', async () => {
  const value = response();
  value.data.assessment.source.candidates.push({
    ...value.data.assessment.source.candidates[0]!,
    ordinal: 2,
    kind: 'public_declaration',
    excerpt: 'A public consent statement; implementation unverified.',
  });
  const control = value.data.assessment.controls.find((c) => c.controlId === 'DPDPA-CNS-001')!;
  control.questions[0]!.evidence = {
    state: 'mixed_public_evidence',
    candidateOrdinals: [1, 2],
    requiresHumanReview: true,
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)));
  render(<PublicControlReview {...props} />);
  click();
  expect(
    await screen.findByText(
      'Public observations and declarations; further proof needed · Evidence #1, #2',
    ),
  ).toBeTruthy();
  expect(screen.getByText('A public consent statement; implementation unverified.')).toBeTruthy();
});

it('mounts human review only after verified evidence with current actor and review permission', async () => {
  const f = reviewFixture();
  const fetcher = vi.fn((url: string, _options?: RequestInit) =>
    Promise.resolve(
      Response.json(
        url.includes('/public-control-review-sets/current')
          ? { data: f.head }
          : {
              data: {
                assessment: f.assessment,
                catalogueManifestText: PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
                captureReceipt: '42',
              },
            },
      ),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<PublicControlReview {...props} actorId={f.operation.actorId} canReview />);
  click();
  await screen.findByRole('region', { name: 'Human control review' });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: 'Record human control review' })).toBeTruthy();
  expect(
    fetcher.mock.calls.every(
      ([, options]) => !options || (options as RequestInit).method !== 'POST',
    ),
  ).toBe(true);
});
