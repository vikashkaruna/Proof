import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../../test/fake-postgrest.js';
vi.mock('@axiom/supabase', () => ({ createSupabaseAdmin: vi.fn() }));
import { GrantBrokerAuthority, type WriteApprovalVerifier } from './grant-authority.js';
import type { BrokerRequest } from './broker.js';

const NOW = 1_800_000_000_000;
const SPIFFE = 'spiffe://axiom.test/tenant-a/drishti';
const request: BrokerRequest = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  estateId: '22222222-2222-4222-8222-222222222222',
  connectorId: '33333333-3333-4333-8333-333333333333',
  correlationId: '44444444-4444-4444-8444-444444444444',
  scope: 'connector.read',
  workloadProof: 'svid',
};
const grant = (over: Record<string, unknown> = {}) => ({
  grantId: '55555555-5555-4555-8555-555555555555',
  workloadId: '66666666-6666-4666-8666-666666666666',
  agentName: 'drishti',
  spiffeId: SPIFFE,
  scope: 'connector.read',
  targetScopes: ['crm.read'],
  grantExpiresAt: new Date(NOW + 3_600_000).toISOString(),
  connectorVersion: 2,
  credentialId: '77777777-7777-4777-8777-777777777777',
  credentialRevision: 1,
  descriptorSha256: 'a'.repeat(64),
  endpointRef: 'crm_prod',
  targetBinding: 'production',
  grantType: 'client_credentials',
  ...over,
});
let fake: FakeDb;
let resolved: unknown;
let calls: Record<string, unknown>[];
const identity = { verify: vi.fn() };
beforeEach(() => {
  fake = createFakeDb();
  calls = [];
  resolved = grant();
  fake.onRpc('resolve_broker_grant', (args) => {
    calls.push(args);
    return resolved;
  });
  identity.verify.mockReset();
  identity.verify.mockResolvedValue({
    spiffeId: SPIFFE,
    trustDomain: 'axiom.test',
    audience: 'broker',
    expiresAt: NOW + 600_000,
    bundleRevision: 'r1',
  });
});
const authority = (approvals?: WriteApprovalVerifier) =>
  new GrantBrokerAuthority(identity, {
    client: () => fake.client as never,
    approvals,
    now: () => NOW,
  });

describe('GrantBrokerAuthority (W4.4)', () => {
  it('leases a live read grant for the verified workload, bounded by the earliest deadline', async () => {
    const lease = await authority().authorize(request);
    expect(lease).toMatchObject({
      grantId: grant().grantId,
      agentName: 'drishti',
      validUntil: NOW + 600_000,
    });
    expect(calls[0]).toMatchObject({
      p_spiffe_id: SPIFFE,
      p_scope: 'connector.read',
      p_estate_id: request.estateId,
    });
  });

  it('refuses when identity verification fails or no live grant resolves', async () => {
    identity.verify.mockRejectedValueOnce(new Error('refused'));
    expect(await authority().authorize(request)).toBeNull();
    resolved = null;
    expect(await authority().authorize(request)).toBeNull();
  });

  it('refuses a resolution for a different identity or a malformed row', async () => {
    resolved = grant({ spiffeId: 'spiffe://axiom.test/tenant-a/other' });
    expect(await authority().authorize(request)).toBeNull();
    resolved = { grantId: 'x' };
    expect(await authority().authorize(request)).toBeNull();
  });

  it('refuses read requests that carry approval material', async () => {
    expect(
      await authority().authorize({ ...request, approvalProof: 'p', actionId: grant().grantId }),
    ).toBeNull();
  });

  it('refuses writes without a configured approval verifier', async () => {
    resolved = grant({ agentName: 'karya', scope: 'connector.write' });
    const write = {
      ...request,
      scope: 'connector.write' as const,
      approvalProof: 'p',
      actionId: '88888888-8888-4888-8888-888888888888',
    };
    expect(await authority().authorize(write)).toBeNull();
  });

  it('leases a write only with a verified approval for the same action', async () => {
    resolved = grant({ agentName: 'karya', scope: 'connector.write' });
    const actionId = '88888888-8888-4888-8888-888888888888';
    const write = { ...request, scope: 'connector.write' as const, approvalProof: 'p', actionId };
    const approvals = {
      verify: vi
        .fn()
        .mockResolvedValue({ tokenId: grant().grantId, actionId, validUntil: NOW + 60_000 }),
    };
    const lease = await authority(approvals).authorize(write);
    expect(lease).toMatchObject({
      scope: 'connector.write',
      validUntil: NOW + 60_000,
      approval: { actionId },
    });
    approvals.verify.mockResolvedValue({
      tokenId: grant().grantId,
      actionId: grant().grantId,
      validUntil: NOW + 60_000,
    });
    expect(await authority(approvals).authorize(write)).toBeNull();
  });

  it('refuses an expired grant deadline', async () => {
    resolved = grant({ grantExpiresAt: new Date(NOW - 1).toISOString() });
    expect(await authority().authorize(request)).toBeNull();
  });

  it('re-resolves the grant on every stillCurrent check', async () => {
    const a = authority();
    const lease = (await a.authorize(request))!;
    expect(await a.stillCurrent(lease, request)).toBe(true);
    resolved = null; // revoked, expired, disabled or kill-switched
    expect(await a.stillCurrent(lease, request)).toBe(false);
    resolved = grant({ credentialRevision: 2 });
    expect(await a.stillCurrent(lease, request)).toBe(false);
    expect(calls).toHaveLength(4);
  });
});
