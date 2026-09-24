import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';

export class ToolRefused extends Error {
  constructor() {
    super('Connector tool use was refused.');
    this.name = 'ToolRefused';
  }
}
const verified = z
  .object({
    id: z.uuid(),
    operationClass: z.enum(['read', 'write']),
    inputSchema: z.record(z.string(), z.unknown()),
    descriptionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type VerifiedTool = z.infer<typeof verified>;

/**
 * W4.5 session verification for the internal tool registry. A tool is usable
 * only if it is registered for the connector, classified, and the description
 * observed this session hashes to the value pinned at registration. Write
 * tools additionally need a write lease: the class comes from the registry,
 * never from the tool's own metadata or a caller.
 */
export class ToolRegistry {
  constructor(private readonly deps: { client?: typeof createSupabaseAdmin } = {}) {}

  async verify(input: {
    tenantId: string;
    connectorId: string;
    toolName: string;
    toolVersion: string;
    observedDescription: string;
    leaseScope: 'connector.read' | 'connector.write';
  }): Promise<VerifiedTool> {
    const hash = createHash('sha256').update(input.observedDescription, 'utf8').digest('hex');
    const { data, error } = await (this.deps.client ?? createSupabaseAdmin)().rpc(
      'verify_connector_tool',
      {
        p_tenant_id: input.tenantId,
        p_connector_id: input.connectorId,
        p_tool_name: input.toolName,
        p_tool_version: input.toolVersion,
        p_description_sha256: hash,
      },
    );
    if (error || !data) throw new ToolRefused();
    const parsed = verified.safeParse(data);
    if (!parsed.success || parsed.data.descriptionSha256 !== hash) throw new ToolRefused();
    if (parsed.data.operationClass === 'write' && input.leaseScope !== 'connector.write')
      throw new ToolRefused();
    if (parsed.data.operationClass === 'read' && input.leaseScope !== 'connector.read')
      throw new ToolRefused();
    return parsed.data;
  }
}
