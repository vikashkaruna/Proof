// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import PlanDetailPage from './page';

const plan = {
  id: 'plan-1',
  title: 'Close the retention gap',
  description: 'A rollbackable plan.',
  tenant_id: 'tenant-1',
  version: 1,
  status: 'draft',
  library_version: 'v1',
  created_at: '2026-10-01T00:00:00Z',
  aggregate_blast_radius: null,
  remediation_actions: [],
  tenants: { name: 'Acme' },
};
vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/tenant-context', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/tenant-context')>('@/lib/tenant-context');
  return {
    ...actual,
    requireCapabilityContext: async () => ({
      role: 'viewer',
      email: 'v@example.com',
      approvalScopes: [],
      isAxiomInternal: false,
      supabase: {
        from: () => {
          const q: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q;
          q.single = async () => ({ data: plan, error: null });
          q.maybeSingle = async () => ({ data: null, error: null });
          q.then = (r: (v: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(r);
          return q;
        },
      },
    }),
  };
});

it('names Sudhaar in the header with the static AgentLabel, not a running state', async () => {
  const html = renderToStaticMarkup(
    await PlanDetailPage({ params: Promise.resolve({ id: 'plan-1' }) }),
  );
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const label = doc.querySelector('[data-testid="agent-label"]');
  expect(label?.getAttribute('data-agent')).toBe('sudhaar');
  expect(label?.getAttribute('data-state')).toBe('idle');
});
