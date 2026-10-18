import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import DashboardPage from './page';

type Result = { data?: unknown; count?: number | null; error?: Error | null };
const state = vi.hoisted(() => ({
  results: {} as Record<string, Result>,
  role: 'owner' as string,
  from: vi.fn(),
}));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    tenantId: 'tenant-1',
    tenantName: 'Actual organization',
    role: state.role,
    supabase: { from: state.from },
  }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

beforeEach(() => {
  state.results = {};
  state.role = 'owner';
  state.from.mockReset().mockImplementation((table: string) => {
    const result = () => state.results[table] ?? { data: [], count: 0, error: null };
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => result(),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  });
});

async function html() {
  return renderToStaticMarkup(await DashboardPage());
}

it('shows zero recorded data without invented posture, evidence, agents, or legal countdown', async () => {
  const view = await html();
  expect(view).toContain('Actual organization');
  expect(view).toContain('No verified posture score is available.');
  expect(view).toContain('No agent runs recorded for this tenant.');
  expect(view).toContain('>0<');
  for (const fiction of [
    '1,284',
    '182k',
    '48,102',
    'Meridian',
    'Karya is waiting',
    '13 May 2027',
    '2 new signals',
    'dry-run ✓',
  ]) {
    expect(view).not.toContain(fiction);
  }
  expect(state.from).toHaveBeenCalledWith('consent_records');
});

it('distinguishes unavailable queries from zero counts', async () => {
  state.results.evidence = { data: null, count: null, error: new Error('read failed') };
  state.results.agent_runs = { data: null, error: new Error('read failed') };
  const view = await html();
  expect(view).toContain('Evidence records');
  expect(view).toContain('Unavailable');
  expect(view).toContain('Agent runs are unavailable.');
  expect(view).not.toContain('WORM · live from DB');
});

it('counts only recorded pending approvals and open findings', async () => {
  state.results.findings = {
    data: [
      { id: 'f1', status: 'open' },
      { id: 'f2', status: 'closed' },
    ],
    error: null,
  };
  state.results.remediation_actions = {
    data: [
      { id: 'a1', approval_status: 'awaiting_approval' },
      { id: 'a2', approval_status: 'draft' },
    ],
    error: null,
  };
  state.results.engagements = { data: { posture_score: 0.83 }, error: null };
  state.results.agent_runs = {
    data: [{ id: 'r1', agent: 'drishti', status: 'running', started_at: '2026-10-01T00:00:00Z' }],
    error: null,
  };
  const view = await html();
  expect(view).toContain('>83</span>');
  expect(view).toMatch(/Open findings<\/dt><dd[^>]*><span[^>]*>1<\/span>/);
  expect(view).toMatch(/Awaiting approval<\/dt><dd[^>]*><span[^>]*>1<\/span>/);
  // 83 is in the Good band: green score and a labelled chip, never gold.
  expect(view).toMatch(
    /<span class="text-green-300" data-testid="posture-value">83<\/span><span class="text-\[0\.5em\] font-medium">\/100<\/span>/,
  );
  expect(view).toMatch(/data-testid="posture-band">Good</);
  expect(view).toContain('drishti');
  expect(view).toContain('Actions need a recorded human decision');
  expect(view).not.toContain('executing task in ap-south-1');
});

it('renders the shared module context line under the title', async () => {
  const view = await html();
  expect(view).toContain('डैशबोर्ड');
  expect(view).toContain('P0');
  expect(view).not.toMatch(/<h1[^>]*>[^<]*डैशबोर्ड/);
});

it('makes the tenant name visible in the header and the title readable on the indigo band', async () => {
  const view = await html();
  expect(view).toMatch(/<h1[^>]*class="[^"]*text-white[^"]*"[^>]*>Dashboard<\/h1>/);
  expect(view).toContain('Actual organization');
});

it('shows only the record tiles for screens the persona is offered', async () => {
  state.role = 'viewer';
  const viewer = await html();
  // A viewer reads evidence and the ledger, but is not offered rights or
  // consent, so those tiles (and their links) are not on their dashboard.
  expect(viewer).toContain('href="/evidence"');
  expect(viewer).toContain('href="/ledger"');
  for (const label of ['DSAR records', 'Consent records']) expect(viewer).not.toContain(label);
  for (const route of ['/dsars', '/consent'])
    expect(viewer, route).not.toContain(`href="${route}"`);

  state.role = 'owner';
  const owner = await html();
  for (const route of ['/dsars', '/consent', '/evidence', '/ledger'])
    expect(owner, route).toContain(`href="${route}"`);
});

it.each([
  [0.74, 'text-teal-300', 'Moderate'],
  [0.5, 'text-amber-300', 'Weak'],
  [0.2, 'text-ember-300', 'Critical'],
])('colours a posture of %s by its band', async (score, tone, label) => {
  state.results.engagements = { data: { posture_score: score }, error: null };
  const view = await html();
  expect(view).toContain(`<span class="${tone}" data-testid="posture-value">`);
  expect(view).toContain(`data-testid="posture-band">${label}<`);
});

it('shows no band when the posture is unavailable', async () => {
  const view = await html();
  expect(view).not.toContain('data-testid="posture-band"');
});

it('guides operators through the workflow and links the latest recorded assessment', async () => {
  state.results.engagements = {
    data: {
      id: 'engagement-1',
      title: 'Current compliance review',
      status: 'awaiting_approval',
      posture_score: 0.74,
      started_at: '2026-10-01T00:00:00Z',
    },
    error: null,
  };
  const view = await html();
  expect(view).toContain('Your next steps');
  expect(view).toContain('1. Set up the estate');
  expect(view).toContain('6. Review reports');
  expect(view).toContain('Current compliance review');
  expect(view).toContain('Recorded status: awaiting approval');
  expect(view).toContain('href="/engagements/engagement-1"');
});

it('limits the viewer workflow to read-only evidence, reports and ledger destinations', async () => {
  state.role = 'viewer';
  const view = await html();
  for (const route of ['/reports', '/evidence', '/ledger'])
    expect(view).toContain(`href="${route}"`);
  for (const route of [
    '/estate',
    '/assessment',
    '/plans',
    '/approval',
    '/execution',
    '/engagements',
  ])
    expect(view).not.toContain(`href="${route}"`);
  expect(view).not.toContain('aria-label="Latest assessment"');
});

it('distinguishes a missing assessment from an unavailable assessment', async () => {
  expect(await html()).toContain('No assessment recorded yet.');
  state.results.engagements = { data: null, error: new Error('unavailable') };
  expect(await html()).toContain('Assessment records are unavailable.');
  expect(await html()).not.toContain('No assessment recorded yet.');
});
