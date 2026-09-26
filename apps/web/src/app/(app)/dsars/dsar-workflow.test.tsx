import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  actionBody,
  availableActions,
  deadlineLabel,
  intakeBody,
  postDsar,
  type DsarRow,
} from './dsar-workflow';
import { DsarClient } from './dsar-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const row: DsarRow = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'access',
  status: 'received',
  data_principal_name: null,
  data_principal_email: 'principal@example.test',
  data_principal_phone: null,
  identity_verified: false,
  identity_verification_method: null,
  due_by: '2026-10-01T12:00:00Z',
  received_at: '2026-09-01T12:00:00Z',
  completed_at: null,
  rejection_reason: null,
  notes: null,
};
const props = {
  tenantId: 'tenant-a',
  rows: [] as DsarRow[],
  canManage: true,
  loadError: null,
  hasMore: false,
  asOf: Date.parse('2026-10-02T00:00:00Z'),
};
const form = (values: Record<string, string>) => {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
};
afterEach(() => vi.unstubAllGlobals());

describe('rights request surface', () => {
  it('renders empty saved state without fabricated people, counts or ids', () => {
    const html = renderToStaticMarkup(<DsarClient {...props} />);
    expect(html).toContain('No rights requests recorded.');
    expect(html).not.toMatch(/Ananya|DSAR-2026|14 fulfilled|systems/);
  });
  it('distinguishes an unavailable read from an empty tenant', () => {
    const html = renderToStaticMarkup(
      <DsarClient {...props} canManage={false} loadError="Rights requests could not be loaded." />,
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('No rights requests recorded');
    expect(html).not.toContain('Record request');
  });
  it('renders actual IDs, statuses and overdue server deadlines without clamping', () => {
    const html = renderToStaticMarkup(<DsarClient {...props} rows={[row]} hasMore />);
    expect(html).toContain(row.id);
    expect(html).toContain('Overdue');
    expect(html).toContain('Not verified');
    expect(html).toContain('these counts are not tenant totals');
    expect(html).not.toContain('Start fulfilment');
  });
  it('does not render mutation controls for read-only memberships', () => {
    const html = renderToStaticMarkup(<DsarClient {...props} rows={[row]} canManage={false} />);
    expect(html).toContain('Read-only access');
    expect(html).not.toContain('Record identity verification');
    expect(html).not.toContain('Reject request');
  });
  it('gates fulfilment on recorded verification and refuses terminal transitions', () => {
    expect(availableActions(row)).toEqual(['verify', 'rejected']);
    expect(availableActions({ ...row, status: 'identity_verification' })).not.toContain(
      'in_fulfilment',
    );
    expect(
      availableActions({ ...row, status: 'identity_verification', identity_verified: true }),
    ).toEqual(['in_fulfilment', 'rejected', 'escalated']);
    expect(availableActions({ ...row, status: 'in_fulfilment' })).toEqual([
      'completed',
      'rejected',
      'escalated',
    ]);
    for (const status of ['completed', 'rejected', 'escalated'] as const)
      expect(availableActions({ ...row, status })).toEqual([]);
  });
  it('keeps overdue escalations visible but closes completed or rejected clocks', () => {
    expect(deadlineLabel({ ...row, status: 'escalated' }, props.asOf)).toBe('Overdue');
    expect(deadlineLabel({ ...row, status: 'completed' }, props.asOf)).toBe('Closed');
    expect(deadlineLabel({ ...row, status: 'rejected' }, props.asOf)).toBe('Closed');
    expect(deadlineLabel(row, Date.parse('2026-10-01T00:00:00Z'))).toBe('1 day(s) remaining');
  });
});

describe('rights workflow requests', () => {
  it('requires a contact and sends no user-owned clock, identity flag, or actor', () => {
    expect(() => intakeBody(form({ kind: 'access', principalEmail: '  ' }))).toThrow(
      'email or phone',
    );
    expect(
      intakeBody(
        form({
          kind: 'access',
          principalEmail: ' principal@example.test ',
          dueDays: '90',
          tenantId: 'other',
          receivedAt: 'yesterday',
        }),
      ),
    ).toEqual({
      kind: 'access',
      principalEmail: 'principal@example.test',
      principalPhone: undefined,
      principalName: undefined,
      notes: undefined,
      dueDays: 30,
    });
  });
  it('requires a bounded verification method, reason for rejection and completion evidence', () => {
    expect(() => actionBody('verify', form({ method: ' ' }))).toThrow('verification method');
    expect(actionBody('verify', form({ method: ' in-person check ' }))).toEqual({
      method: 'in-person check',
    });
    expect(() => actionBody('rejected', form({ note: ' ' }))).toThrow('reason');
    expect(() => actionBody('completed', form({ fulfilmentEvidenceId: 'not-a-uuid' }))).toThrow(
      'evidence UUID',
    );
    expect(
      actionBody('completed', form({ fulfilmentEvidenceId: row.id, note: 'Delivered' })),
    ).toEqual({ toStatus: 'completed', note: 'Delivered', fulfilmentEvidenceId: row.id });
    expect(actionBody('escalated', form({ fulfilmentEvidenceId: row.id }))).toEqual({
      toStatus: 'escalated',
      note: undefined,
      fulfilmentEvidenceId: undefined,
    });
  });
  it('pins mutations to the rendered tenant even if another tab changes the cookie', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { dsarId: row.id } }), { status: 201 }),
      );
    vi.stubGlobal('fetch', fetcher);
    expect(
      await postDsar(
        'tenant-a',
        `/${row.id}/verify`,
        { method: 'Verified offline' },
        'dsar-attempt',
      ),
    ).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(`/api/bff/v1/dsars/${row.id}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': 'tenant-a',
        'Idempotency-Key': 'dsar-attempt',
      },
      body: '{"method":"Verified offline"}',
    });
  });
  it('preserves BFF refusals and never interprets a malformed success as saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'fulfilment_evidence_not_found' } }), {
          status: 409,
        }),
      ),
    );
    expect(await postDsar('tenant-a', '', {}, 'dsar-attempt')).toEqual({
      ok: false,
      error: 'fulfilment_evidence_not_found',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    expect(await postDsar('tenant-a', '', {}, 'dsar-attempt')).toMatchObject({ ok: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    expect(await postDsar('tenant-a', '', {}, 'dsar-attempt')).toEqual({
      ok: false,
      error: 'http_503',
    });
  });
  it('does not automatically replay an uncertain write or expose transport details', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('private details'));
    vi.stubGlobal('fetch', fetcher);
    const result = await postDsar('tenant-a', '', {}, 'dsar-attempt');
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain('before retrying');
    expect(JSON.stringify(result)).not.toContain('private details');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
