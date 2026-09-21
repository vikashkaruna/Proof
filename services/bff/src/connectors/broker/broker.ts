import { z } from 'zod';
import {
  EndpointRefSchema,
  TargetBindingSchema,
  type ConnectorId,
  type TenantId,
} from '@axiom/types';
import {
  openCredential,
  type CredentialEnvelope,
  type CredentialId,
  type KeyWrapper,
  type VaultIdentity,
} from './envelope.js';
import {
  acquireOAuthToken,
  OAuthProfileSchema,
  type AcquiredToken,
  type TokenEndpointTransport,
} from './oauth-grants.js';

export const BrokerRequestSchema = z
  .object({
    tenantId: z.uuid(),
    estateId: z.uuid(),
    connectorId: z.uuid(),
    correlationId: z.uuid(),
    scope: z.enum(['connector.read', 'connector.write']),
    workloadProof: z.string().min(1).max(16384),
    approvalProof: z.string().min(1).max(16384).optional(),
    actionId: z.uuid().optional(),
  })
  .strict();
export type BrokerRequest = z.infer<typeof BrokerRequestSchema>;
const scopes = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/),
  )
  .min(1)
  .max(100)
  .refine((values) => new Set(values).size === values.length);
export const BrokerLeaseSchema = z
  .object({
    tenantId: z.uuid(),
    estateId: z.uuid(),
    connectorId: z.uuid(),
    credentialId: z.uuid(),
    credentialRevision: z.number().int().positive(),
    connectorVersion: z.number().int().positive(),
    grantId: z.uuid(),
    workloadId: z.uuid(),
    agentName: z.enum(['drishti', 'karya']),
    spiffeId: z
      .string()
      .max(2048)
      .regex(/^spiffe:\/\/[^/?#]+\/[^?#]+$/),
    scope: z.enum(['connector.read', 'connector.write']),
    targetScopes: scopes,
    validUntil: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    descriptorSha256: z.string().regex(/^[a-f0-9]{64}$/),
    endpointRef: EndpointRefSchema,
    targetBinding: TargetBindingSchema,
    grantType: z.enum(['client_credentials', 'jwt_bearer']),
    approval: z
      .object({
        tokenId: z.uuid(),
        actionId: z.uuid(),
        validUntil: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .optional(),
  })
  .strict();
type ParsedLease = z.infer<typeof BrokerLeaseSchema>;
export type BrokerLease = Readonly<Omit<ParsedLease, 'targetScopes' | 'approval'>> & {
  readonly targetScopes: readonly string[];
  readonly approval?: Readonly<NonNullable<ParsedLease['approval']>>;
};
/** Trusted W4.3/4 adapter, NOT a request payload or an admin role check.
 * authorize verifies SVID audience/signature/expiry, current registration,
 * estate/connector grant mapping, kill switch, and (for writes) a signed action
 * approval backed by completed dry-run and validated rollback. It must use the
 * minimum of workload/grant/approval deadlines for validUntil.
 * stillCurrent repeats live revocation, lifecycle, policy and approval checks.
 * Neither method may infer authority from caller-supplied actor/scope strings. */
export interface BrokerAuthority {
  authorize(request: Readonly<BrokerRequest>): Promise<BrokerLease | null>;
  stillCurrent(lease: BrokerLease, request: Readonly<BrokerRequest>): Promise<boolean>;
}
export const denyAllBrokerAuthority: BrokerAuthority = Object.freeze({
  async authorize() {
    return null;
  },
  async stillCurrent() {
    return false;
  },
});
export interface BrokerCredentialStore {
  load(lease: BrokerLease): Promise<CredentialEnvelope>;
  stillCurrent(lease: BrokerLease): Promise<boolean>;
}
export interface BrokerAudit {
  /** Unattributed refusal telemetry: accepts no proof, token or caller fields. */
  refused(): void;
  write(
    phase: 'requested' | 'acquired' | 'denied',
    lease: BrokerLease,
    correlationId: string,
    expiresAt?: number,
  ): Promise<void>;
}
export interface BrokerResources {
  credentials: BrokerCredentialStore;
  keys: KeyWrapper;
  transport(lease: BrokerLease): TokenEndpointTransport;
  audit: BrokerAudit;
}
export class BrokerRefused extends Error {
  constructor() {
    super('Connector credential acquisition was refused.');
    this.name = 'BrokerRefused';
  }
}
function identity(lease: BrokerLease): VaultIdentity {
  return {
    tenantId: lease.tenantId as TenantId,
    connectorId: lease.connectorId as ConnectorId,
    credentialId: lease.credentialId as CredentialId,
    grantType: lease.grantType,
    descriptorSha256: lease.descriptorSha256,
    endpointRef: lease.endpointRef,
    targetBinding: lease.targetBinding,
  };
}
/** Internal library only. No route constructs this. The production default is
 * deny-all until real workload and grant adapters ship in W4.3/4. */
export class CredentialBroker {
  constructor(
    private readonly resources: BrokerResources,
    private readonly authority: BrokerAuthority = denyAllBrokerAuthority,
  ) {}
  private async current(lease: BrokerLease, request: BrokerRequest): Promise<void> {
    if (
      lease.validUntil <= Date.now() ||
      (lease.approval && lease.approval.validUntil <= Date.now()) ||
      (await this.authority.stillCurrent(lease, request)) !== true ||
      (await this.resources.credentials.stillCurrent(lease)) !== true
    )
      throw new BrokerRefused();
  }
  async acquire(input: BrokerRequest): Promise<AcquiredToken> {
    let profileBytes: Buffer | undefined;
    let token: AcquiredToken | undefined;
    let auditedLease: BrokerLease | undefined;
    let correlationId: string | undefined;
    let released = false;
    try {
      // Copy and freeze the request before any awaits. A caller cannot retarget
      // a pending authorization or exchange by mutating its original object.
      const parsed = BrokerRequestSchema.parse(input);
      const request = Object.freeze({
        ...parsed,
        tenantId: parsed.tenantId.toLowerCase(),
        estateId: parsed.estateId.toLowerCase(),
        connectorId: parsed.connectorId.toLowerCase(),
        actionId: parsed.actionId?.toLowerCase(),
        correlationId: parsed.correlationId.toLowerCase(),
      });
      const authorized = await this.authority.authorize(request);
      if (!authorized) throw new BrokerRefused();
      const parsedLease = BrokerLeaseSchema.parse(authorized);
      const lease = Object.freeze({
        ...parsedLease,
        targetScopes: Object.freeze([...parsedLease.targetScopes]),
        ...(parsedLease.approval ? { approval: Object.freeze({ ...parsedLease.approval }) } : {}),
      });
      if (
        lease.tenantId !== request.tenantId ||
        lease.estateId !== request.estateId ||
        lease.connectorId !== request.connectorId ||
        lease.scope !== request.scope ||
        lease.validUntil <= Date.now()
      )
        throw new BrokerRefused();
      if (lease.scope === 'connector.write') {
        if (
          lease.agentName !== 'karya' ||
          lease.targetBinding !== 'production' ||
          !request.approvalProof ||
          !request.actionId ||
          !lease.approval ||
          lease.approval.actionId !== request.actionId ||
          lease.approval.validUntil <= Date.now()
        )
          throw new BrokerRefused();
      } else if (
        lease.agentName !== 'drishti' ||
        request.actionId ||
        request.approvalProof ||
        lease.approval
      )
        throw new BrokerRefused();
      await this.current(lease, request);
      await this.resources.audit.write('requested', lease, request.correlationId);
      auditedLease = lease;
      correlationId = request.correlationId;
      const envelope = await this.resources.credentials.load(lease);
      profileBytes = await openCredential(identity(lease), envelope, this.resources.keys);
      const profile = OAuthProfileSchema.parse(JSON.parse(profileBytes.toString('utf8')));
      if (
        profile.grantType !== lease.grantType ||
        lease.targetScopes.some((scope) => !profile.allowedScopes.includes(scope))
      )
        throw new BrokerRefused();
      await this.current(lease, request);
      token = await acquireOAuthToken(
        profileBytes,
        lease.targetScopes,
        this.resources.transport(lease),
      );
      // Do not conceal an over-long externally issued token by truncating its
      // reported expiry. It must fit inside the actual authorization deadline.
      if (
        token.validityUpperBound > lease.validUntil ||
        (lease.approval && token.validityUpperBound > lease.approval.validUntil)
      )
        throw new BrokerRefused();
      await this.current(lease, request);
      await this.resources.audit.write('acquired', lease, request.correlationId, token.expiresAt);
      await this.current(lease, request);
      released = true;
      return token;
    } catch {
      try {
        this.resources.audit.refused();
      } catch {
        /* Refusal remains fail-closed. */
      }
      if (auditedLease && correlationId) {
        try {
          await this.resources.audit.write('denied', auditedLease, correlationId);
        } catch {
          /* Parent acquisition still fails closed. */
        }
      }
      throw new BrokerRefused();
    } finally {
      profileBytes?.fill(0);
      if (!released) token?.destroy();
    }
  }
}
