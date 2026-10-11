import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { UserRole, type WorkflowRecord } from '@axiom/types';
import { policyPreviewRoutes } from './policy-preview.js';
import { composePolicyPreview } from '../services/policy-preview.js';
import type { Variables } from '../types.js';
import type { EvidenceDatabase } from '../services/evidence-ingestion.js';
const tenant = '99111000-0000-4000-8000-000000000001',
  actor = '99111000-0000-4000-8000-000000000002',
  id = '99111000-0000-4000-8000-000000000003';
const source: WorkflowRecord = {
  id,
  tenant_id: tenant,
  operation_key: id,
  kind: 'ropa',
  created_by: actor,
  created_at: '2026-10-05T00:00:00Z',
  receipt_id: '211',
  content_sha256: null,
  payload: {
    engagementId: null,
    sourceNote: 'Human capture',
    system: 'Contact form',
    purpose: null,
    legalBasis: null,
    retentionMonths: null,
    dataCategories: null,
    dataPrincipals: null,
    processors: null,
    recipients: null,
    destinationCountries: null,
    transferSafeguards: null,
    dpiaRequired: null,
    region: null,
    crossBorder: null,
    securityMeasures: null,
  },
};
let returned: unknown, error: unknown;
const rpc = vi.fn();
beforeEach(() => {
  returned = { data: source };
  error = null;
  rpc
    .mockReset()
    .mockImplementation(() => ({ abortSignal: async () => ({ data: returned, error }) }));
});
function app() {
  const a = new Hono<{ Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', { id: actor } as never);
    c.set('role', UserRole.VIEWER);
    c.set('tenantId', tenant);
    await next();
  });
  a.route('/v1', policyPreviewRoutes({ writer: { rpc } as Pick<EvidenceDatabase, 'rpc'> }));
  return a;
}
it.each(['privacy_notice', 'consent_notice', 'retention', 'dpa_template'] as const)(
  'generates %s only from a retained activity and carries unknown facts through',
  async (category) => {
    const response = await app().request(
      `/v1/operator-workflows/policy-preview?ropaId=${id}&category=${category}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = (await response.json()) as { data: ReturnType<typeof composePolicyPreview> };
    expect(result.data).toMatchObject({ category, sourceRopaId: id, engagementId: null });
    expect(result.data.content).toContain('Unknown — authorised human confirmation required');
    expect(result.data.content).not.toContain('ap-south-1');
    expect(result.data.content).toContain('UNPUBLISHED');
    expect(result.data.content).toContain('Human audit receipt: 211');
    expect(rpc).toHaveBeenCalledWith('read_operator_workflow', {
      p_tenant_id: tenant,
      p_actor_id: actor,
      p_record_id: id,
    });
  },
);
it('preserves confirmed false and zero-length declared lists without silently converting them to unknown', () => {
  const result = composePolicyPreview(
    {
      ...source,
      payload: { ...source.payload, crossBorder: false, processors: [], retentionMonths: 12 },
    },
    'retention',
  );
  expect(result.content).toContain('Human recorded no');
  expect(result.content).toContain('Human recorded none');
  expect(result.content).toContain('12 months');
});
it.each([
  { tenant_id: actor },
  { id: actor },
  {
    kind: 'delivery_task',
    payload: {
      engagementId: null,
      taskName: 'Other',
      source: 'Manual',
      durationMinutes: 2,
      repetitions: 1,
      notes: '',
    },
  },
])('rejects foreign or mismatched processing sources', async (patch) => {
  returned = { data: { ...source, ...patch } };
  const response = await app().request(
    `/v1/operator-workflows/policy-preview?ropaId=${id}&category=privacy_notice`,
  );
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('Contact form');
});
it.each([
  `ropaId=${id}&category=unknown`,
  `ropaId=${id}&category=privacy_notice&category=retention`,
  `ropaId=${id}&category=privacy_notice&tenant=${actor}`,
])('rejects ambiguous or invented parameters before a provider call', async (query) => {
  expect((await app().request(`/v1/operator-workflows/policy-preview?${query}`)).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});
it('does not hide a provider outage as a generated empty draft', async () => {
  error = { message: 'unavailable' };
  expect(
    (
      await app().request(
        `/v1/operator-workflows/policy-preview?ropaId=${id}&category=privacy_notice`,
      )
    ).status,
  ).toBe(503);
});
it('refuses a fabricated source without a human receipt', async () => {
  returned = { data: { ...source, receipt_id: '0' } };
  expect(
    (
      await app().request(
        `/v1/operator-workflows/policy-preview?ropaId=${id}&category=privacy_notice`,
      )
    ).status,
  ).toBe(404);
});

it.each([
  ['forbidden', 403],
  ['context_refused', 404],
  ['source_refused', 404],
  ['record_not_found', 404],
] as const)('preserves the %s refusal without synthesising a draft', async (code, status) => {
  returned = { error: code };
  const response = await app().request(
    `/v1/operator-workflows/policy-preview?ropaId=${id}&category=privacy_notice`,
  );
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: { code } });
});

it('bounds long Unicode source notes without creating an invalid surrogate', () => {
  const result = composePolicyPreview(
    { ...source, payload: { ...source.payload, sourceNote: '😀'.repeat(999) } },
    'privacy_notice',
  );
  expect(result.sourceNote.length).toBeLessThanOrEqual(2000);
  expect(
    Array.from(result.sourceNote).every((c) => {
      const n = c.codePointAt(0)!;
      return n < 0xd800 || n > 0xdfff;
    }),
  ).toBe(true);
  expect(result.content).toContain('😀'.repeat(999));
});
