import { afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAssessmentSnapshot } from './assessment-snapshot';

const tenantId = '11111111-1111-4111-8111-111111111111';
const engagementId = '22222222-2222-4222-8222-222222222222';
const snapshot = {
  tenantId,
  engagement: {
    id: engagementId,
    title: 'Saved review',
    libraryVersion: '0.1.1',
    status: 'active',
  },
  isSdf: false,
  exposureInr: null,
  controls: [],
  summary: { pass: 0, partial: 0, fail: 0, unassessed: 0 },
};
function client(token: string | null): SupabaseClient {
  return {
    auth: {
      getSession: async () => ({ data: { session: token ? { access_token: token } : null } }),
    },
  } as unknown as SupabaseClient;
}
afterEach(() => vi.unstubAllGlobals());

it('does not contact the BFF when there is no session token', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(await loadAssessmentSnapshot(client(null), tenantId)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it('binds the requested engagement and tenant in a no-store authenticated read', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(snapshot));
  vi.stubGlobal('fetch', fetcher);
  expect(await loadAssessmentSnapshot(client('session-token'), tenantId, engagementId)).toEqual(
    snapshot,
  );
  const [url, init] = fetcher.mock.calls[0]!;
  expect(new URL(url).searchParams.get('engagementId')).toBe(engagementId);
  expect(init.headers).toMatchObject({
    Authorization: 'Bearer session-token',
    'X-Tenant-Id': tenantId,
  });
  expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' });
});

it('refuses cross-tenant, wrong-engagement, malformed, and failed responses', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ ...snapshot, tenantId: '33333333-3333-4333-8333-333333333333' }),
    )
    .mockResolvedValueOnce(Response.json({ ...snapshot, engagement: null }))
    .mockResolvedValueOnce(Response.json({ ...snapshot, exposureInr: -1 }))
    .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  for (let attempt = 0; attempt < 4; attempt++) {
    expect(
      await loadAssessmentSnapshot(client('session-token'), tenantId, engagementId),
    ).toBeNull();
  }
});

it('treats transport errors as unavailable rather than saved findings', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
  expect(await loadAssessmentSnapshot(client('session-token'), tenantId)).toBeNull();
});

function unknownSnapshot() {
  return {
    ...snapshot,
    provenance: {
      status: 'caller_declared_unverified',
      runId: '33333333-3333-4333-8333-333333333333',
      libraryDigest: 'a'.repeat(64),
      estimates: 'provisional',
      applicability: {
        sdfSelfAttested: { value: null, provenance: 'unknown' },
        processesChildren: { value: null, provenance: 'unknown' },
        processesHealth: { value: null, provenance: 'unknown' },
      },
    },
    controls: [
      {
        id: 'UNKNOWN-CONTROL',
        name: 'Synthetic unknown control',
        domain: 'Fixture',
        cite: '',
        score: 30,
        scoreBand: 'fail',
        status: 'unknown',
        answerState: 'unknown',
        applicabilityState: 'unknown',
        answerCounts: { knownBooleanQuestions: 2, callerAffirmed: 0, callerDenied: 0, unknown: 2 },
        evidenceIds: [],
      },
    ],
    summary: { pass: 0, partial: 0, fail: 0, unassessed: 0, unknown: 1, not_applicable: 0 },
  };
}

it('preserves structured unknown state rather than promoting the numeric fail band', async () => {
  const response = unknownSnapshot();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)));
  const loaded = await loadAssessmentSnapshot(client('session-token'), tenantId, engagementId);
  expect(loaded).toEqual(response);
  expect(loaded?.controls[0]?.status).toBe('unknown');
  expect(loaded?.controls[0]?.scoreBand).toBe('fail');
  expect(loaded?.provenance?.applicability?.sdfSelfAttested.value).toBeNull();
});

it('refuses inconsistent or falsely verified structured readouts', async () => {
  const valid = unknownSnapshot();
  const invalid = [
    { ...valid, provenance: { ...valid.provenance, status: 'verified' } },
    { ...valid, provenance: { ...valid.provenance, runId: null } },
    { ...valid, provenance: { ...valid.provenance, estimates: 'confirmed' } },
    {
      ...valid,
      provenance: {
        ...valid.provenance,
        applicability: {
          ...valid.provenance.applicability,
          sdfSelfAttested: { value: false, provenance: 'unknown' },
        },
      },
    },
    {
      ...valid,
      controls: [
        {
          ...valid.controls[0],
          answerCounts: {
            ...valid.controls[0]!.answerCounts,
            unknown: 1,
          },
        },
      ],
    },
    { ...valid, controls: [{ ...valid.controls[0], status: 'fail' }] },
    {
      ...valid,
      controls: [
        { ...valid.controls[0], applicabilityState: 'caller_declared_not_applicable_unverified' },
      ],
    },
  ];
  for (const response of invalid) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)));
    expect(
      await loadAssessmentSnapshot(client('session-token'), tenantId, engagementId),
    ).toBeNull();
  }
});
