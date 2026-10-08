/** Narrow runtime-facing source capability. Parent supplies internal HTTP mount. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@axiom/ledger';
import { z } from 'zod';
import {
  retainedStageSource,
  stageBindingSchema,
  StageUnconfirmed,
  type StageBinding,
} from './saakshi-staging-port.js';
import {
  recordStagedObservation,
  callEvidenceController,
  type EvidenceControllerRpc,
} from './saakshi-evidence-controller.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z
  .object({ signed_text: z.string().min(1).max(32000), signature: digest })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal(1),
    input_text: z.string().min(1).max(16000),
    correlation_id: z.uuid(),
    dispatch_context: z.object({ run_id: z.uuid(), request_hash: digest }).strict(),
    expires_at: z.number().int().positive(),
  })
  .strict();
export async function stageFromSignedRuntime(
  raw: unknown,
  authorization: string | undefined,
  config: {
    peerSecret: string;
    sourceSecret: string;
    otherSecrets: readonly string[];
    rpc: EvidenceControllerRpc;
    stage: (binding: StageBinding) => Promise<unknown>;
    now?: () => number;
  },
) {
  try {
    if (
      config.peerSecret.length < 32 ||
      config.sourceSecret.length < 32 ||
      config.peerSecret === config.sourceSecret ||
      config.otherSecrets.includes(config.sourceSecret)
    )
      throw new StageUnconfirmed();
    const expectedPeer = Buffer.from('Bearer ' + config.peerSecret),
      actualPeer = Buffer.from(authorization ?? '');
    if (actualPeer.length !== expectedPeer.length || !timingSafeEqual(actualPeer, expectedPeer))
      throw new StageUnconfirmed();
    const request = requestSchema.parse(raw);
    if (Buffer.byteLength(request.signed_text) > 32000) throw new StageUnconfirmed();
    const expected = createHmac('sha256', config.sourceSecret)
      .update('axiom-saakshi-stage-v1\0')
      .update(request.signed_text)
      .digest();
    if (!timingSafeEqual(Buffer.from(request.signature, 'hex'), expected))
      throw new StageUnconfirmed();
    const envelope = envelopeSchema.parse(JSON.parse(request.signed_text));
    if (canonicalJson(envelope) !== request.signed_text) throw new StageUnconfirmed();
    const now = (config.now ?? Date.now)();
    const remaining = envelope.expires_at - now / 1000;
    if (remaining <= 0 || remaining > 120 || Buffer.byteLength(envelope.input_text) > 16000)
      throw new StageUnconfirmed();
    const source = retainedStageSource.parse(JSON.parse(envelope.input_text));
    if (
      canonicalJson(source) !== envelope.input_text ||
      createHash('sha256').update(envelope.input_text).digest('hex') !==
        envelope.dispatch_context.request_hash ||
      source.operation_key !== envelope.correlation_id
    )
      throw new StageUnconfirmed();
    const bound = await callEvidenceController(config.rpc, 'bind_saakshi119_stage', {
      t: source.tenant_id,
      a: source.actor_id,
      runid: envelope.dispatch_context.run_id,
      k: envelope.correlation_id,
      ih: envelope.dispatch_context.request_hash,
    });
    const binding = stageBindingSchema.parse(bound);
    if (
      canonicalJson(binding.source) !== envelope.input_text ||
      binding.runId !== envelope.dispatch_context.run_id ||
      binding.correlationId !== envelope.correlation_id
    )
      throw new StageUnconfirmed();
    const observation = await recordStagedObservation(
      config.rpc,
      binding,
      await config.stage(binding),
    );
    return observation.output.receipt;
  } catch {
    throw new StageUnconfirmed();
  }
}
