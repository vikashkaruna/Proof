import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { EndpointRefSchema, TargetBindingSchema, type TenantId } from '@axiom/types';
import {
  CredentialBroker,
  BrokerRefused,
  type BrokerAuthority,
  type BrokerLease,
  type BrokerResources,
} from './broker.js';
import {
  AwsKmsKeyWrapper,
  GcpKmsKeyWrapper,
  type AwsKmsPort,
  type GcpKmsPort,
} from './key-wrappers.js';
import { LedgerBrokerAudit, SupabaseBrokerCredentialStore } from './repository.js';
import { PinnedTokenTransport } from './token-transport.js';
const pin = z
  .object({
    connectorId: z.uuid(),
    endpointRef: EndpointRefSchema,
    targetBinding: TargetBindingSchema,
    descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
    endpoint: z.url().max(2048),
    address: z.string(),
    timeoutMs: z.number().int().min(1).max(30000),
    caPem: z.string().min(1).max(65536).optional(),
  })
  .strict();
export const BrokerConfigurationSchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(['aws', 'gcp']),
    tenants: z
      .array(
        z
          .object({
            tenantId: z.uuid(),
            primaryKey: z.string().min(1).max(500),
            retiringKeys: z.array(z.string().min(1).max(500)).max(9),
            endpoints: z.array(pin).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

/** Trusted server configuration only, never a request body. No env/URL discovery
 * or implicit shared key. Every entry is validated at startup, even if unused. */
export class BrokerEndpointRegistry {
  readonly #pins = new Map<
    string,
    { config: z.infer<typeof pin>; transport: PinnedTokenTransport }
  >();
  constructor(configuration: unknown) {
    const config = BrokerConfigurationSchema.parse(configuration);
    const tenants = new Set<string>();
    for (const tenant of config.tenants) {
      const tenantId = tenant.tenantId.toLowerCase();
      if (tenants.has(tenantId)) throw new BrokerRefused();
      tenants.add(tenantId);
      for (const entry of tenant.endpoints) {
        const key = tenantId + '/' + entry.connectorId.toLowerCase();
        if (this.#pins.has(key)) throw new BrokerRefused();
        const { endpoint, address, targetBinding, timeoutMs, caPem } = entry;
        this.#pins.set(key, {
          config: { ...entry },
          transport: new PinnedTokenTransport({
            endpoint,
            address,
            targetBinding,
            timeoutMs,
            caPem,
          }),
        });
      }
    }
  }
  forLease(lease: BrokerLease): PinnedTokenTransport {
    const entry = this.#pins.get(
      lease.tenantId.toLowerCase() + '/' + lease.connectorId.toLowerCase(),
    );
    if (
      !entry ||
      entry.config.endpointRef !== lease.endpointRef ||
      entry.config.targetBinding !== lease.targetBinding ||
      entry.config.descriptorSha256 !== lease.descriptorSha256
    )
      throw new BrokerRefused();
    return entry.transport;
  }
}
/** Test clients are injected explicitly; production uses native KMS SDKs.
 * The default authority is deny-all. No HTTP route enables this factory yet. */
export function createCredentialBroker(
  db: SupabaseClient,
  configuration: unknown,
  authority?: BrokerAuthority,
  clients: { aws?: AwsKmsPort; gcp?: GcpKmsPort } = {},
): CredentialBroker {
  const config = BrokerConfigurationSchema.parse(configuration);
  const endpoints = new BrokerEndpointRegistry(config);
  const rings = new Map(
    config.tenants.map((tenant) => [
      tenant.tenantId.toLowerCase() as TenantId,
      { primary: tenant.primaryKey, retiring: [...tenant.retiringKeys] },
    ]),
  );
  const keys =
    config.provider === 'aws'
      ? new AwsKmsKeyWrapper(rings, clients.aws)
      : new GcpKmsKeyWrapper(rings, clients.gcp);
  const resources: BrokerResources = {
    keys,
    credentials: new SupabaseBrokerCredentialStore(db),
    audit: new LedgerBrokerAudit(db),
    transport: (lease) => endpoints.forLease(lease),
  };
  return new CredentialBroker(resources, authority);
}
