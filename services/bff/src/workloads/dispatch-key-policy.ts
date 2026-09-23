import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TenantId } from '@axiom/types';
import {
  dispatchContextSchema,
  dispatchWrappingContext,
  DispatchRefused,
} from './dispatch-payload.js';

export type DispatchKeyProvider = 'aws' | 'gcp';
export interface DispatchKeyRing {
  readonly primary: string;
  readonly retiring: readonly string[];
}
const patterns = {
  aws: /^arn:aws:kms:ap-south-1:[0-9]{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  gcp: /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/asia-south1\/keyRings\/[a-zA-Z0-9_-]{1,63}\/cryptoKeys\/[a-zA-Z0-9_-]{1,63}$/,
};
const ringSchema = z
  .object({ primary: z.string().max(500), retiring: z.array(z.string().max(500)).max(9) })
  .strict();

/** Trusted, immutable configuration. References from an envelope never create
 * policy. Dispatch keys must be dedicated resources, separate from vault keys.
 * No method removes readable keys or disables/destroys cloud key material. */
export class DispatchKeyPolicy {
  readonly #rings = new Map<TenantId, DispatchKeyRing>();
  readonly provider: DispatchKeyProvider;
  constructor(provider: DispatchKeyProvider, rings: ReadonlyMap<TenantId, DispatchKeyRing>) {
    try {
      this.provider = z.enum(['aws', 'gcp']).parse(provider);
      const owners = new Set<string>();
      for (const [id, value] of rings) {
        const tenant = z.uuid().parse(id).toLowerCase() as TenantId;
        const ring = ringSchema.parse(value);
        if (this.#rings.has(tenant)) throw new DispatchRefused();
        for (const key of [ring.primary, ...ring.retiring]) {
          if (key.trim() !== key || !patterns[provider].test(key) || owners.has(key))
            throw new DispatchRefused();
          owners.add(key);
        }
        this.#rings.set(
          tenant,
          Object.freeze({ primary: ring.primary, retiring: Object.freeze([...ring.retiring]) }),
        );
      }
      Object.freeze(this);
    } catch {
      throw new DispatchRefused();
    }
  }
  fingerprint(tenant: TenantId): string {
    const ring = this.#rings.get(tenant);
    if (!ring) throw new DispatchRefused();
    return createHash('sha256')
      .update(
        [
          'axiom.dispatch.key-policy.v1',
          tenant,
          this.provider,
          ring.primary,
          ...[ring.primary, ...ring.retiring].sort(),
        ].join('\n'),
        'utf8',
      )
      .digest('hex');
  }
  primary(tenant: TenantId): string {
    const ring = this.#rings.get(tenant);
    if (!ring) throw new DispatchRefused();
    return ring.primary;
  }
  requireReadable(tenant: TenantId, key: string): void {
    const ring = this.#rings.get(tenant);
    if (!ring || (key !== ring.primary && !ring.retiring.includes(key)))
      throw new DispatchRefused();
  }
  /** A detached configuration snapshot, never a handle to mutable live policy. */
  snapshot(): Map<TenantId, DispatchKeyRing> {
    return new Map(
      [...this.#rings].map(([id, ring]) => [
        id,
        { primary: ring.primary, retiring: [...ring.retiring] },
      ]),
    );
  }
  /** First deploy this reader policy everywhere while writers keep the old primary. */
  withReadable(tenant: TenantId, key: string): DispatchKeyPolicy {
    const next = this.snapshot();
    const old = next.get(tenant);
    if (!old) throw new DispatchRefused();
    if (key !== old.primary && !old.retiring.includes(key)) {
      next.set(tenant, { primary: old.primary, retiring: [...old.retiring, key] });
    }
    return new DispatchKeyPolicy(this.provider, next);
  }
  /** Promote an already-staged readable key. This neither persists policy nor
   * proves every reader has deployed it; all old references are retained. */
  withPrimary(tenant: TenantId, key: string): DispatchKeyPolicy {
    this.requireReadable(tenant, key);
    const next = this.snapshot();
    const old = next.get(tenant);
    if (!old) throw new DispatchRefused();
    next.set(tenant, {
      primary: key,
      retiring: [...new Set([old.primary, ...old.retiring])].filter((ref) => ref !== key),
    });
    return new DispatchKeyPolicy(this.provider, next);
  }
}

/** Reject noncanonical/foreign-purpose context before credential lookup or IO.
 * KMS audit logs get only a domain-separated digest, not the full job metadata. */
export function dispatchKmsBinding(bytes: Uint8Array): {
  tenant: TenantId;
  digest: string;
  aad: Buffer;
} {
  try {
    if (bytes.byteLength > 4096) throw new DispatchRefused();
    const values: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const fields = z
      .tuple([
        z.literal('axiom.assessment.dispatch.dek'),
        z.literal(1),
        z.unknown(),
        z.unknown(),
        z.unknown(),
        z.unknown(),
        z.unknown(),
        z.unknown(),
        z.unknown(),
        z.unknown(),
      ])
      .parse(values);
    const context = dispatchContextSchema.parse({
      jobId: fields[2],
      tenantId: fields[3],
      actorId: fields[4],
      workloadId: fields[5],
      estateId: fields[6],
      engagementId: fields[7],
      correlationId: fields[8],
      inputHash: fields[9],
    });
    if (!dispatchWrappingContext(context).equals(bytes)) throw new DispatchRefused();
    const digest = createHash('sha256').update(bytes).digest('hex');
    return {
      tenant: context.tenantId as TenantId,
      digest,
      aad: Buffer.from(JSON.stringify(['axiom.assessment.dispatch.kms', 1, digest])),
    };
  } catch {
    throw new DispatchRefused();
  }
}
