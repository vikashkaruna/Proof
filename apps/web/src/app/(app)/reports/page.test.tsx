// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
const state = vi.hoisted(() => ({
  role: 'admin' as string,
  internal: false,
  search: '',
  live: false,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: state.role,
    isAxiomInternal: state.internal,
    supabase: { rpc: () => ({ abortSignal: async () => ({ data: state.live, error: null }) }) },
  }),
}));
import ReportsPage from './page';
import { ReportProof, canOfferRelease } from './reports-client';
import { DossierViewerModal } from './dossier-viewer-modal';
import { detailSchema } from './report-contract';
beforeEach(() => {
  state.role = UserRole.ADMIN;
  state.internal = false;
  state.search = '';
  state.live = false;
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
it('shows closure dossiers to reporting managers and founder release to internal founders', async () => {
  state.role = UserRole.FOUNDER;
  state.internal = true;
  expect(renderToStaticMarkup(await ReportsPage())).toContain('Closure dossiers');
});
// Every report reader sees the Pramaan tab: managers to prepare dossiers, the
// internal founder to seal, and everyone else read-only, sealed dossiers only.
it.each([
  [UserRole.FOUNDER, true],
  [UserRole.FOUNDER, false],
  [UserRole.OWNER, false],
  [UserRole.ADMIN, false],
  [UserRole.AXIOM_ANALYST, true],
  [UserRole.APPROVER, false],
  [UserRole.REVIEWER, false],
  [UserRole.VIEWER, false],
  [UserRole.PARTNER, false],
])('renders the Pramaan tab for %s with internal=%s', async (role, internal) => {
  state.role = role;
  state.internal = internal;
  state.search = 'tab=pramaan';
  const html = renderToStaticMarkup(await ReportsPage());
  expect(html).toContain('Closure dossiers');
  expect(html).toContain('Working reports and registers');
});
it('gives a viewer no dossier preparation and no approval-history export', async () => {
  state.role = UserRole.VIEWER;
  state.search = 'tab=pramaan';
  const pramaan = renderToStaticMarkup(await ReportsPage());
  expect(pramaan).not.toContain('Prepare source-bound dossier');
  state.search = '';
  const working = renderToStaticMarkup(await ReportsPage());
  expect(working).not.toContain('Tenant Approval History Audit Export');
  expect(working).not.toContain('/api/bff/v1/approvals/export');
});
it('keeps the approval-history export for a role holding evidence.export', async () => {
  state.role = UserRole.OWNER;
  const html = renderToStaticMarkup(await ReportsPage());
  expect(html).toContain('Tenant Approval History Audit Export');
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
  expect(html).toContain('Source and version details');
  expect(html).toContain(`Content SHA-256: <code>${'a'.repeat(64)}</code>`);
  expect(html).toContain(`Released archive SHA-256: <code>${'b'.repeat(64)}</code>`);
  expect(html).toContain('Exact version: <code>actual-version</code>');
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
    <DossierViewerModal
      dossier={dossier}
      isOpen
      onClose={() => undefined}
      canRelease
      busy={false}
      onSeal={() => undefined}
      onDownload={() => undefined}
      onReconcile={() => undefined}
      onRetryMissing={() => undefined}
    />,
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
it('identifies the reports agent in the shared header and keeps the board workflow label static', async () => {
  const html = renderToStaticMarkup(await ReportsPage());
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const labels = [...doc.querySelectorAll('[data-testid="agent-label"]')];
  const related = doc.querySelector('header [data-testid="related-agents"]');
  expect(related?.textContent).toContain('prativedan');
  const board = labels.find((l) => l.closest('section[aria-label="Board report workflow"]'));
  expect(board?.getAttribute('data-agent')).toBe('prativedan');
  expect(board?.getAttribute('data-state')).toBe('idle');
});

it('shows the founder workspace link only after current live designation while preserving the report reader for other roles', async () => {
  for (const role of [UserRole.OWNER, UserRole.ADMIN, UserRole.REVIEWER, UserRole.VIEWER]) {
    state.role = role;
    state.internal = true;
    state.live = false;
    const view = renderToStaticMarkup(await ReportsPage());
    expect(view).not.toContain('href="/reports/founder-review"');
    expect(view).toContain('Loading recorded reports');
  }
  state.role = UserRole.FOUNDER;
  state.internal = true;
  state.live = false;
  expect(renderToStaticMarkup(await ReportsPage())).not.toContain('href="/reports/founder-review"');
  state.live = true;
  expect(renderToStaticMarkup(await ReportsPage())).toContain('href="/reports/founder-review"');
});

it('offers founder review based on live platform designation despite lower explicit tenant role', async () => {
  state.role = UserRole.VIEWER;
  state.internal = false;
  state.live = true;
  expect(renderToStaticMarkup(await ReportsPage())).toContain('href="/reports/founder-review"');
});
