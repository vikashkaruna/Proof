import { z } from 'zod';
import { ConnectorTransportSchema, TargetBindingSchema } from './connectors';

const identifier = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/);
const readOperation = z.object({ operation: identifier, mutating: z.literal(false) }).strict();
// REST resources are literal, reviewed GET paths: no templating, no query text.
const restPath = z
  .string()
  .max(300)
  .regex(/^(\/[A-Za-z0-9._~-]+)+$/)
  .refine((path) => !path.split('/').some((segment) => segment === '.' || segment === '..'));
const jsonPointer = z
  .string()
  .max(200)
  .regex(/^(\/[A-Za-z0-9_-]+){1,8}$/);
const restResource = z
  .object({
    path: restPath,
    itemsPointer: jsonPointer,
    pageSizeParam: identifier,
    cursor: z.object({ param: identifier, responsePointer: jsonPointer }).strict().optional(),
  })
  .strict();
// GraphQL resources declare a selection; Axiom generates the query document.
const gqlName = z.string().regex(/^[_A-Za-z][_0-9A-Za-z]{0,63}$/);
const graphqlResource = z
  .object({
    root: gqlName,
    pageSizeArg: gqlName,
    cursorArg: gqlName.optional(),
    itemsPath: z.array(gqlName).max(3),
    cursorPath: z.array(gqlName).min(1).max(3).optional(),
    fields: z
      .array(z.string().regex(/^[_A-Za-z][_0-9A-Za-z]{0,63}(\.[_A-Za-z][_0-9A-Za-z]{0,63}){0,2}$/))
      .min(1)
      .max(100)
      .refine((fields) => new Set(fields).size === fields.length),
  })
  .strict()
  .refine((r) => (r.cursorArg === undefined) === (r.cursorPath === undefined));
const writeOperation = z
  .object({
    operation: identifier,
    mutating: z.literal(true),
    requiresApprovalToken: z.literal(true),
  })
  .strict();
/** Non-secret, declarative catalogue contract. No executable code, SQL or credentials. */
export const ConnectorManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z
      .uuid()
      .refine(
        (id) =>
          ![
            '00000000-0000-0000-0000-000000000000',
            'ffffffff-ffff-ffff-ffff-ffffffffffff',
          ].includes(id.toLowerCase()),
        'A descriptor requires a versioned UUID, not a sentinel',
      ),
    target: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(80),
    version: z
      .string()
      .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
      .max(40),
    transport: ConnectorTransportSchema,
    targetBinding: TargetBindingSchema,
    auth: z.enum([
      'oauth2.client_credentials',
      'oauth2.jwt_bearer',
      'oauth2.token_exchange',
      'oauth2.saml2_bearer',
      'cloud_iam',
      'legacy_static',
    ]),
    assurance: z.enum(['high', 'low']),
    capabilities: z
      .object({
        enumerate: readOperation,
        sample: readOperation.optional(),
        read: readOperation.optional(),
        write: writeOperation.optional(),
      })
      .strict(),
    dataCategoryHints: z.array(identifier).max(40),
    /** Where the descriptor's API shape comes from. Reference descriptors are
     * exercised against Axiom's reference service, not a vendor tenant. */
    provenance: z.enum(['reference', 'vendor-verified']).optional(),
    rest: z
      .object({
        resources: z
          .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), restResource)
          .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 50),
      })
      .strict()
      .optional(),
    graphql: z
      .object({
        path: restPath,
        resources: z
          .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), graphqlResource)
          .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 50),
      })
      .strict()
      .optional(),
    rateLimit: z
      .object({
        requestsPerSecond: z.number().int().min(1).max(1000),
        burst: z.number().int().min(1).max(1000),
      })
      .strict(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.targetBinding !== 'production' && m.capabilities.write)
      ctx.addIssue({
        code: 'custom',
        message: 'Non-production bindings cannot declare write operations',
      });
    if ((m.transport === 'rest') !== (m.rest !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'REST descriptors declare their resources; other transports must not',
      });
    if ((m.transport === 'graphql') !== (m.graphql !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'GraphQL descriptors declare their resources; other transports must not',
      });
    if ((m.auth === 'legacy_static') !== (m.assurance === 'low'))
      ctx.addIssue({
        code: 'custom',
        message:
          'Legacy static credentials require low assurance; federated credentials require high assurance',
      });
  });
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;
export const EndpointRefSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
export const CreateConnectorRequestSchema = z
  .object({
    systemId: z.uuid(),
    descriptorId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    endpointRef: EndpointRefSchema,
  })
  .strict();
export const UpdateConnectorRequestSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('edit'),
      expectedVersion: z.number().int().positive(),
      name: z.string().trim().min(1).max(200),
      endpointRef: EndpointRefSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('transition'),
      expectedVersion: z.number().int().positive(),
      status: z.enum(['active', 'disabled', 'archived']),
    })
    .strict(),
]);

/** Transport contracts only. Context is NOT proof of authority: the broker must
 * verify live identity/grants, descriptor pin, target binding and expiry per call. */
export interface ConnectorInvocation {
  tenantId: string;
  estateId: string;
  systemId: string;
  connectorId: string;
  descriptorSha256: string;
  grantId: string;
  workloadIdentity: string;
  correlationId: string;
  deadline: string;
}
export interface ConnectorResult {
  records: readonly Record<string, unknown>[];
  cursor?: string;
}
export interface ReadConnector {
  enumerate(context: ConnectorInvocation): Promise<ConnectorResult>;
  sample(context: ConnectorInvocation, resource: string, limit: number): Promise<ConnectorResult>;
  read(context: ConnectorInvocation, resource: string, cursor?: string): Promise<ConnectorResult>;
}
export interface WriteInvocation extends ConnectorInvocation {
  approvalToken: string;
  actionId: string;
  batchId: string;
  targetBinding: 'production';
}
/** Deliberately does not extend ReadConnector: Karya does not inherit Drishti access. */
export interface WriteConnector {
  execute(
    context: WriteInvocation,
    operation: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<{ receiptId: string }>;
}
