import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';

const state = vi.hoisted(() => ({
  role: 'admin' as string,
  data: [] as unknown[],
  error: null as unknown,
  thrown: false,
  filters: [] as unknown[][],
  limits: [] as number[],
  selects: [] as string[],
}));
vi.mock('@/lib/tenant-context', () => ({
  requireTenantContext: async () => ({
    tenantId: '11111111-1111-4111-8111-111111111111',
    role: state.role,
    supabase: {
      from: () => {
        const query = {
          select: (fields: string) => {
            state.selects.push(fields);
            return query;
          },
          eq: (...args: unknown[]) => {
            state.filters.push(args);
            return query;
          },
          order: () => query,
          limit: async (limit: number) => {
            state.limits.push(limit);
            if (state.thrown) throw new Error('private database details');
            return { data: state.data, error: state.error };
          },
        };
        return query;
      },
    },
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import DsarPage from './page';

const row = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'access',
  status: 'received',
  data_principal_name: null,
  data_principal_email: 'principal@example.test',
  data_principal_phone: null,
  identity_verified: false,
  identity_verification_method: null,
  due_by: '2026-10-01T12:00:00+00:00',
  received_at: '2026-09-01T12:00:00+00:00',
  completed_at: null,
  rejection_reason: null,
  notes: null,
};
beforeEach(() => {
  state.role = UserRole.ADMIN;
  state.data = [];
  state.error = null;
  state.thrown = false;
  state.filters = [];
  state.limits = [];
  state.selects = [];
});

describe('DSAR server page', () => {
  it('scopes user reads, selects explicit fields, and requests a truncation sentinel', async () => {
    const html = renderToStaticMarkup(await DsarPage());
    expect(state.filters).toEqual([['tenant_id', '11111111-1111-4111-8111-111111111111']]);
    expect(state.limits).toEqual([201]);
    expect(state.selects[0]).not.toContain('*');
    expect(html).toContain('No rights requests recorded.');
  });
  it('displays query errors and thrown outages without exposing private details or empty success', async () => {
    state.error = { message: 'private database details' };
    for (const thrown of [false, true]) {
      state.thrown = thrown;
      const html = renderToStaticMarkup(await DsarPage());
      expect(html).toContain('could not be loaded');
      expect(html).not.toContain('private database details');
      expect(html).not.toContain('No rights requests recorded');
      expect(html).not.toContain('Record request');
    }
  });
  it('fails closed on malformed persisted data rather than inventing defaults', async () => {
    state.data = [{ ...row, due_by: null }];
    expect(renderToStaticMarkup(await DsarPage())).toContain('could not be loaded');
  });
  it('reports truncation and only renders 200 recorded rows', async () => {
    state.data = Array.from({ length: 201 }, (_, index) => ({
      ...row,
      id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }));
    const html = renderToStaticMarkup(await DsarPage());
    expect(html).toContain('More requests exist');
    expect((html.match(/<section/g) ?? []).length).toBe(200);
  });
  it('does not query personal data for a role without read capability', async () => {
    state.role = UserRole.AGENT;
    const html = renderToStaticMarkup(await DsarPage());
    expect(state.selects).toEqual([]);
    expect(html).toContain('Your role cannot view');
  });
  it('renders a read-only analyst with actual data and no action controls', async () => {
    state.role = UserRole.AXIOM_ANALYST;
    state.data = [row];
    const html = renderToStaticMarkup(await DsarPage());
    expect(html).toContain(row.id);
    expect(html).toContain('Read-only access');
    expect(html).not.toContain('Record request');
  });
});
