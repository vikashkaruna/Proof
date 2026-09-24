import { randomUUID } from 'node:crypto';
import { OAuthProfileSchema } from './oauth-grants.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  EndpointRefSchema,
  TargetBindingSchema,
  type ConnectorId,
  type TenantId,
} from '@axiom/types';
import {
  rotateEnvelope,
  sealCredential,
  type BrokerGrantType,
  type CredentialEnvelope,
  type CredentialId,
  type KeyWrapper,
  type VaultIdentity,
} from './envelope.js';

/** Administrative context only. Never use a browser role as agent acquisition authority. */
export interface VaultActor {
  tenantId: TenantId;
  actorId: string;
  correlationId: string;
}
export class VaultError extends Error {
  constructor() {
    super('Credential vault operation was refused.');
    this.name = 'VaultError';
  }
}
const connectorRow = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  descriptor_id: z.uuid(),
  endpoint_ref: EndpointRefSchema,
  target_binding: TargetBindingSchema,
  status: z.enum(['draft', 'active', 'disabled', 'archived']),
});
const descriptorRow = z.object({
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifest: z.object({ auth: z.string() }),
});
const hexBytes = z
  .string()
  .regex(/^\\x(?:[0-9a-f]{2})+$/)
  .transform((v) => Buffer.from(v.slice(2), 'hex'));
const storedRow = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  format_version: z.literal(1),
  grant_type: z.enum(['client_credentials', 'jwt_bearer']),
  key_ref: z.string(),
  algorithm: z.literal('aes-256-gcm'),
  nonce: hexBytes,
  ciphertext: hexBytes,
  wrapped_data_key: hexBytes,
  descriptor_sha256: z.string(),
  endpoint_ref: z.string(),
  target_binding: TargetBindingSchema,
  expires_at: z.string().nullable(),
  revoked_at: z.null(),
});
const receiptSchema = z
  .object({ credentialId: z.uuid(), revision: z.number().int().positive(), revoked: z.boolean() })
  .strict();
export type VaultReceipt = z.infer<typeof receiptSchema>;

/** No routes instantiate this yet. Real agent access awaits W4.3 workload
 * identity and W4.4 per-invocation grant/approval enforcement. */
export class CredentialVault {
  constructor(
    private readonly db: SupabaseClient,
    private readonly wrapper: KeyWrapper,
  ) {}

  private async context(actor: VaultActor, connectorId: ConnectorId) {
    z.uuid().parse(actor.tenantId);
    z.uuid().parse(actor.actorId);
    z.uuid().parse(actor.correlationId);
    z.uuid().parse(connectorId);
    const membership = await this.db
      .from('tenant_users')
      .select('role')
      .eq('tenant_id', actor.tenantId)
      .eq('user_id', actor.actorId)
      .maybeSingle();
    if (
      membership.error ||
      !z.object({ role: z.enum(['founder', 'owner', 'admin']) }).safeParse(membership.data).success
    )
      throw new VaultError();
    const found = await this.db
      .from('connectors')
      .select('id,version,descriptor_id,endpoint_ref,target_binding,status')
      .eq('tenant_id', actor.tenantId)
      .eq('id', connectorId)
      .single();
    if (found.error) throw new VaultError();
    const connector = connectorRow.parse(found.data);
    const descriptor = await this.db
      .from('connector_descriptors')
      .select('content_sha256,manifest')
      .eq('id', connector.descriptor_id)
      .single();
    if (descriptor.error) throw new VaultError();
    return { connector, descriptor: descriptorRow.parse(descriptor.data) };
  }
  private identity(
    actor: VaultActor,
    context: Awaited<ReturnType<CredentialVault['context']>>,
    credentialId: CredentialId,
    grantType: BrokerGrantType,
  ): VaultIdentity {
    if (
      context.descriptor.manifest.auth !== `oauth2.${grantType}` ||
      context.connector.status === 'archived'
    )
      throw new VaultError();
    return {
      tenantId: actor.tenantId,
      connectorId: context.connector.id as ConnectorId,
      credentialId,
      grantType,
      descriptorSha256: context.descriptor.content_sha256,
      endpointRef: context.connector.endpoint_ref,
      targetBinding: context.connector.target_binding,
    };
  }
  private async persist(
    actor: VaultActor,
    identity: VaultIdentity,
    operation: 'create' | 'rotate',
    version: number,
    revision: number,
    envelope: CredentialEnvelope,
  ) {
    const { data, error } = await this.db.rpc('manage_connector_credential', {
      p_tenant_id: actor.tenantId,
      p_actor_id: actor.actorId,
      p_connector_id: identity.connectorId,
      p_credential_id: identity.credentialId,
      p_operation: operation,
      p_connector_version: version,
      p_expected_revision: revision,
      p_correlation_id: actor.correlationId,
      p_envelope: {
        formatVersion: envelope.formatVersion,
        algorithm: envelope.algorithm,
        grantType: identity.grantType,
        descriptorSha256: identity.descriptorSha256,
        endpointRef: identity.endpointRef,
        targetBinding: identity.targetBinding,
        keyRef: envelope.keyRef,
        nonce: envelope.nonce.toString('hex'),
        ciphertext: envelope.ciphertext.toString('hex'),
        wrappedDataKey: envelope.wrappedDataKey.toString('hex'),
      },
    });
    if (error) throw new VaultError();
    return receiptSchema.parse(data);
  }
  /** Consumes/clears the caller's buffer on both success and failure. */
  async create(
    actor: VaultActor,
    connectorId: ConnectorId,
    grantType: BrokerGrantType,
    secret: Buffer,
  ): Promise<VaultReceipt> {
    try {
      const context = await this.context(actor, connectorId);
      const identity = this.identity(actor, context, randomUUID() as CredentialId, grantType);
      if (
        secret.length > 32768 ||
        OAuthProfileSchema.parse(JSON.parse(secret.toString('utf8'))).grantType !== grantType
      )
        throw new VaultError();
      const envelope = await sealCredential(identity, secret, this.wrapper);
      return await this.persist(actor, identity, 'create', context.connector.version, 0, envelope);
    } catch {
      throw new VaultError();
    } finally {
      secret.fill(0);
    }
  }
  async rotate(
    actor: VaultActor,
    connectorId: ConnectorId,
    credentialId: CredentialId,
    next: KeyWrapper,
  ): Promise<VaultReceipt> {
    try {
      const context = await this.context(actor, connectorId);
      const found = await this.db
        .from('connector_credentials')
        .select('*')
        .eq('tenant_id', actor.tenantId)
        .eq('connector_id', connectorId)
        .eq('id', credentialId)
        .single();
      if (found.error) throw new VaultError();
      const stored = storedRow.parse(found.data);
      if (
        stored.expires_at !== null &&
        (!Number.isFinite(Date.parse(stored.expires_at)) ||
          Date.parse(stored.expires_at) <= Date.now())
      )
        throw new VaultError();
      const identity = this.identity(actor, context, credentialId, stored.grant_type);
      if (
        stored.descriptor_sha256 !== identity.descriptorSha256 ||
        stored.endpoint_ref !== identity.endpointRef ||
        stored.target_binding !== identity.targetBinding
      )
        throw new VaultError();
      const envelope: CredentialEnvelope = {
        formatVersion: 1,
        algorithm: stored.algorithm,
        keyRef: stored.key_ref,
        nonce: stored.nonce,
        ciphertext: stored.ciphertext,
        wrappedDataKey: stored.wrapped_data_key,
      };
      const rotated = await rotateEnvelope(identity, envelope, this.wrapper, next);
      return await this.persist(
        actor,
        identity,
        'rotate',
        context.connector.version,
        stored.revision,
        rotated,
      );
    } catch {
      throw new VaultError();
    }
  }
  async revoke(
    actor: VaultActor,
    connectorId: ConnectorId,
    credentialId: CredentialId,
    expectedRevision: number,
  ): Promise<VaultReceipt> {
    try {
      const context = await this.context(actor, connectorId);
      const { data, error } = await this.db.rpc('manage_connector_credential', {
        p_tenant_id: actor.tenantId,
        p_actor_id: actor.actorId,
        p_connector_id: connectorId,
        p_credential_id: credentialId,
        p_operation: 'revoke',
        p_connector_version: context.connector.version,
        p_expected_revision: expectedRevision,
        p_envelope: null,
        p_correlation_id: actor.correlationId,
      });
      if (error) throw new VaultError();
      return receiptSchema.parse(data);
    } catch {
      throw new VaultError();
    }
  }
}
