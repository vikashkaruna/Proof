import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AcquiredToken,
  OAuthGrantError,
  acquireOAuthToken,
  type OAuthProfile,
  type TokenEndpointTransport,
} from './oauth-grants.js';
const endpoint = 'https://reference-as.test.invalid/token';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsaKey = {
  algorithm: 'RS256' as const,
  keyId: 'registered-client-key',
  privateKeyPem: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};
const ecKey = {
  algorithm: 'ES256' as const,
  keyId: 'registered-issuer-key',
  privateKeyPem: ec.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};
const basicProfile = (): OAuthProfile => ({
  version: 1,
  grantType: 'client_credentials',
  tokenEndpoint: endpoint,
  clientAuth: {
    method: 'client_secret_basic',
    clientId: 'fixture:client',
    clientSecret: 'synthetic secret+with:characters',
  },
  allowedScopes: ['inventory.read', 'metadata.read'],
  maxTokenLifetimeSeconds: 300,
});
const privateProfile = (): OAuthProfile => ({
  ...basicProfile(),
  grantType: 'client_credentials',
  clientAuth: {
    method: 'private_key_jwt',
    clientId: 'fixture-client',
    audience: endpoint,
    signingKey: rsaKey,
  },
});
const encodeProfile = (value: unknown) => Buffer.from(JSON.stringify(value));
const responseHeaders = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  pragma: 'no-cache',
};
const goodToken = {
  access_token: 'synthetic-access-token',
  token_type: 'Bearer',
  expires_in: 300,
  scope: 'inventory.read',
};

// This is an isolated HTTP reference authorization server. Only this test's
// injected transport maps its synthetic HTTPS identifier to loopback HTTP.
// Production endpoint/TLS pinning is a separate transport gate.
let server: Server;
let baseUrl: string;
const observed: { form: URLSearchParams; authorization?: string }[] = [];
const seenJti = new Set<string>();
function checkAssertion(
  jwt: string | null,
  issuer: string,
  subject: string,
  kind: 'client' | 'grant',
) {
  if (!jwt) throw new Error('assertion absent');
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('assertion malformed');
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as Record<
    string,
    unknown
  >;
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<
    string,
    unknown
  >;
  const key = kind === 'client' ? rsa.publicKey : ec.publicKey;
  if (
    header.alg !== (kind === 'client' ? 'RS256' : 'ES256') ||
    !verify(
      'sha256',
      Buffer.from(parts[0] + '.' + parts[1]),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2]!, 'base64url'),
    ) ||
    claims.iss !== issuer ||
    claims.sub !== subject ||
    claims.aud !== endpoint ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number' ||
    claims.exp - claims.iat !== 60 ||
    claims.exp <= Date.now() / 1000 ||
    typeof claims.jti !== 'string' ||
    seenJti.has(claims.jti)
  )
    throw new Error('assertion refused');
  seenJti.add(claims.jti);
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    observed.push({ form, authorization: req.headers.authorization });
    try {
      if (
        req.method !== 'POST' ||
        req.url !== '/token' ||
        req.headers['content-type'] !== 'application/x-www-form-urlencoded'
      )
        throw new Error('request refused');
      if (form.get('client_assertion')) {
        if (
          req.headers.authorization ||
          form.get('client_id') !== 'fixture-client' ||
          form.get('client_assertion_type') !==
            'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        )
          throw new Error('client auth refused');
        checkAssertion(form.get('client_assertion'), 'fixture-client', 'fixture-client', 'client');
      } else {
        const parts = Buffer.from(req.headers.authorization?.slice(6) ?? '', 'base64')
          .toString()
          .split(':');
        const decode = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));
        if (
          parts.length !== 2 ||
          decode(parts[0]!) !== 'fixture:client' ||
          decode(parts[1]!) !== 'synthetic secret+with:characters'
        )
          throw new Error('client secret refused');
      }
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer')
        checkAssertion(form.get('assertion'), 'trusted-issuer', 'tenant-delegate', 'grant');
      else if (form.get('grant_type') !== 'client_credentials' || form.has('assertion'))
        throw new Error('grant refused');
      if (form.get('scope') !== 'inventory.read') throw new Error('scope refused');
      res.writeHead(200, responseHeaders);
      res.end(JSON.stringify(goodToken));
    } catch {
      res.writeHead(400, responseHeaders);
      res.end(
        JSON.stringify({ error: 'invalid_grant', error_description: 'sensitive upstream detail' }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('reference AS unavailable');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
const referenceTransport: TokenEndpointTransport = {
  async post(url, body, headers) {
    expect(url).toBe(endpoint);
    const response = await fetch(baseUrl + '/token', {
      method: 'POST',
      body: Buffer.from(body),
      headers,
      redirect: 'manual',
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  },
};
describe('OAuth grant primitives and isolated reference authorization server', () => {
  it('client credentials use correctly encoded Basic auth and clear the supplied profile', async () => {
    const bytes = encodeProfile(basicProfile());
    const token = await acquireOAuthToken(bytes, ['inventory.read'], referenceTransport);
    expect(token.withValue((v) => v)).toBe('synthetic-access-token');
    expect(bytes).toEqual(Buffer.alloc(bytes.length));
    expect(observed.at(-1)!.form.get('grant_type')).toBe('client_credentials');
    expect(observed.at(-1)!.form.has('client_secret')).toBe(false);
    expect(JSON.stringify(token)).not.toContain('synthetic-access-token');
    expect(inspect(token)).not.toContain('synthetic-access-token');
    token.destroy();
    expect(() => token.withValue((v) => v)).toThrow(OAuthGrantError);
  });
  it('private_key_jwt authenticates the registered client independently from a JWT-bearer grant', async () => {
    const profile = privateProfile();
    const first = await acquireOAuthToken(
      encodeProfile(profile),
      ['inventory.read'],
      referenceTransport,
    );
    first.destroy();
    const jwtGrant: OAuthProfile = {
      ...profile,
      grantType: 'jwt_bearer',
      assertion: {
        issuer: 'trusted-issuer',
        subject: 'tenant-delegate',
        audience: endpoint,
        signingKey: ecKey,
      },
    };
    const second = await acquireOAuthToken(
      encodeProfile(jwtGrant),
      ['inventory.read'],
      referenceTransport,
    );
    second.destroy();
    const request = observed.at(-1)!;
    expect(request.authorization).toBeUndefined();
    expect(request.form.get('client_assertion')).not.toBe(request.form.get('assertion'));
    expect(request.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  });
  it('refuses the wrong audience without exposing authorization server detail', async () => {
    const profile = privateProfile();
    if (profile.clientAuth.method !== 'private_key_jwt') throw new Error('fixture');
    profile.clientAuth.audience = 'https://wrong.test.invalid';
    await expect(
      acquireOAuthToken(encodeProfile(profile), ['inventory.read'], referenceTransport),
    ).rejects.toThrow('Connector token acquisition was refused.');
  });
  it.each([
    { scope: 'inventory.read admin.write' },
    { scope: '' },
    { scope: 'inventory.read inventory.read' },
    { expires_in: 301 },
    { expires_in: 0 },
    { expires_in: '300' },
    { expires_in: null },
    { token_type: 'Other' },
    { access_token: 'token\r\nInjected: yes' },
    { refresh_token: 'unneeded' },
  ])('rejects unsafe or excessive token responses %#', async (patch) => {
    const body = Buffer.from(JSON.stringify({ ...goodToken, ...patch }));
    await expect(
      acquireOAuthToken(encodeProfile(basicProfile()), ['inventory.read'], {
        async post() {
          return { status: 200, headers: responseHeaders, body };
        },
      }),
    ).rejects.toThrow(OAuthGrantError);
    expect(body).toEqual(Buffer.alloc(body.length));
  });
  it('accepts omitted scope as exactly the requested scope, and refuses disallowed requests before IO', async () => {
    const post = vi.fn<TokenEndpointTransport['post']>().mockResolvedValue({
      status: 200,
      headers: responseHeaders,
      body: Buffer.from(
        JSON.stringify({ access_token: 'opaque', token_type: 'bearer', expires_in: 10 }),
      ),
    });
    const token = await acquireOAuthToken(encodeProfile(basicProfile()), ['inventory.read'], {
      post,
    });
    expect(token.scopes).toEqual(['inventory.read']);
    token.destroy();
    post.mockClear();
    for (const requested of [['admin.write'], [], ['inventory.read', 'inventory.read']])
      await expect(
        acquireOAuthToken(encodeProfile(basicProfile()), requested, { post }),
      ).rejects.toThrow(OAuthGrantError);
    expect(post).not.toHaveBeenCalled();
  });
  it.each([
    { status: 302 },
    { headers: { ...responseHeaders, 'cache-control': 'public' } },
    { headers: { ...responseHeaders, pragma: '' } },
    { headers: { ...responseHeaders, 'content-type': 'text/html' } },
    { body: Buffer.alloc(65537) },
  ])('rejects protocol/transport response violations %#', async (patch) => {
    const response = {
      status: 200,
      headers: responseHeaders,
      body: Buffer.from(JSON.stringify(goodToken)),
      ...patch,
    };
    await expect(
      acquireOAuthToken(encodeProfile(basicProfile()), ['inventory.read'], {
        async post() {
          return response;
        },
      }),
    ).rejects.toThrow(OAuthGrantError);
  });
  it('clears buffers on transport failures and does not expose private errors', async () => {
    const bytes = encodeProfile(basicProfile());
    let captured: Uint8Array | undefined;
    await expect(
      acquireOAuthToken(bytes, ['inventory.read'], {
        async post(_url, body) {
          captured = body;
          throw new Error('private upstream credentials');
        },
      }),
    ).rejects.toThrow('Connector token acquisition was refused.');
    expect(bytes).toEqual(Buffer.alloc(bytes.length));
    expect(captured!.every((v) => v === 0)).toBe(true);
  });
  it('expires tokens locally and keeps lifetime metadata immutable', () => {
    const token = new AcquiredToken('opaque', ['inventory.read'], Date.now() - 1);
    expect(() => token.withValue((v) => v)).toThrow(OAuthGrantError);
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(token.scopes)).toBe(true);
  });
});
