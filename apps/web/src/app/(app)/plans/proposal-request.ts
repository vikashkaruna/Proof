import { z } from 'zod';
import {
  sudhaarInputSchema,
  sudhaarProposalRequestSchema,
  sudhaarProposalSchema,
  validateSudhaarProposal,
} from '@axiom/types';
export class ProposalRequestError extends Error {}
export const proposalOptionsSchema = z
  .object({
    assessments: z
      .array(
        z
          .object({
            engagementTitle: z.string(),
            finalizedAt: z.iso.datetime({ offset: true }),
            assessmentRunId: z.uuid(),
            engagementId: z.uuid(),
            libraryVersion: z.string().min(1),
          })
          .strict(),
      )
      .max(25),
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(25),
    offset: z.number().int().min(0).max(1000000),
    runtimeAvailable: z.boolean(),
  })
  .strict();
export const retainedProposalSchema = z
  .object({
    version: z.literal(1),
    tenantId: z.uuid(),
    actorId: z.uuid(),
    request: sudhaarProposalRequestSchema,
    input: sudhaarInputSchema,
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.tenantId !== v.input.tenant_id ||
      v.request.engagementId !== v.input.engagement_id ||
      v.request.assessmentRunId !== v.input.source.assessmentRunId ||
      v.request.title !== v.input.title
    )
      c.addIssue({ code: 'custom', message: 'Retained source mismatch' });
  });
export type RetainedProposal = z.infer<typeof retainedProposalSchema>;
export type Proposal = z.infer<typeof sudhaarProposalSchema>;
export const PROPOSAL_CHANGED = 'axiom-sudhaar-proposal-changed';
export function proposalJournalKey(tenantId: string, actorId: string) {
  return `axiom:sudhaar-proposal:v1:${tenantId}:${actorId}`;
}
export function readProposalJournal(
  storage: Pick<Storage, 'getItem'>,
  tenantId: string,
  actorId: string,
) {
  const raw = storage.getItem(proposalJournalKey(tenantId, actorId));
  if (raw === null) return null;
  if (raw.length > 600000)
    throw new ProposalRequestError('The retained request is unreadable. Preserve it for review.');
  const value = retainedProposalSchema.parse(JSON.parse(raw));
  if (value.tenantId !== tenantId || value.actorId !== actorId)
    throw new ProposalRequestError('The retained request belongs to another session.');
  return value;
}
export function retainProposalJournal(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  input: RetainedProposal,
) {
  const value = retainedProposalSchema.parse(input),
    old = readProposalJournal(storage, value.tenantId, value.actorId);
  if (old && JSON.stringify(old) !== JSON.stringify(value))
    throw new ProposalRequestError(
      'Resolve the retained proposal before creating another request.',
    );
  const key = proposalJournalKey(value.tenantId, value.actorId),
    raw = JSON.stringify(value);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw)
    throw new ProposalRequestError(
      'The proposal request could not be retained. Nothing was submitted.',
    );
  window.dispatchEvent(new Event(PROPOSAL_CHANGED));
}
async function submitProposalRequest(value: RetainedProposal) {
  const retained = retainedProposalSchema.parse(value);
  const response = await fetch('/api/bff/v1/plans/proposals', {
    method: 'POST',
    cache: 'no-store',
    signal: AbortSignal.timeout(130000),
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': retained.tenantId,
      'X-Expected-Actor-Id': retained.actorId,
      'Idempotency-Key': retained.request.operationKey,
    },
    body: JSON.stringify(retained.request),
  });
  const body: unknown = await response.json();
  if (response.status !== 200) {
    const failure = z
      .object({ error: z.object({ code: z.string().regex(/^[a-z0-9_]{1,100}$/) }) })
      .safeParse(body);
    throw new ProposalRequestError(
      failure.success
        ? `Proposal is unconfirmed (${failure.data.error.code}). Keep the retained request.`
        : 'Proposal is unconfirmed. Keep the retained request.',
    );
  }
  const receipt = z
    .object({
      data: sudhaarProposalSchema,
      invocation: z
        .object({
          runId: z.uuid(),
          correlationId: z.literal(retained.request.operationKey),
          requestHash: z.string().regex(/^[a-f0-9]{64}$/),
          responseHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    })
    .strict()
    .parse(body);
  return {
    proposal: validateSudhaarProposal(receipt.data, retained.input),
    invocation: receipt.invocation,
  };
}

export async function readSelectedProposalSource(
  tenantId: string,
  runId: string,
  engagementId: string,
) {
  const response = await fetch(
    `/api/bff/v1/plans/proposal-assessment-source/${runId}?engagementId=${engagementId}`,
    { cache: 'no-store', signal: AbortSignal.timeout(20000), headers: { 'X-Tenant-Id': tenantId } },
  );
  if (!response.ok)
    throw new ProposalRequestError(
      'The selected assessment source is unavailable. Refresh the assessment choices.',
    );
  const { input } = z
    .object({ input: sudhaarInputSchema })
    .strict()
    .parse(await response.json());
  if (
    input.tenant_id !== tenantId ||
    input.engagement_id !== engagementId ||
    input.source.assessmentRunId !== runId
  )
    throw new ProposalRequestError('The selected assessment source does not match.');
  return input;
}

export async function submitProposal(value: RetainedProposal) {
  try {
    return await submitProposalRequest(value);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Proposal is unconfirmed')) throw cause;
    throw new ProposalRequestError(
      'The response was interrupted or could not be verified. Keep the retained request and check using the same request.',
    );
  }
}
