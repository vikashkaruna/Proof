// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Capability, can, UserRole } from '@axiom/types';
import DiscoveryPage from './page';
import ClassificationPage from '../classification/page';

const state = vi.hoisted(() => ({
  role: 'owner' as UserRole,
  invoke: vi.fn(),
  required: [] as Capability[],
  reviews: [] as unknown[],
  range: vi.fn(),
  internal: false,
  workflow: vi.fn(),
}));
vi.mock('../public-source-workflow/source-workflow', () => ({
  PublicSourceWorkflow: (props: unknown) => {
    state.workflow(props);
    return <section aria-label="Public website workflow" />;
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/invoke-agent', () => ({
  invokeAgent: state.invoke,
  AgentInvocationError: class AgentInvocationError extends Error {},
}));
vi.mock('@/lib/tenant-context', async () => {
  const { Capability, can } = await import('@axiom/types');
  return {
    Capability,
    requireCapabilityContext: async (capability: Capability) => {
      state.required.push(capability);
      if (!can(capability, { role: state.role })) throw new Error('forbidden');
      return {
        tenantId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        isAxiomInternal: state.internal,
        role: state.role,
        supabase: {
          from: (table: string) => {
            const query = {
              select: () => query,
              eq: () => query,
              order: () => query,
              limit: () => query,
              range: (start: number, end: number) => {
                state.range(start, end);
                return query;
              },
              abortSignal: () => query,
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve({
                  data: table === 'classification_reviews' ? state.reviews : [],
                  error: null,
                }).then(resolve),
            };
            return query;
          },
        },
      };
    },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.invoke.mockReset();
  state.required = [];
  state.reviews = [];
  state.range.mockReset();
  state.workflow.mockReset();
  state.internal = false;
});

const assessmentRoles = Object.values(UserRole).filter((role) =>
  can(Capability.ASSESSMENT_RUN, { role }),
);

it.each(assessmentRoles)(
  'keeps activity pages readable with truthful preparation controls for %s',
  async (role) => {
    state.role = role;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const [page, empty] of [
      [DiscoveryPage, 'No discovery events recorded'],
      [ClassificationPage, 'No classification events recorded'],
    ] as const) {
      const view = render(await page());
      expect(screen.getByRole('region', { name: 'Public website workflow' })).toBeTruthy();
      expect(document.body.textContent).toContain(empty);
      expect(state.workflow).toHaveBeenLastCalledWith({
        tenantId: '11111111-1111-4111-8111-111111111111',
        actorId: '22222222-2222-4222-8222-222222222222',
        canReview:
          can(Capability.ASSESSMENT_RUN, { role }) &&
          ![UserRole.FOUNDER, UserRole.AXIOM_ANALYST].includes(role as 'founder' | 'axiom_analyst'),
        canInvoke:
          can(Capability.AGENT_INVOKE, { role }) &&
          ![UserRole.FOUNDER, UserRole.AXIOM_ANALYST].includes(role as 'founder' | 'axiom_analyst'),
      });
      view.unmount();
    }
    expect(state.invoke).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.required).toEqual([Capability.ASSESSMENT_RUN, Capability.ASSESSMENT_RUN]);
  },
);

it.each(Object.values(UserRole).filter((role) => !assessmentRoles.includes(role)))(
  'refuses both activity pages to %s, matching the menu that does not offer them',
  async (role) => {
    state.role = role;
    await expect(DiscoveryPage()).rejects.toThrow('forbidden');
    await expect(ClassificationPage()).rejects.toThrow('forbidden');
    expect(state.required).toEqual([Capability.ASSESSMENT_RUN, Capability.ASSESSMENT_RUN]);
  },
);

const humanReview = {
  id: '33333333-3333-4333-8333-333333333333',
  tenant_id: '11111111-1111-4111-8111-111111111111',
  system_id: 'human-declared-contact-page',
  resource_path: 'contact.email',
  sensitivity_level: 'public',
  detected_categories: ['contact'],
  confidence_score: 90,
  reviewed_by: '44444444-4444-4444-8444-444444444444',
  decision: 'confirmed',
  adjusted_sensitivity: null,
  justification: 'A person recorded this declared classification.',
  created_at: '2026-10-04T10:00:00Z',
};

it('renders fetched human review history and forwards only validated page inputs to the bounded query', async () => {
  state.role = UserRole.REVIEWER;
  state.reviews = [humanReview];
  render(await ClassificationPage({ searchParams: Promise.resolve({ reviewPage: '2' }) }));
  expect(
    screen.getByRole('heading', { name: 'human-declared-contact-page · contact.email' }),
  ).toBeTruthy();
  expect(screen.getByText(humanReview.justification)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Newer reviews' }).getAttribute('href')).toBe(
    '/classification?reviewPage=1',
  );
  expect(state.range).toHaveBeenCalledWith(50, 100);
  expect(state.invoke).not.toHaveBeenCalled();
});

it('never renders a returned foreign tenant review on the classification page', async () => {
  state.role = UserRole.OWNER;
  state.reviews = [{ ...humanReview, tenant_id: '22222222-2222-4222-8222-222222222222' }];
  render(await ClassificationPage());
  expect(screen.getByRole('alert').textContent).toContain('review history is unavailable');
  expect(
    screen.queryByRole('heading', { name: 'human-declared-contact-page · contact.email' }),
  ).toBeNull();
  expect(document.body.textContent).not.toContain(humanReview.justification);
});

it.each([UserRole.FOUNDER, UserRole.AXIOM_ANALYST])(
  'permits %s only with internal authority',
  async (role) => {
    state.role = role;
    state.internal = true;
    render(await DiscoveryPage());
    expect(state.workflow).toHaveBeenLastCalledWith(
      expect.objectContaining({ canInvoke: true, canReview: true }),
    );
  },
);

it('gives a reviewer structural review permission independently of agent invocation', async () => {
  state.role = UserRole.REVIEWER;
  render(await DiscoveryPage());
  expect(state.workflow).toHaveBeenLastCalledWith(
    expect.objectContaining({ canInvoke: false, canReview: true }),
  );
});
