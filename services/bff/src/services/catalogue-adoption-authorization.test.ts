import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueMfaChallengeRequestSchema } from '@axiom/types';
import {
  adoptMappingContextPublication,
  mappingContextSourcePacket,
  type MappingContextAdoptionBinding,
} from '@axiom/control-library';
import { createFakeDb } from '../test/fake-postgrest.js';
import { createMfaService } from './mfa.js';
import {
  CATALOGUE_ADOPTION_STEP_UP_MS,
  CatalogueAdoptionAuthorizationRefused,
  createCatalogueAdoptionAuthorizer,
} from './catalogue-adoption-authorization.js';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://local.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'a'.repeat(40);
  process.env.SUPABASE_SERVICE_KEY = 'b'.repeat(40);
  process.env.APPROVAL_SIGNING_KEY = 'k'.repeat(48);
});
const actor = '10000000-0000-4000-8000-000000000001';
const tenant = '20000000-0000-4000-8000-000000000001';
const session = '30000000-0000-4000-8000-000000000001';
const other = '40000000-0000-4000-8000-000000000001';
const binding: MappingContextAdoptionBinding = {
  actorId: actor,
  organisationId: tenant,
  sessionId: session,
  correlationId: other,
};
const packet = mappingContextSourcePacket();
const packetText = JSON.stringify(packet);
const packetSha256 = createHash('sha256').update(packetText).digest('hex');
const request = {
  operationKey: '50000000-0000-4000-8000-000000000001',
  publicationVersion: packet.publicationVersion,
  expectedPacketSha256: packetSha256,
  sectorPackCode: packet.contexts[0]!.sectorPackCode,
};
function fixture() {
  const db = createFakeDb({
    user_mfa_factors: [
      {
        id: other,
        user_id: actor,
        factor_type: 'totp',
        status: 'active',
      },
    ],
    mfa_challenges: [],
  });
  const mfa = createMfaService(() => db.client as never, { encryptionKey: 'k'.repeat(48) });
  const state = {
    session: {
      id: session,
      userId: actor,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      revokedAt: null as string | null,
    },
    user: { id: actor, isAxiomInternal: true },
    membership: { tenantId: tenant, userId: actor, role: 'founder' },
    globalStop: { scope: 'global', engaged: false },
    tenantStops: [] as { tenantId: string; engaged: boolean }[],
  };
  let text = JSON.stringify(request);
  const loadCurrentAuthority = vi.fn(async () => structuredClone(state));
  const loadReviewedRequestText = vi.fn(async () => text);
  const authority = createCatalogueAdoptionAuthorizer({
    mfa,
    loadCurrentAuthority,
    loadReviewedRequestText,
  });
  const consume = vi.spyOn(mfa, 'consumeChallenge');
  async function issued() {
    const result = await authority.issue(binding);
    const row = db.rows('mfa_challenges').find((r) => r['id'] === result.challengeId)!;
    // Model the MFA verifier's retained result, rather than pretending consumption
    // succeeds. Existing RFC/TOTP suites separately exercise factor verification.
    row['satisfied_at'] = new Date().toISOString();
    row['consumed_at'] = null;
    return { result, row };
  }
  return {
    db,
    state,
    mfa,
    authority,
    issued,
    consume,
    loadCurrentAuthority,
    loadReviewedRequestText,
    setText: (v: string) => {
      text = v;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T05:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});
describe('unmounted catalogue adoption authorization', () => {
  it('issues a short dedicated bound challenge and consumes exactly once for repeated checks', async () => {
    const f = fixture();
    const { result, row } = await f.issued();
    expect(row).toMatchObject({
      purpose: 'catalogue_adoption',
      tenant_id: tenant,
      user_id: actor,
      bound_resource_ref: request.operationKey,
    });
    expect(Date.parse(result.expiresAt) - Date.now()).toBe(CATALOGUE_ADOPTION_STEP_UP_MS);
    expect(row['bound_payload_sha256']).toMatch(/^[0-9a-f]{64}$/);
    const grant = await f.authority.consume(binding, result.challengeId);
    const expiry = grant.expiresAt;
    for (let i = 0; i < 4; i++)
      expect(await grant.authorizeCurrentHuman(binding)).toEqual({
        binding,
        reviewedRequestText: JSON.stringify(request),
      });
    expect(f.consume).toHaveBeenCalledTimes(1);
    expect(grant.expiresAt).toBe(expiry);
    await expect(f.authority.consume(binding, result.challengeId)).rejects.toBeInstanceOf(
      CatalogueAdoptionAuthorizationRefused,
    );
  });
  it.each([
    'role',
    'internal',
    'session-expired',
    'session-revoked',
    'session-id',
    'session-actor',
    'user-id',
    'membership-actor',
    'tenant',
    'global-stop',
    'tenant-stop',
    'unknown-stop',
    'factor',
  ])('refuses %s before issuing or consuming MFA', async (fault) => {
    const f = fixture();
    if (fault === 'role') f.state.membership.role = 'owner';
    if (fault === 'internal') f.state.user.isAxiomInternal = false;
    if (fault === 'session-expired') f.state.session.expiresAt = new Date(Date.now()).toISOString();
    if (fault === 'session-revoked') f.state.session.revokedAt = new Date().toISOString();
    if (fault === 'session-id') f.state.session.id = other;
    if (fault === 'session-actor') f.state.session.userId = other;
    if (fault === 'user-id') f.state.user.id = other;
    if (fault === 'membership-actor') f.state.membership.userId = other;
    if (fault === 'tenant') f.state.membership.tenantId = other;
    if (fault === 'global-stop') f.state.globalStop.engaged = true;
    if (fault === 'tenant-stop') f.state.tenantStops.push({ tenantId: tenant, engaged: true });
    if (fault === 'unknown-stop') f.loadCurrentAuthority.mockResolvedValue(null as never);
    if (fault === 'factor') f.db.rows('user_mfa_factors')[0]!['status'] = 'revoked';
    await expect(f.authority.issue(binding)).rejects.toBeInstanceOf(
      CatalogueAdoptionAuthorizationRefused,
    );
    expect(f.db.rows('mfa_challenges')).toHaveLength(0);
    expect(f.consume).not.toHaveBeenCalled();
  });
  it.each([
    'actor',
    'session',
    'tenant',
    'purpose',
    'operation',
    'version',
    'hash',
    'sector',
    'bytes',
    'unsatisfied',
    'expired',
  ])('cannot spend challenge after changing %s', async (fault) => {
    const f = fixture();
    const { result, row } = await f.issued();
    const nextBinding = { ...binding };
    if (fault === 'actor') row['user_id'] = other;
    if (fault === 'session') nextBinding.sessionId = f.state.session.id = other;
    if (fault === 'tenant') nextBinding.organisationId = f.state.membership.tenantId = other;
    if (fault === 'purpose') row['purpose'] = 'approval_issuance';
    const changed = { ...request };
    if (fault === 'operation') changed.operationKey = other;
    if (fault === 'version') changed.publicationVersion = 'other-version';
    if (fault === 'hash') changed.expectedPacketSha256 = 'f'.repeat(64);
    if (fault === 'sector') changed.sectorPackCode = 'other-sector';
    if (['operation', 'version', 'hash', 'sector'].includes(fault))
      f.setText(JSON.stringify(changed));
    if (fault === 'bytes') f.setText(JSON.stringify(request, null, 2));
    if (fault === 'unsatisfied') row['satisfied_at'] = null;
    if (fault === 'expired') vi.advanceTimersByTime(CATALOGUE_ADOPTION_STEP_UP_MS);
    await expect(f.authority.consume(nextBinding, result.challengeId)).rejects.toBeInstanceOf(
      CatalogueAdoptionAuthorizationRefused,
    );
    expect(row['consumed_at']).toBeNull();
  });
  it('binds the retained challenge tenant independently of its digest', async () => {
    const f = fixture();
    const { result, row } = await f.issued();
    row['tenant_id'] = other;
    await expect(f.authority.consume(binding, result.challengeId)).rejects.toBeInstanceOf(
      CatalogueAdoptionAuthorizationRefused,
    );
    expect(row['consumed_at']).toBeNull();
  });
  it('one concurrent consumer wins and later checks never extend its original lifetime', async () => {
    const f = fixture();
    const { result } = await f.issued();
    const results = await Promise.allSettled([
      f.authority.consume(binding, result.challengeId),
      f.authority.consume(binding, result.challengeId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const grant = results.find((r) => r.status === 'fulfilled');
    if (grant?.status !== 'fulfilled') throw Error('no winner');
    vi.advanceTimersByTime(CATALOGUE_ADOPTION_STEP_UP_MS);
    await expect(grant.value.authorizeCurrentHuman(binding)).rejects.toBeInstanceOf(
      CatalogueAdoptionAuthorizationRefused,
    );
  });
  it.each(['internal', 'stop', 'review', 'binding', 'factor', 'session'])(
    'invalidates an already consumed handle after %s changes',
    async (fault) => {
      const f = fixture();
      const { result } = await f.issued();
      const grant = await f.authority.consume(binding, result.challengeId);
      let next = binding;
      if (fault === 'internal') f.state.user.isAxiomInternal = false;
      if (fault === 'stop') f.state.globalStop.engaged = true;
      if (fault === 'review') f.setText(JSON.stringify(request, null, 2));
      if (fault === 'binding') next = { ...binding, correlationId: actor };
      if (fault === 'factor') f.db.rows('user_mfa_factors')[0]!['status'] = 'revoked';
      if (fault === 'session') f.state.session.revokedAt = new Date().toISOString();
      await expect(grant.authorizeCurrentHuman(next)).rejects.toBeInstanceOf(
        CatalogueAdoptionAuthorizationRefused,
      );
      f.state.user.isAxiomInternal = true;
      f.state.globalStop.engaged = false;
      f.state.session.revokedAt = null;
      f.db.rows('user_mfa_factors')[0]!['status'] = 'active';
      f.setText(JSON.stringify(request));
      await expect(grant.authorizeCurrentHuman(binding)).rejects.toBeInstanceOf(
        CatalogueAdoptionAuthorizationRefused,
      );
      expect(f.consume).toHaveBeenCalledTimes(1);
    },
  );
  it('retains challenge expiry even when satisfaction and consumption happen later', async () => {
    const f = fixture();
    const { result, row } = await f.issued();
    vi.advanceTimersByTime(CATALOGUE_ADOPTION_STEP_UP_MS - 1000);
    row['satisfied_at'] = new Date().toISOString();
    const grant = await f.authority.consume(binding, result.challengeId);
    expect(grant.expiresAt).toBe(result.expiresAt);
    vi.advanceTimersByTime(1000);
    await expect(grant.authorizeCurrentHuman(binding)).rejects.toBeInstanceOf(
      CatalogueAdoptionAuthorizationRefused,
    );
  });
  it('refuses service-level unbound catalogue issuance without touching challenge rows', async () => {
    const f = fixture();
    await expect(
      f.mfa.issueChallenge({ userId: actor, tenantId: tenant, purpose: 'catalogue_adoption' }),
    ).rejects.toThrow('bounded reviewed source');
    expect(f.db.rows('mfa_challenges')).toHaveLength(0);
  });
  it('refuses a satisfied challenge when its original factor was replaced before consumption', async () => {
    const f = fixture();
    const { result, row } = await f.issued();
    f.db.rows('user_mfa_factors')[0]!['status'] = 'revoked';
    f.db.seed('user_mfa_factors', {
      id: request.operationKey,
      user_id: actor,
      factor_type: 'totp',
      status: 'active',
    });
    expect(await f.mfa.isEnrolled(actor)).toBe(true);
    await expect(f.authority.consume(binding, result.challengeId)).rejects.toBeInstanceOf(
      CatalogueAdoptionAuthorizationRefused,
    );
    expect(row['consumed_at']).toBeNull();
  });
  it('poisons a consumed handle when a different factor replaces its challenged factor', async () => {
    const f = fixture();
    const { result } = await f.issued();
    const grant = await f.authority.consume(binding, result.challengeId);
    f.db.rows('user_mfa_factors')[0]!['status'] = 'revoked';
    const replacement = f.db.seed('user_mfa_factors', {
      id: request.operationKey,
      user_id: actor,
      factor_type: 'totp',
      status: 'active',
    });
    expect(await f.mfa.isEnrolled(actor)).toBe(true);
    const adopt = vi.fn();
    const readPublication = vi.fn();
    const readProof = vi.fn();
    await expect(
      adoptMappingContextPublication(
        { readPublication, authorizeCurrentHuman: grant.authorizeCurrentHuman, adopt, readProof },
        binding,
        request,
      ),
    ).rejects.toMatchObject({ publicationMayHaveCommitted: false });
    expect(adopt).not.toHaveBeenCalled();
    expect(readPublication).not.toHaveBeenCalled();
    replacement['status'] = 'revoked';
    f.db.rows('user_mfa_factors')[0]!['status'] = 'active';
    await expect(grant.authorizeCurrentHuman(binding)).rejects.toBeInstanceOf(
      CatalogueAdoptionAuthorizationRefused,
    );
    expect(f.consume).toHaveBeenCalledTimes(1);
  });
  it('refuses duplicate JSON keys in server-retained review bytes', async () => {
    const f = fixture();
    f.setText('{"operationKey":"' + other + '",' + JSON.stringify(request).slice(1));
    await expect(f.authority.issue(binding)).rejects.toBeInstanceOf(
      CatalogueAdoptionAuthorizationRefused,
    );
    expect(f.db.rows('mfa_challenges')).toHaveLength(0);
  });
  it('does not let the generic HTTP challenge schema create this purpose unbound', () => {
    expect(
      IssueMfaChallengeRequestSchema.safeParse({ purpose: 'catalogue_adoption' }).success,
    ).toBe(false);
  });
  it('keeps catalogue mutation methods absent from the default reference router', async () => {
    const { createApp } = await import('../app.js');
    const routes = createApp({ ownedSynthetic: null }).routes.filter((r) =>
      r.path.includes('/control-catalogue/'),
    );
    expect(routes.map((r) => [r.method, r.path])).toEqual([
      ['GET', '/v1/control-catalogue/publications/:version'],
    ]);
  });
  it.each(['revoke-before-write', 'lost-acknowledgment'])(
    'orchestrator performs no unsafe write/retry on %s',
    async (fault) => {
      const f = fixture();
      const { result } = await f.issued();
      const grant = await f.authority.consume(binding, result.challengeId);
      const adopt = vi.fn(async () => {
        throw Error('lost acknowledgment');
      });
      const readProof = vi.fn();
      const readPublication = vi.fn(async () => {
        if (fault === 'revoke-before-write') f.state.user.isAxiomInternal = false;
        return {
          data: {
            publicationVersion: packet.publicationVersion,
            libraryVersion: packet.libraryVersion,
            contextCount: packet.contexts.length,
            packetText,
            packetSha256,
          },
          error: null,
        };
      });
      await expect(
        adoptMappingContextPublication(
          { readPublication, authorizeCurrentHuman: grant.authorizeCurrentHuman, adopt, readProof },
          binding,
          request,
        ),
      ).rejects.toMatchObject({ publicationMayHaveCommitted: fault === 'lost-acknowledgment' });
      expect(adopt).toHaveBeenCalledTimes(fault === 'lost-acknowledgment' ? 1 : 0);
      expect(readProof).not.toHaveBeenCalled();
    },
  );
});
