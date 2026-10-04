// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Capability, can, UserRole } from '@axiom/types';
import DiscoveryPage from './page';
import ClassificationPage from '../classification/page';

const state = vi.hoisted(() => ({ role: 'owner' as UserRole, invoke: vi.fn() }));
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
vi.mock('@/lib/tenant-context', async () => ({
  Capability: (await import('@axiom/types')).Capability,
  requireCapabilityContext: async () => ({
    tenantId: 'tenant-1',
    role: state.role,
    supabase: {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return query;
      },
    },
  }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.invoke.mockReset();
});

it.each([UserRole.FOUNDER, UserRole.OWNER, UserRole.AXIOM_ANALYST, UserRole.VIEWER])(
  'keeps activity pages readable with truthful preparation controls for %s',
  async (role) => {
    state.role = role;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const [page, guidance, unavailable, empty] of [
      [DiscoveryPage, 'Prepare discovery', 'discovery run form', 'No discovery events recorded'],
      [
        ClassificationPage,
        'Prepare classification',
        'classification run form',
        'No classification events recorded',
      ],
    ] as const) {
      const view = render(await page());
      expect(screen.getByRole('region', { name: guidance }).textContent).toContain(unavailable);
      expect(document.body.textContent).toContain('not yet available');
      expect(document.body.textContent).toContain(empty);
      expect(screen.queryByRole('button', { name: /Run Discovery|Run Classification/ })).toBeNull();
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      if (can(Capability.ESTATE_MANAGE, { role })) {
        expect(screen.getByRole('link', { name: /Review estate setup/ }).getAttribute('href')).toBe(
          '/estate/setup',
        );
        expect(document.body.textContent).toContain('Setup does not start');
      } else {
        expect(screen.queryByRole('link', { name: /Review estate setup/ })).toBeNull();
        expect(document.body.textContent).toContain('Ask an estate manager');
      }
      view.unmount();
    }
    expect(state.invoke).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
