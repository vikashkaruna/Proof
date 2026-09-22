import { request, type OutgoingHttpHeaders, type Server } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createLocalJWKSet } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteAssessmentServer } from './assessment-remote.js';
import { GoogleSchedulerIdentity, type SchedulerIdentity } from './scheduler-identity.js';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = {
  audience: 'https://controller.example.run.app',
  subject: '123456789012345678901',
  email: 'scheduler@synthetic.iam.gserviceaccount.com',
};
const key = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'current',
  alg: 'RS256',
  use: 'sig',
};
const id = (n: number) => `85850000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const job = { tenantId: id(1), jobId: id(2) };
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
function token() {
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const wire =
    encode({ alg: 'RS256', kid: 'current', typ: 'JWT' }) +
    '.' +
    encode({
      iss: 'https://accounts.google.com',
      sub: config.subject,
      aud: config.audience,
      email: config.email,
      email_verified: true,
      iat: now,
      exp: now + 300,
    });
  return (
    'Bearer ' +
    wire +
    '.' +
    sign('RSA-SHA256', Buffer.from(wire), pair.privateKey).toString('base64url')
  );
}
async function fixture(
  identity: SchedulerIdentity = new GoogleSchedulerIdentity(
    config,
    createLocalJWKSet({ keys: [key] }),
  ),
) {
  const controller = {
    run: vi.fn(async (_t: string, _j: string, _s?: AbortSignal) => ({
      status: 'unconfirmed' as const,
      cleanupConfirmed: null,
    })),
    reconcile: vi.fn(async () => ({ status: 'unconfirmed' as const, cleanupConfirmed: null })),
  };
  const scheduling = { reserve: vi.fn(async () => ({ jobs: [] })), acknowledge: vi.fn() };
  const server = createRemoteAssessmentServer({
    tls: 'platform',
    identity,
    controller,
    scheduling,
    deadlineMs: 1000,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listen failed');
  return { server, controller, scheduling, port: address.port };
}
function call(
  port: number,
  headers: OutgoingHttpHeaders | string[] = {},
  path = '/assessment/run',
  body: unknown = job,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: Array.isArray(headers)
          ? [
              'host',
              `127.0.0.1:${port}`,
              'content-type',
              'application/json',
              'content-length',
              String(Buffer.byteLength(encoded)),
              ...headers,
            ]
          : { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on('error', reject);
    req.end(encoded);
  });
}
describe('remote assessment controller boundary', () => {
  it('verifies a signed scheduler before dispatch and keeps poll separate from execution', async () => {
    const f = await fixture();
    expect((await call(f.port, { authorization: token() })).status).toBe(200);
    expect(f.controller.run).toHaveBeenCalledWith(job.tenantId, job.jobId, expect.any(AbortSignal));
    expect(
      (await call(f.port, { authorization: token() }, '/assessment/scheduling/poll', {})).status,
    ).toBe(200);
    expect(f.scheduling.reserve).toHaveBeenCalledTimes(1);
  });
  it.each(['absent', 'forwarded', 'unsigned', 'cookie', 'duplicate'])(
    'refuses unauthenticated/ambiguous requests before backend work',
    async (fault) => {
      const f = await fixture();
      const headers: OutgoingHttpHeaders = {};
      if (fault === 'forwarded') headers['x-serverless-authorization'] = token();
      if (fault === 'unsigned') headers.authorization = 'Bearer private-marker';
      if (fault === 'cookie') {
        headers.authorization = token();
        headers.cookie = 'session=private-marker';
      }
      const wireHeaders =
        fault === 'duplicate' ? ['Authorization', token(), 'Authorization', token()] : headers;
      const reply = await call(f.port, wireHeaders);
      expect(reply.status).toBe(503);
      expect(reply.body.includes('private-marker')).toBe(false);
      expect(f.controller.run).not.toHaveBeenCalled();
      expect(f.scheduling.reserve).not.toHaveBeenCalled();
    },
  );
  it('rejects private body fields after identity verification without invoking controller', async () => {
    const f = await fixture();
    expect(
      (
        await call(f.port, { authorization: token() }, '/assessment/run', {
          ...job,
          input: 'private-marker',
        })
      ).status,
    ).toBe(503);
    expect(f.controller.run).not.toHaveBeenCalled();
  });
  it('holds the operation slot until real work settles after identity expiry', async () => {
    const f = await fixture({ authorize: async () => ({ expiresAt: Date.now() + 100 }) });
    let release: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    f.controller.run.mockImplementation(async (_t, _j, s) => {
      signal = s;
      await new Promise<void>((resolve) => (release = resolve));
      return { status: 'unconfirmed', cleanupConfirmed: null };
    });
    expect((await call(f.port, { authorization: 'Bearer synthetic' })).status).toBe(503);
    expect(signal?.aborted).toBe(true);
    expect((await call(f.port, { authorization: 'Bearer synthetic' })).status).toBe(503);
    expect(f.controller.run).toHaveBeenCalledTimes(1);
    release!();
  });
  it('refuses an already expired identity before even polling', async () => {
    const f = await fixture({ authorize: async () => ({ expiresAt: Date.now() - 1 }) });
    expect(
      (await call(f.port, { authorization: 'Bearer synthetic' }, '/assessment/scheduling/poll', {}))
        .status,
    ).toBe(503);
    expect(f.scheduling.reserve).not.toHaveBeenCalled();
  });
});
