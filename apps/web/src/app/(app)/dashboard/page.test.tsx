import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DashboardPage from './page';

type Result = { data?: unknown; count?: number | null; error?: Error | null };
const state = vi.hoisted(() => ({
  basis: 'recorded_assessment' as 'recorded_assessment' | 'scheduled_coverage' | 'unavailable',
  results: {} as Record<string, Result>,
  role: 'owner' as string,
  from: vi.fn(),
}));
vi.mock('@/lib/assessment-basis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/assessment-basis')>()),
  readAssessmentBases: async (_db: unknown, _tenant: string, ids: string[]) =>
    new Map([...ids, ''].map((id) => [id, state.basis])),
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
  state.basis = 'recorded_assessment';
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

afterEach(() => vi.restoreAllMocks());

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
  // Raw engagement scores do not establish finalized assessment provenance.
  expect(view).toMatch(
    /<span class="text-white" data-testid="posture-value">83<\/span><span class="text-\[0\.5em\] font-medium">\/100<\/span>/,
  );
  expect(view).toContain('data-testid="posture-provenance">Unverified<');
  expect(view).not.toContain('data-testid="posture-band"');
  expect(view).toContain('Not a compliance certification.');
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

it.each([0.83, 0.74, 0.5, 0.2])(
  'shows a recorded score of %s without an unsupported strength band',
  async (score) => {
    state.results.engagements = { data: { posture_score: score }, error: null };
    const view = await html();
    expect(view).toContain('data-testid="posture-value"');
    expect(view).toContain('data-testid="posture-provenance">Unverified<');
    expect(view).not.toContain('data-testid="posture-band"');
    expect(view).toContain('finalized source provenance is unverified here');
  },
);

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
  expect(view).toContain('Available workflow steps');
  expect(view).toContain('1. Set up the estate');
  expect(view).toContain('6. Review reports');
  expect(view).toContain('Current compliance review');
  expect(view).toContain('Recorded status: awaiting approval');
  expect(view).toContain('href="/engagements/engagement-1"');
});

it('limits the viewer workflow to read-only evidence, reports and ledger destinations', async () => {
  state.role = 'viewer';
  const view = await html();
  for (const route of ['/plans', '/reports', '/evidence', '/ledger'])
    expect(view).toContain(`href="${route}"`);
  for (const route of ['/estate', '/assessment', '/approval', '/execution', '/engagements'])
    expect(view).not.toContain(`href="${route}"`);
  expect(view).not.toContain('aria-label="Latest assessment"');
  expect(view).toContain('Read working reports and their recorded review and release status.');
  expect(view).not.toContain('Prepare working reports');
  expect(view).not.toContain('Verify chain integrity in the ledger');
  expect(view).toContain('3. Review the plan');
  expect(view).toContain('6. Review reports');
  expect(view).toContain('Numbers mark the shared workflow order');
});

it('describes reviewer inspection without advertising estate, assessment or report mutations', async () => {
  state.role = 'reviewer';
  const view = await html();
  expect(view).toContain('1. Inspect the estate');
  expect(view).toContain('2. Inspect the assessment');
  expect(view).toContain('Read control results and the recorded assessment status.');
  expect(view).toContain('Read working reports and their recorded review and release status.');
  expect(view).not.toContain('Set up the estate');
  expect(view).not.toContain('Prepare an assessment request');
  expect(view).not.toContain('Prepare working reports');
  state.role = 'owner';
  const owner = await html();
  expect(owner).toContain('1. Set up the estate');
  expect(owner).toContain('Prepare an assessment request');
  expect(owner).toContain('Prepare working reports');
});

it('distinguishes a missing assessment from an unavailable assessment', async () => {
  expect(await html()).toContain('No assessment recorded yet.');
  state.results.engagements = { data: null, error: new Error('unavailable') };
  expect(await html()).toContain('Assessment records are unavailable.');
  expect(await html()).not.toContain('No assessment recorded yet.');
});

it('qualifies stalled queued and running history without rewriting recorded outcomes', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-19T00:00:00Z'));
  state.results.agent_runs = {
    data: [
      {
        id: 'old-running',
        agent: 'drishti',
        status: 'running',
        started_at: '2026-10-11T00:00:00Z',
      },
      { id: 'old-queued', agent: 'nazar', status: 'queued', started_at: '2026-10-11T00:00:00Z' },
      { id: 'recent', agent: 'sudhaar', status: 'running', started_at: '2026-10-18T23:30:00Z' },
      { id: 'finished', agent: 'saakshi', status: 'succeeded', started_at: '2026-10-11T00:00:00Z' },
    ],
    error: null,
  };
  const view = await html();
  expect((view.match(/>Stalled</g) ?? []).length).toBe(2);
  expect(view).toContain('Recorded running;');
  expect(view).toContain('Recorded queued;');
  expect(view).toContain('one-hour activity window');
  expect((view.match(/>running</g) ?? []).length).toBe(1);
  expect(view).toContain('>succeeded<');
});

it('does not label a run active when its start timestamp is unknown', async () => {
  state.results.agent_runs = {
    data: [{ id: 'unknown', agent: 'nazar', status: 'queued', started_at: 'invalid' }],
    error: null,
  };
  const view = await html();
  expect(view).toContain('Activity unverified');
  expect(view).toContain('the start timestamp cannot establish current activity.');
});

for (const basis of ['scheduled_coverage', 'unavailable'] as const) {
  it(`withholds dashboard posture for ${basis} provenance`, async () => {
    state.basis = basis;
    state.results.engagements = {
      data: { id: 'eng-1', status: 'active', posture_score: 93 },
      error: null,
    };
    const view = await html();
    expect(view).not.toContain('data-testid="posture-value"');
    expect(view).toContain('No verified posture score is available.');
  });
}
