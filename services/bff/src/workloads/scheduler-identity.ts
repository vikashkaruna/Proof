import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';

export interface SchedulerIdentity {
  authorize(authorization: string | undefined): Promise<{ expiresAt: number }>;
}
export function controllerOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    value !== url.origin
  )
    throw new Error('Controller origin refused');
  return url.origin;
}
export const schedulerIdentityConfiguration = z
  .object({
    audience: z.string().max(2048).transform(controllerOrigin),
    subject: z.string().regex(/^[0-9]{1,32}$/),
    email: z.string().regex(/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/),
  })
  .strict();
const header = z
  .object({
    alg: z.literal('RS256'),
    kid: z.string().min(1).max(256),
    typ: z.literal('JWT').optional(),
  })
  .strict();
const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';
/** Fixed issuer endpoint only. Token-supplied jku/x5u/jwk are refused before
 * key resolution. No bearer token or client payload is sent to this endpoint. */
export function googleSchedulerKeys(): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(GOOGLE_KEYS), {
    cacheMaxAge: 60000,
    cooldownDuration: 30000,
    timeoutDuration: 2500,
    [customFetch]: async (url, options) => {
      if (url !== GOOGLE_KEYS) throw new Error('Scheduler keys unavailable');
      const response = await fetch(url, { ...options, redirect: 'error' });
      if (response.status !== 200 || !response.body) throw new Error('Scheduler keys unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 65536) throw new Error('Scheduler keys unavailable');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      return new Response(Buffer.concat(chunks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}
/** Service identity only, not tenant/task/connector authority. Pin the immutable
 * service-account subject AND email so account recreation cannot inherit access.
 * Static policy changes require a controlled controller rollout. */
export class GoogleSchedulerIdentity implements SchedulerIdentity {
  private readonly config: z.infer<typeof schedulerIdentityConfiguration>;
  constructor(
    options: unknown,
    private readonly keys: JWTVerifyGetKey = googleSchedulerKeys(),
  ) {
    this.config = schedulerIdentityConfiguration.parse(options);
  }
  async authorize(authorization: string | undefined) {
    try {
      if (
        !authorization ||
        authorization.length > 8200 ||
        !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)
      )
        throw new Error();
      const token = authorization.slice(7);
      header.parse(decodeProtectedHeader(token));
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ['RS256'],
        issuer: 'https://accounts.google.com',
        audience: this.config.audience,
        subject: this.config.subject,
        requiredClaims: ['sub', 'aud', 'iss', 'iat', 'exp', 'email', 'email_verified'],
        maxTokenAge: 3600,
        clockTolerance: 0,
      });
      const now = Math.floor(Date.now() / 1000);
      if (
        payload.aud !== this.config.audience ||
        payload.email !== this.config.email ||
        payload.email_verified !== true ||
        (payload.azp !== undefined && payload.azp !== this.config.subject) ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! > now ||
        payload.exp! <= now ||
        payload.exp! <= payload.iat! ||
        payload.exp! - payload.iat! > 3600
      )
        throw new Error();
      return Object.freeze({ expiresAt: payload.exp! * 1000 });
    } catch {
      throw new Error('Scheduler identity refused');
    }
  }
}
