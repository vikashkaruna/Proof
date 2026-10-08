/** Dedicated human evidence composition; mounts/configuration remain separately supplied. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { z } from 'zod';
import { evidenceUploadSchema } from './evidence-ingestion.js';
import {
  humanRetentionApprovalSchema,
  assertConfiguredHumanRetentionApproval,
} from './saakshi-human-retention-approval.js';
import {
  encryptTemporaryHumanPayload,
  type TemporaryPayloadKey,
} from './saakshi-temporary-payload.js';
import {
  stageBindingSchema,
  retainedStageSource,
  StageUnconfirmed,
  type StageBinding,
} from './saakshi-staging-port.js';
import { validateStagedEvidenceOutput } from './saakshi-stage-output.js';
import {
  invokeGenericAgent,
  type GenericAgentInvocationDeps,
  type GenericAgentInvocationOutcome,
} from './generic-agent-invocation.js';

export const stagedEvidenceHumanRequest = evidenceUploadSchema
  .extend({ retentionApproval: humanRetentionApprovalSchema })
  .strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.string().regex(/^[1-9][0-9]{0,19}$/);
export interface EvidenceControllerRpc {
  call(
    name:
      | 'prepare_saakshi119'
      | 'record_saakshi119_stage'
      | 'finalize_saakshi119'
      | 'recover_saakshi119'
      | 'read_saakshi119_status'
      | 'expire_saakshi119'
      | 'bind_saakshi119_stage',
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ data: unknown; error: unknown }>;
}
export async function callEvidenceController(
  rpc: EvidenceControllerRpc,
  name: Parameters<EvidenceControllerRpc['call']>[0],
  args: Record<string, unknown>,
) {
  const signal = AbortSignal.timeout(10_000);
  const pending = rpc.call(name, args, signal);
  const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
    const abort = () => reject(new StageUnconfirmed());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
  if (result.error) throw new StageUnconfirmed();
  return result.data;
}
const recoveredSchema = z
  .object({
    accepted: z.literal(true),
    run_id: z.uuid(),
    evidence_id: z.uuid(),
    object_version_id: z.uuid(),
    input_text: z.string().max(16000),
    input_hash: digest,
    output_text: z.string().max(32000),
    output_hash: digest,
    human_body_hash: digest,
    requested_receipt: receipt,
    started_receipt: receipt,
    completed_receipt: receipt,
    settled_receipt: receipt,
  })
  .strict();
const unconfirmedSchema = z
  .object({
    kind: z.literal('unconfirmed_staged_evidence'),
    accepted: z.literal(false),
    operation_key: z.uuid(),
    run_id: z.uuid(),
    input_text: z.string().max(16000),
    input_hash: digest,
    human_body_hash: digest,
    requested_receipt: receipt,
    payload_expires_at: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)))
      .nullable(),
    payload_purged: z.boolean(),
    terminal_reason: z.enum(['expired_unconfirmed', 'expired_runtime_failure']).nullable(),
    runtime_outcome: z.enum(['unconfirmed', 'runtime_reported_failure']),
    provider_observation: z.enum(['not_attempted', 'outcome_unknown', 'observed_unaccepted']),
    observed_version: z.string().min(1).nullable(),
    observed_output_hash: digest.nullable(),
    new_approved_key_allowed: z.boolean(),
  })
  .strict();
export async function readUnconfirmedStagedEvidence(
  rpc: EvidenceControllerRpc,
  tenantId: string,
  actorId: string,
  operationKey: string,
  bodyHash: string,
  expire = false,
) {
  const status = unconfirmedSchema.parse(
    await callEvidenceController(rpc, expire ? 'expire_saakshi119' : 'read_saakshi119_status', {
      t: tenantId,
      a: actorId,
      k: operationKey,
      bodyhash: bodyHash,
    }),
  );
  const source = retainedStageSource.parse(JSON.parse(status.input_text));
  if (
    canonicalJson(source) !== status.input_text ||
    createHash('sha256').update(status.input_text).digest('hex') !== status.input_hash ||
    status.human_body_hash !== bodyHash ||
    source.human_request_hash !== bodyHash ||
    source.tenant_id !== tenantId ||
    source.actor_id !== actorId ||
    source.operation_key !== operationKey ||
    status.operation_key !== operationKey ||
    status.new_approved_key_allowed !== Boolean(status.terminal_reason) ||
    (status.terminal_reason === 'expired_runtime_failure' &&
      status.runtime_outcome !== 'runtime_reported_failure') ||
    (status.terminal_reason === 'expired_unconfirmed' &&
      status.runtime_outcome !== 'unconfirmed') ||
    Boolean(status.observed_version) !== Boolean(status.observed_output_hash) ||
    (status.terminal_reason !== null &&
      (!status.payload_purged || status.payload_expires_at !== null)) ||
    (status.provider_observation === 'observed_unaccepted') !==
      Boolean(status.observed_version && status.observed_output_hash)
  )
    throw new StageUnconfirmed();
  return {
    kind: status.kind,
    accepted: false as const,
    operationKey,
    bodyHash,
    runId: status.run_id,
    source,
    payloadExpiresAt: status.payload_expires_at,
    payloadPurged: status.payload_purged,
    terminalReason: status.terminal_reason,
    runtimeOutcome: status.runtime_outcome,
    providerObservation: status.provider_observation,
    observedVersion: status.observed_version,
    observedOutputHash: status.observed_output_hash,
    newApprovedKeyAllowed: status.new_approved_key_allowed,
    requestedReceipt: status.requested_receipt,
  };
}
export async function recoverStagedEvidence(
  rpc: EvidenceControllerRpc,
  tenantId: string,
  actorId: string,
  operationKey: string,
  bodyHash: string,
) {
  const saved = recoveredSchema.parse(
    await callEvidenceController(rpc, 'recover_saakshi119', {
      t: tenantId,
      a: actorId,
      k: operationKey,
      bodyhash: bodyHash,
    }),
  );
  const source = retainedStageSource.parse(JSON.parse(saved.input_text));
  if (
    canonicalJson(source) !== saved.input_text ||
    createHash('sha256').update(saved.input_text).digest('hex') !== saved.input_hash ||
    createHash('sha256').update(saved.output_text).digest('hex') !== saved.output_hash ||
    saved.human_body_hash !== bodyHash ||
    source.tenant_id !== tenantId ||
    source.actor_id !== actorId ||
    source.operation_key !== operationKey ||
    source.human_request_hash !== bodyHash
  )
    throw new StageUnconfirmed();
  // Readback time is historical in an immutable completed result, not renewed provider verification.
  const output = validateStagedEvidenceOutput(
    JSON.parse(saved.output_text),
    source,
    Date.parse(JSON.parse(saved.output_text).receipt.readback_at),
  );
  if (canonicalJson(output) !== saved.output_text) throw new StageUnconfirmed();
  return { saved, source, output };
}
export async function prepareStagedEvidence(
  rpc: EvidenceControllerRpc,
  tenantId: string,
  actorId: string,
  rawRequest: unknown,
  config: {
    retention: Omit<z.infer<typeof humanRetentionApprovalSchema>, 'acknowledgesImmutableRetention'>;
    key: TemporaryPayloadKey;
  },
) {
  const request = stagedEvidenceHumanRequest.parse(rawRequest);
  if (canonicalJson(request) !== canonicalJson(rawRequest)) throw new StageUnconfirmed();
  assertConfiguredHumanRetentionApproval(request.retentionApproval, config.retention);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.contentBase64)
  )
    throw new StageUnconfirmed();
  const bytes = Buffer.from(request.contentBase64, 'base64');
  if (
    bytes.length < 1 ||
    bytes.length > 8 * 1024 * 1024 ||
    bytes.toString('base64') !== request.contentBase64
  )
    throw new StageUnconfirmed();
  const humanText = canonicalJson(rawRequest),
    bodyHash = createHash('sha256').update(humanText).digest('hex');
  const encrypted = encryptTemporaryHumanPayload(
    {
      sourceKind: 'human_uploaded_bytes',
      tenantId,
      actorId,
      engagementId: request.engagementId ?? null,
      operationKey: request.operationKey,
      bodyHash,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      byteSize: bytes.length,
      contentType: request.contentType,
      retention: request.retentionApproval,
    },
    bytes,
    config.key,
  );
  const row = z
    .object({
      run_id: z.uuid(),
      operation_id: z.uuid(),
      input_text: z.string().max(16000),
      input_hash: digest,
      human_body_hash: digest,
      requested_receipt: receipt,
      replayed: z.boolean(),
    })
    .strict()
    .parse(
      await callEvidenceController(rpc, 'prepare_saakshi119', {
        t: tenantId,
        a: actorId,
        k: request.operationKey,
        human_text: humanText,
        provider: config.retention.provider,
        bucket: config.retention.bucket,
        expected_encryption: config.retention.encryption,
        expected_legal_hold: config.retention.legalHold,
        ciphertext: '\\x' + encrypted.ciphertext.toString('hex'),
        nonce: '\\x' + encrypted.metadata.nonce.toString('hex'),
        tag: '\\x' + encrypted.metadata.tag.toString('hex'),
        keyid: config.key.id,
        ttl_seconds: 900,
      }),
    );
  const source = retainedStageSource.parse(JSON.parse(row.input_text));
  if (
    canonicalJson(source) !== row.input_text ||
    createHash('sha256').update(row.input_text).digest('hex') !== row.input_hash ||
    row.human_body_hash !== bodyHash ||
    source.human_request_hash !== bodyHash ||
    source.operation_id !== row.operation_id ||
    source.tenant_id !== tenantId ||
    source.actor_id !== actorId ||
    source.operation_key !== request.operationKey ||
    source.content_hash !== encrypted.metadata.originalApproval.contentHash ||
    source.byte_size !== bytes.length ||
    source.provider !== config.retention.provider ||
    source.bucket !== config.retention.bucket ||
    source.encryption !== config.retention.encryption ||
    source.legal_hold !== config.retention.legalHold ||
    source.engagement_id !== (request.engagementId ?? null)
  )
    throw new StageUnconfirmed();
  return {
    binding: stageBindingSchema.parse({
      source,
      runId: row.run_id,
      correlationId: request.operationKey,
      requestedReceipt: row.requested_receipt,
    }),
    canonicalInput: row.input_text,
    inputHash: row.input_hash,
    bodyHash,
    replayed: row.replayed,
  };
}
export function stagedEvidenceInvocationHook(
  rpc: EvidenceControllerRpc,
  prepared: Awaited<ReturnType<typeof prepareStagedEvidence>>,
): NonNullable<GenericAgentInvocationDeps['stagedEvidence']> {
  return {
    async start(context) {
      if (
        context.agent !== 'saakshi' ||
        context.canonicalInput !== prepared.canonicalInput ||
        context.requestHash !== prepared.inputHash ||
        context.tenantId !== prepared.binding.source.tenant_id ||
        context.actorId !== prepared.binding.source.actor_id ||
        context.engagementId !== prepared.binding.source.engagement_id ||
        context.correlationId !== prepared.binding.source.operation_key
      )
        throw new StageUnconfirmed();
      return { run_id: prepared.binding.runId, created: !prepared.replayed, status: 'running' };
    },
    async settleSuccess(context) {
      if (
        context.agent !== 'saakshi' ||
        context.tenantId !== prepared.binding.source.tenant_id ||
        context.actorId !== prepared.binding.source.actor_id ||
        context.engagementId !== prepared.binding.source.engagement_id ||
        context.correlationId !== prepared.binding.source.operation_key ||
        context.runId !== prepared.binding.runId ||
        context.canonicalInput !== prepared.canonicalInput ||
        context.requestHash !== prepared.inputHash ||
        context.result.agent !== 'saakshi' ||
        context.result.correlation_id !== context.correlationId ||
        context.result.status !== 'succeeded' ||
        context.result.error !== null ||
        context.result.ledger_entry_ids.length !== 2 ||
        context.result.ledger_entry_ids.some((id) => !receipt.safeParse(id).success) ||
        context.result.ledger_entry_ids[0] === context.result.ledger_entry_ids[1] ||
        canonicalJson(context.result.output) !== context.canonicalOutput ||
        createHash('sha256').update(context.canonicalOutput).digest('hex') !== context.responseHash
      )
        throw new StageUnconfirmed();
      validateStagedEvidenceOutput(context.result.output, prepared.binding.source);
      const result = z
        .object({
          accepted: z.literal(true),
          run_id: z.literal(prepared.binding.runId),
          evidence_id: z.uuid(),
          object_version_id: z.uuid(),
          output_hash: z.literal(context.responseHash),
          replayed: z.boolean(),
        })
        .strict()
        .parse(
          await callEvidenceController(rpc, 'finalize_saakshi119', {
            t: context.tenantId,
            a: context.actorId,
            runid: context.runId,
            k: context.correlationId,
            ih: context.requestHash,
            output_text: context.canonicalOutput,
            started: context.result.ledger_entry_ids[0],
            completed: context.result.ledger_entry_ids[1],
            latency: context.result.latency_ms,
            inputtokens: context.result.input_tokens,
            outputtokens: context.result.output_tokens,
            cost: context.result.cost_usd,
          }),
        );
      const recovered = await recoverStagedEvidence(
        rpc,
        context.tenantId,
        context.actorId,
        context.correlationId,
        prepared.bodyHash,
      );
      if (
        recovered.saved.output_text !== context.canonicalOutput ||
        recovered.saved.run_id !== context.runId ||
        recovered.saved.evidence_id !== result.evidence_id ||
        recovered.saved.object_version_id !== result.object_version_id
      )
        throw new StageUnconfirmed();
      return { run_id: context.runId, status: 'succeeded', replayed: result.replayed };
    },
  };
}
export async function recordStagedObservation(
  rpc: EvidenceControllerRpc,
  binding: StageBinding,
  receiptValue: unknown,
) {
  const output = validateStagedEvidenceOutput(
    {
      kind: 'sealed_pending_registration',
      accepted: false,
      source: binding.source,
      receipt: receiptValue,
    },
    binding.source,
  );
  const outputText = canonicalJson(output),
    outputHash = createHash('sha256').update(outputText).digest('hex');
  const result = z
    .object({
      recorded: z.literal(true),
      replayed: z.boolean(),
      output_hash: z.literal(outputHash),
    })
    .strict()
    .parse(
      await callEvidenceController(rpc, 'record_saakshi119_stage', {
        t: binding.source.tenant_id,
        a: binding.source.actor_id,
        runid: binding.runId,
        k: binding.source.operation_key,
        ih: createHash('sha256').update(canonicalJson(binding.source)).digest('hex'),
        output_text: outputText,
      }),
    );
  return { output, outputHash, replayed: result.replayed };
}

export interface AcceptedStagedEvidence {
  kind: 'accepted_staged_evidence';
  accepted: true;
  runId: string;
  evidenceId: string;
  objectVersionId: string;
  operationKey: string;
  contentHash: string;
  sourceRequestHash: string;
  stageOutputHash: string;
  receipts: { requested: string; started: string; completed: string; settled: string };
}
export function acceptedStagedEvidenceResult(
  accepted: Awaited<ReturnType<typeof recoverStagedEvidence>>,
): AcceptedStagedEvidence {
  return {
    kind: 'accepted_staged_evidence',
    accepted: true,
    runId: accepted.saved.run_id,
    evidenceId: accepted.saved.evidence_id,
    objectVersionId: accepted.saved.object_version_id,
    operationKey: accepted.source.operation_key,
    contentHash: accepted.source.content_hash,
    sourceRequestHash: accepted.saved.human_body_hash,
    stageOutputHash: accepted.saved.output_hash,
    receipts: {
      requested: accepted.saved.requested_receipt,
      started: accepted.saved.started_receipt,
      completed: accepted.saved.completed_receipt,
      settled: accepted.saved.settled_receipt,
    },
  };
}
/** Human route composes prepared source; generic runtime output alone is never evidence acceptance. */
export async function invokePreparedStagedEvidence(
  rpc: EvidenceControllerRpc,
  prepared: Awaited<ReturnType<typeof prepareStagedEvidence>>,
  deps: Omit<
    GenericAgentInvocationDeps,
    | 'stagedEvidence'
    | 'reviewedWorkflow'
    | 'prepareDispatch'
    | 'sudhaarDispatch'
    | 'settleSudhaarSuccess'
    | 'validateOutput'
  >,
): Promise<GenericAgentInvocationOutcome | { status: 200; body: AcceptedStagedEvidence }> {
  const s = prepared.binding.source;
  const outcome = await invokeGenericAgent(
    {
      agent: 'saakshi',
      tenantId: s.tenant_id,
      actorId: s.actor_id,
      engagementId: s.engagement_id,
      correlationId: s.operation_key,
      input: s,
    },
    {
      ...deps,
      stagedEvidence: stagedEvidenceInvocationHook(rpc, prepared),
      validateOutput: (output) => {
        validateStagedEvidenceOutput(output, s);
      },
    },
  );
  if (outcome.status !== 200) return outcome;
  const accepted = await recoverStagedEvidence(
    rpc,
    s.tenant_id,
    s.actor_id,
    s.operation_key,
    prepared.bodyHash,
  );
  return {
    status: 200 as const,
    body: acceptedStagedEvidenceResult(accepted),
  };
}
