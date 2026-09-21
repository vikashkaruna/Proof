import { z } from 'zod';
import { AgentName } from './enums';

export type ConnectorId = string & { readonly __brand: 'ConnectorId' };
export type ConnectorDescriptorId = string & { readonly __brand: 'ConnectorDescriptorId' };
export type ConnectorGrantId = string & { readonly __brand: 'ConnectorGrantId' };
export type WorkloadIdentityId = string & { readonly __brand: 'WorkloadIdentityId' };
export const TargetBindingSchema = z.enum(['production', 'sandbox', 'reference-mock']);
export const ConnectorTransportSchema = z.enum(['rest', 'sql', 'graphql', 'mcp']);
const name = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Catalogue metadata only; runtime descriptor validation/dispatch belongs to W4. */
export const ConnectorDescriptorSchema = z.object({
  id: z.uuid(),
  slug: z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  version: z.string().trim().min(1).max(80),
  transport: ConnectorTransportSchema,
  targetBinding: TargetBindingSchema,
  manifest: z.record(z.string(), z.unknown()),
  contentSha256: digest,
  createdAt: z.iso.datetime(),
});
export type ConnectorDescriptor = z.infer<typeof ConnectorDescriptorSchema>;
export const ConnectorSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  systemId: z.uuid(),
  descriptorId: z.uuid(),
  targetBinding: TargetBindingSchema,
  name,
  endpointRef: z.string().trim().min(1).max(500),
  assurance: z.enum(['high', 'low']),
  status: z.enum(['draft', 'active', 'disabled', 'archived']),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type Connector = z.infer<typeof ConnectorSchema>;
export const WorkloadIdentitySchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  agentName: z.nativeEnum(AgentName),
  spiffeId: z.string().regex(/^spiffe:\/\/[^/?#]+\/[^?#]+$/),
  status: z.enum(['active', 'disabled']),
  createdAt: z.iso.datetime(),
});
export type WorkloadIdentity = z.infer<typeof WorkloadIdentitySchema>;

/** A row is not an execution token. The broker must re-check live authority. */
export const ConnectorGrantSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    connectorId: z.uuid(),
    workloadIdentityId: z.uuid(),
    agentName: z.nativeEnum(AgentName),
    internalScope: z.enum(['connector.read', 'connector.write']),
    targetScopes: z.array(z.string().min(1)),
    additionalConfirmationRequired: z.boolean(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (g) =>
      (g.agentName === 'drishti' && g.internalScope === 'connector.read') ||
      (g.agentName === 'karya' && g.internalScope === 'connector.write'),
    'Client-system grants are limited to Drishti reads and Karya writes',
  )
  .refine(
    (g) =>
      Date.parse(g.expiresAt) > Date.parse(g.createdAt) &&
      (!g.revokedAt || Date.parse(g.revokedAt) >= Date.parse(g.createdAt)),
    'Invalid grant lifetime',
  );
export type ConnectorGrant = z.infer<typeof ConnectorGrantSchema>;

export const ConnectorHealthCheckSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  connectorId: z.uuid(),
  status: z.enum(['healthy', 'degraded', 'unreachable']),
  checkedAt: z.iso.datetime(),
  latencyMs: z.number().int().nonnegative().nullable(),
  errorCode: z
    .string()
    .regex(/^[a-z0-9_]{1,80}$/)
    .nullable(),
});
export type ConnectorHealthCheck = z.infer<typeof ConnectorHealthCheckSchema>;
export const McpToolRegistrationSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  connectorId: z.uuid(),
  toolName: name,
  toolVersion: z.string().trim().min(1).max(80),
  operationClass: z.enum(['read', 'write']),
  description: z.string(),
  descriptionSha256: digest,
  inputSchema: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type McpToolRegistration = z.infer<typeof McpToolRegistrationSchema>;
// Credentials deliberately have no public response schema. The future broker
// owns encryption/decryption and must never serialize envelopes to browser APIs.
