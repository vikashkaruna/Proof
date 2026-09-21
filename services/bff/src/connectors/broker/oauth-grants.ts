import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { inspect } from 'node:util';
import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[\x21-\x7e]+$/);
const scope = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
const scopes = z
  .array(scope)
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length);
const signingKey = z
  .object({
    algorithm: z.enum(['RS256', 'ES256']),
    keyId: identifier,
    privateKeyPem: z.string().min(1).max(16384),
  })
  .strict();
const clientAuth = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('client_secret_basic'),
      clientId: identifier,
      clientSecret: z.string().min(1).max(8192),
    })
    .strict(),
  z
    .object({
      method: z.literal('private_key_jwt'),
      clientId: identifier,
      audience: identifier,
      signingKey,
    })
    .strict(),
]);
const base = {
  version: z.literal(1),
  tokenEndpoint: z
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search
      );
    }),
  clientAuth,
  allowedScopes: scopes,
  maxTokenLifetimeSeconds: z.number().int().min(1).max(900),
};
export const OAuthProfileSchema = z.discriminatedUnion('grantType', [
  z.object({ ...base, grantType: z.literal('client_credentials') }).strict(),
  z
    .object({
      ...base,
      grantType: z.literal('jwt_bearer'),
      assertion: z
        .object({ issuer: identifier, subject: identifier, audience: identifier, signingKey })
        .strict(),
    })
    .strict(),
]);
export type OAuthProfile = z.infer<typeof OAuthProfileSchema>;
export class OAuthGrantError extends Error {
  constructor() {
    super('Connector token acquisition was refused.');
    this.name = 'OAuthGrantError';
  }
}
export interface OAuthHttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}
/** Implementations must pin the trusted tenant/connector endpoint, prohibit
 * redirects, bound bytes/time and verify TLS. This is not global fetch. */
export interface TokenEndpointTransport {
  post(
    endpoint: string,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<OAuthHttpResponse>;
}
export class AcquiredToken {
  readonly #value: Buffer;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  /** Conservative latest expiry inferred from receipt; used for grant deadlines. */
  readonly validityUpperBound: number;
  readonly binding = 'bearer' as const;
  constructor(
    value: string,
    scopes: readonly string[],
    expiresAt: number,
    validityUpperBound = expiresAt,
  ) {
    this.#value = Buffer.from(value, 'utf8');
    this.scopes = Object.freeze([...scopes]);
    this.expiresAt = expiresAt;
    this.validityUpperBound = validityUpperBound;
    Object.freeze(this);
  }
  /** Only a trusted transport should use this callback. The value must never
   * enter logs, database state, browser responses or error messages. */
  withValue<T>(consume: (value: string) => T): T {
    if (!this.#value.length || this.#value.every((v) => v === 0) || Date.now() >= this.expiresAt) {
      this.destroy();
      throw new OAuthGrantError();
    }
    return consume(this.#value.toString('utf8'));
  }
  destroy(): void {
    this.#value.fill(0);
  }
  toJSON() {
    return {
      token: '[REDACTED]',
      scopes: this.scopes,
      expiresAt: this.expiresAt,
      binding: this.binding,
    };
  }
  [inspect.custom]() {
    return this.toJSON();
  }
}
function assertion(
  keyConfig: z.infer<typeof signingKey>,
  issuer: string,
  subject: string,
  audience: string,
  now: number,
): string {
  const key = createPrivateKey(keyConfig.privateKeyPem);
  if (keyConfig.algorithm === 'RS256') {
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new OAuthGrantError();
  } else if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  )
    throw new OAuthGrantError();
  const encoded = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input =
    encoded({ alg: keyConfig.algorithm, typ: 'JWT', kid: keyConfig.keyId }) +
    '.' +
    encoded({
      iss: issuer,
      sub: subject,
      aud: audience,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    });
  return (
    input +
    '.' +
    sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  );
}
const formComponent = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
const tokenResponse = z.object({
  access_token: z
    .string()
    .min(1)
    .max(16384)
    .regex(/^[A-Za-z0-9\-._~+/]+=*$/),
  token_type: z.string().refine((v) => v.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  refresh_token: z.never().optional(),
});

/** Consumes and clears profileBytes on every path.
 * Grant primitive, not authorization. The broker must authenticate the workload,
 * resolve current grants/approval, decrypt the matching profile and audit the
 * acquisition before releasing this result. No route calls this directly. */
export async function acquireOAuthToken(
  profileBytes: Buffer,
  requestedScopes: readonly string[],
  transport: TokenEndpointTransport,
): Promise<AcquiredToken> {
  let requestBody: Buffer | undefined;
  let responseBody: Uint8Array | undefined;
  try {
    if (profileBytes.length > 32768) throw new OAuthGrantError();
    const profile = OAuthProfileSchema.parse(JSON.parse(profileBytes.toString('utf8')));
    const requested = scopes.parse(requestedScopes);
    if (requested.some((value) => !profile.allowedScopes.includes(value)))
      throw new OAuthGrantError();
    const startedAt = Date.now();
    const now = Math.floor(startedAt / 1000);
    const form = new URLSearchParams({
      grant_type:
        profile.grantType === 'client_credentials'
          ? 'client_credentials'
          : 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      scope: requested.join(' '),
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (profile.clientAuth.method === 'client_secret_basic') {
      headers.Authorization =
        'Basic ' +
        Buffer.from(
          formComponent(profile.clientAuth.clientId) +
            ':' +
            formComponent(profile.clientAuth.clientSecret),
        ).toString('base64');
    } else {
      form.set('client_id', profile.clientAuth.clientId);
      form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      form.set(
        'client_assertion',
        assertion(
          profile.clientAuth.signingKey,
          profile.clientAuth.clientId,
          profile.clientAuth.clientId,
          profile.clientAuth.audience,
          now,
        ),
      );
    }
    if (profile.grantType === 'jwt_bearer')
      form.set(
        'assertion',
        assertion(
          profile.assertion.signingKey,
          profile.assertion.issuer,
          profile.assertion.subject,
          profile.assertion.audience,
          now,
        ),
      );
    requestBody = Buffer.from(form.toString(), 'utf8');
    const response = await transport.post(profile.tokenEndpoint, requestBody, headers);
    const receivedAt = Date.now();
    responseBody = response.body;
    if (
      response.status !== 200 ||
      responseBody.byteLength > 65536 ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '') ||
      !(response.headers['cache-control'] ?? '')
        .toLowerCase()
        .split(',')
        .some((v) => v.trim() === 'no-store') ||
      !(response.headers.pragma ?? '')
        .toLowerCase()
        .split(',')
        .some((v) => v.trim() === 'no-cache')
    )
      throw new OAuthGrantError();
    const result = tokenResponse.parse(JSON.parse(Buffer.from(responseBody).toString('utf8')));
    if (result.expires_in > profile.maxTokenLifetimeSeconds) throw new OAuthGrantError();
    const returned = result.scope === undefined ? requested : scopes.parse(result.scope.split(' '));
    if (returned.length !== requested.length || returned.some((v) => !requested.includes(v)))
      throw new OAuthGrantError();
    const expiresAt = startedAt + result.expires_in * 1000;
    if (Date.now() >= expiresAt) throw new OAuthGrantError();
    return new AcquiredToken(
      result.access_token,
      returned,
      expiresAt,
      receivedAt + result.expires_in * 1000,
    );
  } catch {
    throw new OAuthGrantError();
  } finally {
    profileBytes.fill(0);
    requestBody?.fill(0);
    responseBody?.fill(0);
  }
}
