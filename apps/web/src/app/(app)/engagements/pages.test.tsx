import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
import EngagementsListPage from './page';
import EngagementDetailPage from './[id]/page';

const state = vi.hoisted(() => ({
  basis: 'recorded_assessment' as 'recorded_assessment' | 'scheduled_coverage' | 'unavailable',
  results: {} as Record<string, { data: unknown; error: Error | null }>,
  calls: [] as Array<[string, string, unknown]>,
  role: 'viewer' as UserRole,
  guards: [] as string[],
}));
vi.mock('@/lib/assessment-basis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/assessment-basis')>()),
  readAssessmentBases: async (_db: unknown, _tenant: string, ids: string[]) =>
    new Map([...ids, ''].map((id) => [id, state.basis])),
}));
vi.mock('@/lib/tenant-context', () => ({
  Capability: {
    POSTURE_READ: 'posture.read',
    ENGAGEMENT_CREATE: 'engagement.create',
    ASSESSMENT_RUN: 'assessment.run',
  },
  requireCapabilityContext: async (capability: string) => ({
    guard: state.guards.push(capability),
    tenantId: 'tenant-1',
    role: state.role,
    supabase: {
      from: (table: string) => {
        const result = () => state.results[table] ?? { data: [], error: null };
        const query = {
          select: () => query,
          eq: (field: string, value: unknown) => {
            state.calls.push([table, field, value]);
            return query;
          },
          order: () => query,
          // A detail read of a missing row returns null, not the list default.
          single: async () => state.results[table] ?? { data: null, error: null },
          maybeSingle: async () => result(),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
        };
        return query;
      },
    },
  }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

beforeEach(() => {
  state.basis = 'recorded_assessment';
  state.results = {};
  state.calls = [];
  state.guards = [];
  state.role = 'viewer';
});

it('offers assessment creation only to a creator with a verified current library', async () => {
  state.results.engagements = { data: [], error: null };
  state.results.control_libraries = { data: { version: '0.1.1' }, error: null };
  state.results.estates = { data: [], error: null };
  state.role = UserRole.OWNER;
  const owner = renderToStaticMarkup(await EngagementsListPage());
  expect(owner).toContain('Create assessment');
  expect(owner).toContain('published control library 0.1.1');
  expect(state.calls).toContainEqual(['control_libraries', 'status', 'published']);
  state.role = UserRole.VIEWER;
  const viewer = renderToStaticMarkup(await EngagementsListPage());
  expect(viewer).not.toContain('<form');
  expect(viewer).toContain('Ask an assessment owner to start one');
});

it('binds the engagement list to the active tenant and reports source failure', async () => {
  state.results.engagements = { data: [], error: null };
  expect(renderToStaticMarkup(await EngagementsListPage())).toContain('No engagements yet.');
  expect(state.calls).toContainEqual(['engagements', 'tenant_id', 'tenant-1']);
  state.results.engagements = { data: null, error: new Error('read failed') };
  const failed = renderToStaticMarkup(await EngagementsListPage());
  expect(failed).toContain('Engagement records are unavailable.');
  expect(failed).not.toContain('No engagements yet.');
});

it('refuses missing or inaccessible engagement detail within the tenant boundary', async () => {
  await expect(
    EngagementDetailPage({
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }),
    }),
  ).rejects.toThrow('NOT_FOUND');
  expect(state.calls).toContainEqual(['engagements', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['engagements', 'id', '00000000-0000-4000-8000-000000000001']);
  state.results.engagements = {
    data: null,
    error: Object.assign(new Error('not found'), { code: 'PGRST116' }),
  };
  await expect(
    EngagementDetailPage({
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000002' }),
    }),
  ).rejects.toThrow('NOT_FOUND');
  state.results.engagements = { data: null, error: new Error('read failed') };
  await expect(
    EngagementDetailPage({
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000003' }),
    }),
  ).rejects.toThrow('Engagement record is unavailable');
});

it('shows findings and plan query failures as unavailable for a recorded engagement', async () => {
  state.results.engagements = {
    data: {
      id: '00000000-0000-4000-8000-000000000004',
      title: 'Actual assessment',
      tenants: { name: 'Actual tenant' },
      library_version: '1',
      status: 'active',
      started_at: '2026-10-01T00:00:00Z',
      posture_score: 0.7,
      estimated_exposure_inr: 0,
    },
    error: null,
  };
  state.results.findings = { data: null, error: new Error('read failed') };
  state.results.remediation_plans = { data: null, error: new Error('read failed') };
  const view = renderToStaticMarkup(
    await EngagementDetailPage({
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000004' }),
    }),
  );
  expect(view).toContain('Actual assessment');
  expect(view).toContain('Remediation plans are unavailable.');
  expect(view).toContain('Findings are unavailable.');
  expect(view).not.toContain('No findings recorded');
  expect(state.calls).toContainEqual(['findings', 'tenant_id', 'tenant-1']);
  expect(state.calls).toContainEqual(['remediation_plans', 'tenant_id', 'tenant-1']);
});

it('guards the list and the detail with the capability that offers Engagements in the menu', async () => {
  await EngagementsListPage();
  state.results.engagements = { data: null, error: null };
  await expect(
    EngagementDetailPage({
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000005' }),
    }),
  ).rejects.toThrow('NOT_FOUND');
  expect(state.guards).toEqual(['assessment.run', 'assessment.run']);
});

for (const basis of ['scheduled_coverage', 'unavailable', 'recorded_assessment'] as const) {
  it(`filters list and detail calculations using ${basis} server provenance`, async () => {
    state.basis = basis;
    const engagement = {
      id: '00000000-0000-4000-8000-000000000004',
      title: 'Measured technical assessment',
      tenants: { name: 'Actual tenant' },
      library_version: '1',
      status: 'active',
      started_at: '2026-10-01T00:00:00Z',
      posture_score: 83,
      estimated_exposure_inr: 1234567,
    };
    state.results.engagements = { data: [engagement], error: null };
    const list = renderToStaticMarkup(await EngagementsListPage());
    state.results.engagements = { data: engagement, error: null };
    state.results.findings = {
      data: [
        {
          id: 'finding-1',
          control_id: 'DP-1',
          status: 'fail',
          score: 0.91,
          risk_points: 987654,
          rationale: 'Internal calculated exposure 987654',
        },
      ],
      error: null,
    };
    const detail = renderToStaticMarkup(
      await EngagementDetailPage({
        params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000004' }),
      }),
    );
    if (basis === 'recorded_assessment') {
      expect(list).toContain('83');
      expect(list).toContain('₹12.35 L');
      expect(detail).toContain('987654.0');
      expect(detail).toContain('Internal calculated exposure 987654');
    } else {
      expect(list).not.toContain('>83<');
      expect(list).not.toContain('₹12.35 L');
      expect(detail).not.toContain('Internal calculated exposure');
      expect(detail).not.toContain('987654');
      expect(detail).toContain('Unknown');
    }
  });
}

for (const id of ['not-a-uuid', '', '00000000-0000-4000-8000-000000000001x']) {
  it(`rejects malformed engagement ID ${JSON.stringify(id)} before querying`, async () => {
    await expect(EngagementDetailPage({ params: Promise.resolve({ id }) })).rejects.toThrow(
      'NOT_FOUND',
    );
    expect(state.guards).toEqual([]);
    expect(state.calls).toEqual([]);
  });
}
