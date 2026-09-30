import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
const state = vi.hoisted(() => ({ role: 'admin' as string, internal: false }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    tenantId: '11111111-1111-4111-8111-111111111111',
    role: state.role,
    isAxiomInternal: state.internal,
  }),
}));
import ReportsPage from './page';
import { ReportProof, canOfferRelease } from './reports-client';
import { DossierViewerModal } from './dossier-viewer-modal';
import { detailSchema } from './report-contract';
beforeEach(() => {
  state.role = UserRole.ADMIN;
  state.internal = false;
});
it('refuses an agent and presents no mutation or fake output to a viewer', async () => {
  state.role = UserRole.AGENT;
  expect(renderToStaticMarkup(await ReportsPage())).toContain('Your role cannot view reports');
  state.role = UserRole.VIEWER;
  const html = renderToStaticMarkup(await ReportsPage());
  expect(html).toContain('Loading recorded reports');
  expect(html).not.toContain('Prepare pack for review');
  expect(html).not.toContain('Request board draft');
  expect(html).not.toContain('No reports recorded');
  expect(html).not.toContain('cryptographicSignature');
  expect(html).not.toContain('74');
  expect(html).not.toContain('Historical dossiers');
});
it('shows historical dossier inspection only to an internal founder', async () => {
  state.role = UserRole.FOUNDER;
  state.internal = true;
  expect(renderToStaticMarkup(await ReportsPage())).toContain('Historical dossiers');
});
it('gives managers a real evidence selector and explicit preparation acknowledgement', async () => {
  const html = renderToStaticMarkup(await ReportsPage());
  expect(html).toContain('Loading available evidence');
  expect(html).toContain('Request from a finalized assessment');
  expect(html).toContain('Loading board requests');
  expect(html).toContain('Assessment-derived auditor review packs');
  expect(html).toContain('Loading auditor requests');
  expect(html).toContain('authorize preparing this immutable pack');
  expect(html).not.toContain('Approve reviewed content');
  expect(html).not.toContain('Release reviewed report');
});
it('escapes saved report content and preserves honest legacy assurance', () => {
  const report = detailSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'board',
    title: '<script>alert(1)</script>',
    engagementId: null,
    libraryVersion: 'v1',
    status: 'published',
    generatedAt: '2026-09-27T00:00:00Z',
    generatedByAgent: 'synthetic',
    createdBy: null,
    contentHash: null,
    reviewedContentHash: null,
    review: null,
    publishedAt: '2026-09-27T00:00:00Z',
    releasedBy: null,
    releasedArchiveHash: null,
    assurance: 'legacy_unverified',
    pack: null,
    contentText: null,
    content: { text: '<img src=x onerror=alert(1)>' },
  });
  const html = renderToStaticMarkup(<ReportProof report={report} />);
  expect(html).toContain('Historical record');
  expect(html).toContain('does not establish a retained PDF or ZIP');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('Content SHA-256:');
});
it('shows named immutable review attribution and distinct content/archive hashes', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const report = detailSchema.parse({
    id,
    kind: 'evidence_pack',
    title: 'Human evidence',
    engagementId: null,
    libraryVersion: 'v1',
    status: 'published',
    generatedAt: '2026-09-27T00:00:00Z',
    generatedByAgent: 'evidence-pack-builder',
    createdBy: id,
    contentHash: 'a'.repeat(64),
    reviewedContentHash: 'a'.repeat(64),
    review: {
      id,
      decision: 'approved',
      reviewerId: id,
      reviewerName: 'Recorded Founder',
      reviewedAt: '2026-09-27T00:00:00Z',
      note: 'Reviewed actual contents',
      contentHash: 'a'.repeat(64),
    },
    publishedAt: '2026-09-27T00:00:00Z',
    releasedBy: id,
    releasedArchiveHash: 'b'.repeat(64),
    assurance: 'digest_bound',
    pack: {
      id,
      manifestHash: 'a'.repeat(64),
      memberCount: 1,
      totalMemberBytes: 10,
      build: null,
      archive: {
        id,
        versionId: 'actual-version',
        contentHash: 'b'.repeat(64),
        byteSize: 1000,
        lockMode: 'COMPLIANCE',
        retainUntil: '2033-09-27T00:00:00Z',
        readbackAt: '2026-09-27T00:00:00Z',
        legalHold: false,
        encryption: 'AES256',
      },
    },
    contentText: '{"members":[]}',
  });
  const html = renderToStaticMarkup(<ReportProof report={report} />);
  expect(html).toContain('approved by Recorded Founder');
  expect(html).toContain(`Content SHA-256: ${'a'.repeat(64)}`);
  expect(html).toContain(`Released archive SHA-256: ${'b'.repeat(64)}`);
  expect(html).toContain('Exact version: actual-version');
  expect(html).not.toContain('signature');
});

it('preserves custom release while refusing board release without a retained PDF', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const reviewed = detailSchema.parse({
    id,
    kind: 'board',
    title: 'Reviewed board report',
    engagementId: id,
    libraryVersion: 'v1',
    status: 'approved',
    generatedAt: '2026-09-30T00:00:00Z',
    generatedByAgent: 'board-report-builder',
    createdBy: id,
    contentHash: 'a'.repeat(64),
    reviewedContentHash: 'a'.repeat(64),
    review: null,
    publishedAt: null,
    releasedBy: null,
    releasedArchiveHash: null,
    assurance: 'digest_bound',
    pack: null,
    contentText: '{}',
  });
  expect(canOfferRelease(reviewed)).toBe(false);
  expect(canOfferRelease({ ...reviewed, kind: 'custom' })).toBe(true);
});

it('shows legacy dossier metadata without an unsupported proof or action', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const dossier = {
    id,
    tenantId: id,
    engagementId: id,
    reportId: null,
    dossierType: 'board_executive' as const,
    title: 'Historical board dossier',
    status: 'sealed' as const,
    merkleRoot: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    archiveHash: null,
    archiveBytes: null,
    proofSealHash: 'c'.repeat(64),
    sealedAt: '2026-09-27T00:00:00Z',
    sealedBy: id,
    metadata: {},
    createdAt: '2026-09-27T00:00:00Z',
    updatedAt: '2026-09-27T00:00:00Z',
  };
  const html = renderToStaticMarkup(
    <DossierViewerModal dossier={dossier} isOpen onClose={() => undefined} />,
  );
  expect(html).toContain('Historical dossier record');
  expect(html).toContain('Recorded status');
  expect(html).toContain('does not establish a verified source');
  expect(html).not.toContain('Gold ProofSeal');
  expect(html).not.toContain('WORM SEALED');
  expect(html).not.toContain('92 / 100');
  expect(html).not.toContain('Synthesize');
  expect(html).not.toContain('Affix');
  expect(html).not.toContain('Download');
  expect(html).not.toContain('Send via Email');
});

it('offers an honest assessment-derived auditor pack while keeping unsupported formats unavailable', async () => {
  const html = renderToStaticMarkup(await ReportsPage());
  expect(html).toContain('Request from finalized assessment below');
  expect(html).toContain('not an independent audit or evidence attestation');
  expect(html).toContain('Release unavailable');
  expect(html).not.toContain('independent attestation');
  expect(html).not.toContain('Full sequence of automated mutations');
});
