import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';

const algorithms = [
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
] as const;
export const workloadTrustDomain = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((s) => !s.includes('..') && s.trim() === s);
const header = z
  .object({
    alg: z.enum(algorithms),
    kid: z.string().min(1).max(256).optional(),
    typ: z.enum(['JWT', 'JOSE']).optional(),
  })
  .strict();
const b64 = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+$/);
const keyOptions = {
  kid: z.string().min(1).max(256).optional(),
  alg: z.enum(algorithms).optional(),
  use: z.enum(['sig', 'jwt-svid']).optional(),
  key_ops: z.array(z.literal('verify')).length(1).optional(),
};
const publicKey = z.discriminatedUnion('kty', [
  z.object({ ...keyOptions, kty: z.literal('RSA'), n: b64, e: b64 }).strict(),
  z
    .object({
      ...keyOptions,
      kty: z.literal('EC'),
      crv: z.enum(['P-256', 'P-384', 'P-521']),
      x: b64,
      y: b64,
    })
    .strict(),
]);
export const jwtPublicBundle = z.object({ keys: z.array(publicKey).min(1).max(32) }).strict();
const configSchema = z
  .object({
    audience: z.string().min(1).max(2048),
    trustDomains: z
      .array(workloadTrustDomain)
      .min(1)
      .max(20)
      .refine((v) => new Set(v).size === v.length),
    maxLifetimeSeconds: z.number().int().min(1).max(900),
  })
  .strict();
export interface JwtTrustBundle {
  readonly revision: string;
  readonly validUntil: number;
  readonly jwks: unknown;
}
/** Trusted Workload API/configuration adapter. It must bound freshness and fail
 * closed when unavailable. Never fetch a URL/issuer/jku supplied by a token.
 * A changed revision invalidates in-flight validation; the next call reloads. */
export interface JwtTrustSource {
  load(trustDomain: string): Promise<JwtTrustBundle | null>;
  stillCurrent(trustDomain: string, revision: string): Promise<boolean>;
}
export const denyAllJwtTrust: JwtTrustSource = Object.freeze({
  async load() {
    return null;
  },
  async stillCurrent() {
    return false;
  },
});
export class WorkloadIdentityRefused extends Error {
  constructor() {
    super('Workload identity was refused.');
    this.name = 'WorkloadIdentityRefused';
  }
}
export interface VerifiedWorkloadIdentity {
  readonly spiffeId: string;
  readonly trustDomain: string;
  readonly audience: string;
  readonly expiresAt: number;
  readonly bundleRevision: string;
}
/** Axiom accepts a canonical SPIFFE-ID subset: no encoded paths, ports, empty
 * segments or dot segments. The registered exact ID supplies the agent name;
 * no authorization is inferred from path spelling or custom JWT claims. */
export function parseWorkloadSpiffeId(value: unknown): { spiffeId: string; trustDomain: string } {
  if (typeof value !== 'string' || value.length > 2048 || value.trim() !== value)
    throw new WorkloadIdentityRefused();
  const match = /^spiffe:\/\/([^/]+)\/([A-Za-z0-9._/-]+)$/.exec(value);
  if (
    !match ||
    !workloadTrustDomain.safeParse(match[1]).success ||
    match[2]!.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new WorkloadIdentityRefused();
  return { spiffeId: value, trustDomain: match[1]! };
}
/** Verifies identity only. It grants no tool, tenant, estate or connector scope.
 * Current registration, tenant task authority and grants must be checked by the
 * consuming adapter on every invocation. Private assessment tools compose this
 * explicitly; it does not enable public broker acquisition or management. */
export class JwtSvidVerifier {
  readonly #config: z.infer<typeof configSchema>;
  constructor(
    configuration: unknown,
    private readonly trust: JwtTrustSource = denyAllJwtTrust,
  ) {
    this.#config = configSchema.parse(configuration);
  }
  async verify(token: string): Promise<VerifiedWorkloadIdentity> {
    try {
      if (typeof token !== 'string' || token.length > 16384 || token.split('.').length !== 3)
        throw new WorkloadIdentityRefused();
      header.parse(decodeProtectedHeader(token));
      // Unverified subject selects ONLY an already allowlisted trust domain.
      const selected = parseWorkloadSpiffeId(decodeJwt(token).sub);
      if (!this.#config.trustDomains.includes(selected.trustDomain))
        throw new WorkloadIdentityRefused();
      const supplied = await this.trust.load(selected.trustDomain);
      if (!supplied) throw new WorkloadIdentityRefused();
      const bundle = z
        .object({
          revision: z.string().min(1).max(256),
          validUntil: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          jwks: jwtPublicBundle,
        })
        .strict()
        .parse(supplied);
      if (bundle.validUntil <= Date.now()) throw new WorkloadIdentityRefused();
      const resolver = createLocalJWKSet({
        keys: bundle.jwks.keys.map((key) => ({ ...key, use: 'sig' })),
      });
      const { payload } = await jwtVerify(token, resolver, {
        algorithms: [...algorithms],
        audience: this.#config.audience,
        requiredClaims: ['sub', 'aud', 'exp', 'iat'],
        clockTolerance: 0,
        maxTokenAge: this.#config.maxLifetimeSeconds,
      });
      const verified = parseWorkloadSpiffeId(payload.sub);
      const now = Date.now();
      if (
        verified.spiffeId !== selected.spiffeId ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! > Math.floor(now / 1000) ||
        payload.exp! <= payload.iat! ||
        payload.exp! - payload.iat! > this.#config.maxLifetimeSeconds ||
        bundle.validUntil <= now
      )
        throw new WorkloadIdentityRefused();
      // SPIFFE permits multiple audiences. Axiom's initial broker policy requires
      // one exact service audience to avoid cross-service bearer replay.
      const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
      if (!audiences || audiences.length !== 1 || audiences[0] !== this.#config.audience)
        throw new WorkloadIdentityRefused();
      if (
        (await this.trust.stillCurrent(verified.trustDomain, bundle.revision)) !== true ||
        Math.min(payload.exp! * 1000, bundle.validUntil) <= Date.now()
      )
        throw new WorkloadIdentityRefused();
      return Object.freeze({
        ...verified,
        audience: this.#config.audience,
        expiresAt: Math.min(payload.exp! * 1000, bundle.validUntil),
        bundleRevision: bundle.revision,
      });
    } catch {
      throw new WorkloadIdentityRefused();
    }
  }
}
