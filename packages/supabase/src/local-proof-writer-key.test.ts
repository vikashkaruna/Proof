import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintLocalPostgrestRoleKey } from './local-proof-writer-key';

function serviceKey(secret: string) {
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'service_role', iss: 'supabase', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

describe('local scoped PostgREST key', () => {
  it('mints a restricted role only from the actual service-key signing secret', () => {
    const service = serviceKey('local-test-signing-secret');
    expect(() =>
      mintLocalPostgrestRoleKey({
        role: 'statutory_proof_writer',
        jwtSecret: 'wrong-target-secret',
        serviceKey: service,
      }),
    ).toThrow(/does not match/);
    const minted = mintLocalPostgrestRoleKey({
      role: 'statutory_proof_writer',
      jwtSecret: 'local-test-signing-secret',
      serviceKey: service,
    });
    const [header, body, signature] = minted.split('.');
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')).role).toBe(
      'statutory_proof_writer',
    );
    expect(signature).toBe(
      createHmac('sha256', 'local-test-signing-secret')
        .update(`${header}.${body}`)
        .digest('base64url'),
    );
  });
});
