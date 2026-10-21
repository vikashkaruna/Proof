import { describe, expect, it } from 'vitest';
import { isLivePlatformFounder } from './platform-founder.js';
import { actor, evidenceFixture } from '../test/evidence-fixture.js';

describe('protected platform founder authority', () => {
  it('grants live internal designation without tenant membership', async () => {
    const f = evidenceFixture();
    f.rows('platform_founders').push({ user_id: actor, revoked_at: null });
    f.rows('users').push({ id: actor, is_axiom_internal: true });
    expect(await isLivePlatformFounder(f.db, actor)).toBe(true);
    expect(f.rows('tenant_users')).toEqual([]);
  });
  it.each(['absent', 'revoked', 'external', 'malformed', 'other actor'])(
    'refuses %s designation',
    async (state) => {
      const f = evidenceFixture();
      if (state !== 'absent')
        f.rows('platform_founders').push({
          user_id: state === 'other actor' ? '44444444-4444-4444-8444-444444444444' : actor,
          ...(state === 'malformed'
            ? {}
            : { revoked_at: state === 'revoked' ? '2026-10-20T00:00:00Z' : null }),
        });
      f.rows('users').push({ id: actor, is_axiom_internal: state !== 'external' });
      f.rows('tenant_users').push({ user_id: actor, role: 'founder' });
      expect(await isLivePlatformFounder(f.db, actor)).toBe(false);
    },
  );
  it('fails closed on unavailable designation storage', async () => {
    const f = evidenceFixture();
    f.faults.read = true;
    await expect(isLivePlatformFounder(f.db, actor)).rejects.toMatchObject({
      code: 'founder_authority_unavailable',
      status: 503,
    });
  });
});
