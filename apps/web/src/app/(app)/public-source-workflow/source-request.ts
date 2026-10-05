import { z } from 'zod';
import { canonicalJson, sha256 } from '@axiom/ledger';
import {
  createPublicAgentRunSchema,
  createPublicSourceBindingSchema,
  publicAgentObservationSchema,
  type PublicAgentObservation,
} from '@axiom/types';

export class SourceWorkflowError extends Error {}

const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = { tenantId: uuid, actorId: uuid };
export const sourceOperationSchema = z
  .object({
    ...scope,
    operationKey: z.uuid(),
    kind: z.enum(['bind', 'drishti', 'vibhaag']),
    engagementId: uuid,
    checkId: uuid,
    bindingId: uuid.nullable(),
    rootSha256: digest,
    projectionSha256: digest,
    bodyUtf8: z.string().min(1).max(1500),
  })
  .strict()
  .superRefine((value, ctx) => {
    let body: unknown;
    try {
      body = JSON.parse(value.bodyUtf8);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid retained request' });
      return;
    }
    const parsed = (
      value.kind === 'bind' ? createPublicSourceBindingSchema : createPublicAgentRunSchema
    ).safeParse(body);
    if (!parsed.success || JSON.stringify(parsed.data) !== value.bodyUtf8) {
      ctx.addIssue({ code: 'custom', message: 'Retained request differs from its operation' });
      return;
    }
    if (
      parsed.data.engagementId !== value.engagementId ||
      parsed.data.expectedProjectionSha256 !== value.projectionSha256 ||
      (value.kind === 'bind'
        ? value.bindingId !== null ||
          !('checkId' in parsed.data) ||
          parsed.data.checkId !== value.checkId ||
          parsed.data.expectedRootSha256 !== value.rootSha256
        : value.bindingId === null ||
          (value.kind === 'drishti'
            ? 'observationId' in parsed.data
            : !('observationId' in parsed.data)))
    )
      ctx.addIssue({ code: 'custom', message: 'Retained request has the wrong scope' });
  });
export type SourceOperation = z.infer<typeof sourceOperationSchema>;

export function operationStorageKey(tenantId: string, actorId: string) {
  return `axiom.public-source.operation.v1:${tenantId.toLowerCase()}:${actorId.toLowerCase()}`;
}
export function saveSourceOperation(storage: Storage, operation: SourceOperation) {
  const parsed = sourceOperationSchema.parse(operation);
  const key = operationStorageKey(parsed.tenantId, parsed.actorId);
  const current = loadSourceOperation(storage, parsed.tenantId, parsed.actorId);
  if (current && JSON.stringify(current) !== JSON.stringify(parsed))
    throw new SourceWorkflowError(
      'Reconcile the existing retained request before starting another.',
    );
  const bytes = JSON.stringify(parsed);
  storage.setItem(key, bytes);
  if (storage.getItem(key) !== bytes)
    throw new SourceWorkflowError('Unable to retain this request safely. No dispatch was started.');
}
export function loadSourceOperation(
  storage: Storage,
  tenantId: string,
  actorId: string,
): SourceOperation | null {
  const value = storage.getItem(operationStorageKey(tenantId, actorId));
  if (value === null) return null;
  const parsed = sourceOperationSchema.parse(JSON.parse(value));
  if (parsed.tenantId !== tenantId.toLowerCase() || parsed.actorId !== actorId.toLowerCase())
    throw new SourceWorkflowError('The retained request belongs to another session.');
  return parsed;
}
export function clearSourceOperation(storage: Storage, operation: SourceOperation) {
  const key = operationStorageKey(operation.tenantId, operation.actorId);
  const current = loadSourceOperation(storage, operation.tenantId, operation.actorId);
  if (current?.operationKey !== operation.operationKey)
    throw new SourceWorkflowError('Another retained request replaced this operation.');
  storage.removeItem(key);
}
export function sourceOperationPath(operation: SourceOperation) {
  return operation.kind === 'bind'
    ? '/public-source-bindings'
    : `/public-source-bindings/${operation.bindingId}/agents/${operation.kind}/run`;
}

/** One explicit transport attempt. Keys and exact bytes belong to the retained operation. */
export async function sourceRequest(
  tenantId: string,
  path: string,
  options: { operation?: SourceOperation; requestKey?: string; signal?: AbortSignal } = {},
) {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new SourceWorkflowError('Invalid source request path.');
  const operation = options.operation ? sourceOperationSchema.parse(options.operation) : undefined;
  if (
    operation &&
    (operation.tenantId !== tenantId.toLowerCase() || sourceOperationPath(operation) !== path)
  )
    throw new SourceWorkflowError('Retained request scope differs from this action.');
  let response: Response;
  try {
    response = await fetch(`/api/bff/v1${path}`, {
      method: operation ? 'POST' : 'GET',
      cache: 'no-store',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
      headers: {
        'X-Tenant-Id': tenantId,
        ...(operation
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': operation.operationKey }
          : {}),
        ...(options.requestKey ? { 'X-Public-Source-Request-Key': options.requestKey } : {}),
      },
      ...(operation ? { body: operation.bodyUtf8 } : {}),
    });
  } catch {
    throw new SourceWorkflowError(
      operation
        ? 'Response interrupted. Reconcile the retained request before any retry.'
        : 'Recorded state is unavailable. Refresh when the connection is available.',
    );
  }
  if (!response.ok)
    throw new SourceWorkflowError(
      operation
        ? 'The action was not confirmed. Reconcile the retained request before continuing.'
        : 'The recorded state could not be loaded.',
    );
  return response.json() as Promise<unknown>;
}

/** Shape, source identity and output commitment must all match before rendering. */
export async function validateSourceObservation(
  value: unknown,
  expected: {
    tenantId: string;
    engagementId: string;
    bindingId: string;
    checkId: string;
    rootSha256: string;
    projectionSha256: string;
    agent?: 'drishti' | 'vibhaag';
  },
): Promise<PublicAgentObservation> {
  const observation = z.object({ data: publicAgentObservationSchema }).strict().parse(value).data;
  const binding =
    observation.agent === 'drishti'
      ? observation.output.observation.binding
      : observation.output.source_binding;
  if (
    observation.binding_id !== expected.bindingId ||
    (expected.agent && observation.agent !== expected.agent) ||
    binding.tenant_id !== expected.tenantId.toLowerCase() ||
    binding.engagement_id !== expected.engagementId ||
    binding.check_id !== expected.checkId ||
    binding.root_content_sha256 !== expected.rootSha256 ||
    binding.projection_sha256 !== expected.projectionSha256 ||
    (await sha256(canonicalJson(observation.output))) !== observation.output_sha256
  )
    throw new SourceWorkflowError('The retained observation does not match the selected source.');
  return observation;
}
