import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LedgerClient } from '@axiom/ledger';
import type { AppendLedgerInput } from '@axiom/ledger';
import type { CredentialEnvelope } from './envelope.js';
import {
  BrokerRefused,
  type BrokerAudit,
  type BrokerCredentialStore,
  type BrokerLease,
} from './broker.js';
const bytes = z
  .string()
  .regex(/^\\x(?:[a-f0-9]{2})+$/)
  .transform((v) => Buffer.from(v.slice(2), 'hex'));
const storedEnvelope = z.object({
  format_version: z.literal(1),
  algorithm: z.literal('aes-256-gcm'),
  key_ref: z.string().min(1).max(500),
  nonce: bytes.refine((v) => v.length === 12),
  ciphertext: bytes.refine((v) => v.length >= 17 && v.length <= 32784),
  wrapped_data_key: bytes.refine((v) => v.length > 0 && v.length <= 16384),
});
export class SupabaseBrokerCredentialStore implements BrokerCredentialStore {
  constructor(private readonly db: SupabaseClient) {}
  private async read(lease: BrokerLease): Promise<CredentialEnvelope> {
    const { data, error } = await this.db.rpc('read_broker_credential', {
      p_tenant_id: lease.tenantId,
      p_estate_id: lease.estateId,
      p_connector_id: lease.connectorId,
      p_credential_id: lease.credentialId,
      p_connector_version: lease.connectorVersion,
      p_credential_revision: lease.credentialRevision,
      p_descriptor_sha256: lease.descriptorSha256,
      p_endpoint_ref: lease.endpointRef,
      p_target_binding: lease.targetBinding,
      p_grant_type: lease.grantType,
    });
    if (error) throw new BrokerRefused();
    const parsed = storedEnvelope.safeParse(data);
    if (!parsed.success) throw new BrokerRefused();
    const stored = parsed.data;
    return {
      formatVersion: 1,
      algorithm: stored.algorithm,
      keyRef: stored.key_ref,
      nonce: stored.nonce,
      ciphertext: stored.ciphertext,
      wrappedDataKey: stored.wrapped_data_key,
    };
  }
  async load(lease: BrokerLease): Promise<CredentialEnvelope> {
    try {
      return await this.read(lease);
    } catch {
      throw new BrokerRefused();
    }
  }
  async stillCurrent(lease: BrokerLease): Promise<boolean> {
    try {
      await this.read(lease);
      return true;
    } catch {
      return false;
    }
  }
}
export class LedgerBrokerAudit implements BrokerAudit {
  refused(): void {
    process.stderr.write(
      JSON.stringify({ service: 'axiom-bff', event: 'connector.broker.refused' }) + '\n',
    );
  }
  private readonly ledger: Pick<LedgerClient, 'append'>;
  constructor(db: SupabaseClient | Pick<LedgerClient, 'append'>) {
    this.ledger = 'append' in db ? db : new LedgerClient(db);
  }
  async write(
    phase: 'requested' | 'acquired' | 'denied',
    lease: BrokerLease,
    correlationId: string,
    expiresAt?: number,
  ): Promise<void> {
    const entry: AppendLedgerInput = {
      tenantId: lease.tenantId,
      correlationId,
      actorType: 'agent',
      actorId: lease.agentName,
      actionType:
        phase === 'requested'
          ? 'connector.token_requested'
          : phase === 'acquired'
            ? 'connector.token_acquired'
            : 'connector.token_denied',
      targetRef: lease.connectorId,
      approvalTokenId: lease.approval?.tokenId ?? null,
      result: phase === 'requested' ? 'pending' : phase === 'acquired' ? 'success' : 'failure',
      // Explicit allowlist: never spread a request, profile, token or provider error.
      detail: {
        phase,
        estateId: lease.estateId,
        grantId: lease.grantId,
        workloadId: lease.workloadId,
        spiffeId: lease.spiffeId,
        scope: lease.scope,
        targetScopes: [...lease.targetScopes],
        targetBinding: lease.targetBinding,
        credentialId: lease.credentialId,
        credentialRevision: lease.credentialRevision,
        connectorVersion: lease.connectorVersion,
        actionId: lease.approval?.actionId ?? null,
        expiresAt: expiresAt === undefined ? null : new Date(expiresAt).toISOString(),
      },
    };
    try {
      await this.ledger.append(entry);
    } catch {
      throw new BrokerRefused();
    }
  }
}
