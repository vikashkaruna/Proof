/** Private controller core, mounted only through the dedicated isolated runtime.
 * SQL locks persisted facts; no caller, issuer or credential provisioning seam.
 * External revocation cannot be made atomic with a separate database commit. */
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import {
  AgentName,
  prativedanAssessmentClaimSchema,
  prativedanAssessmentJournalSchema,
  prativedanAssessmentRendererInputSchema,
  prativedanAssessmentSettlementSchema,
} from '@axiom/types';
import { JwtSvidVerifier, workloadTrustDomain } from './jwt-svid.js';
import { WorkloadAuthenticator } from './registration.js';
import type { PrativedanAssessmentAdmissionPorts } from './prativedan-assessment-admission.js';
import {
  prativedanAssessmentHumanContextSchema,
  type PrativedanAssessmentRpcClient,
} from '../services/prativedan-assessment-draft-store.js';
import { preparePrativedanAssessmentDraftSource } from '../services/prativedan-assessment-draft-source.js';
import { parsePrativedanAssessmentJson } from '../services/prativedan-assessment-json.js';
import {
  prativedanAssessmentRuntimeEnvelopeSchema,
  verifyPrativedanAssessmentReceiptWitness,
  verifyPrativedanAssessmentDraftOutput,
} from '../services/prativedan-assessment-draft-output.js';

const uuid = prativedanAssessmentHumanContextSchema.shape.tenantId;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(19)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const selectionSchema = z.strictObject({
  tenantId: uuid,
  operationKey: uuid,
  runId: uuid,
  requestSha256: digest,
  sourceSha256: digest,
});
const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('load') }),
  z.strictObject({ kind: z.literal('accounted-read') }),
  z.strictObject({ kind: z.literal('accounting-witness') }),
  z.strictObject({
    kind: z.literal('accounted-start'),
    inputText: z.string().min(1).max(1048576),
    taskSha256: digest,
  }),
  z.strictObject({ kind: z.literal('claim'), inputText: z.string().min(1).max(1048576) }),
  z.strictObject({
    kind: z.literal('phase'),
    phase: z.enum(['started', 'completed']),
    outputHash: digest.nullable(),
  }),
  z.strictObject({ kind: z.literal('receipts'), started: receiptId, completed: receiptId }),
  z.strictObject({
    kind: z.literal('settle'),
    envelope: prativedanAssessmentRuntimeEnvelopeSchema,
  }),
]);
export interface PrativedanAssessmentAtomicPorts extends PrativedanAssessmentAdmissionPorts {
  /** Exclusive, tenant-bound service custody. No agent/service writer fallback. */
  controllerWriterFactory(): PrativedanAssessmentRpcClient;
}
export class PrativedanAtomicRefused extends Error {
  constructor() {
    super('Prativedan dedicated controller refused.');
  }
}
export class PrativedanAtomicOutcomeUnknown extends Error {
  constructor() {
    super('Prativedan controller outcome unknown; do not reinvoke.');
  }
}

export class PrativedanAssessmentAtomicController {
  private readonly domain: string;
  private readonly verifier: JwtSvidVerifier;
  constructor(
    configuration: unknown,
    private readonly ports: PrativedanAssessmentAtomicPorts,
  ) {
    this.domain = z
      .strictObject({ trustDomain: workloadTrustDomain })
      .parse(configuration).trustDomain;
    if (typeof ports.controllerWriterFactory !== 'function') throw new PrativedanAtomicRefused();
    this.verifier = new JwtSvidVerifier(
      {
        audience: 'axiom-prativedan-assessment-tools',
        trustDomains: [this.domain],
        maxLifetimeSeconds: 300,
      },
      ports.trust,
    );
  }
  async perform(token: string, rawSelection: unknown, rawCommand: unknown): Promise<unknown> {
    let selected: z.infer<typeof selectionSchema>;
    let command: z.infer<typeof commandSchema>;
    let prepared: ReturnType<typeof preparePrativedanAssessmentDraftSource>;
    let authority: Record<string, unknown>;
    let beforeCall: () => Promise<void>;
    try {
      selected = Object.freeze(selectionSchema.parse(rawSelection));
      command = commandSchema.parse(rawCommand);
      const authenticate = async () => {
        let version: number | undefined;
        const auth = new WorkloadAuthenticator(this.verifier, {
          find: async (tenantId, spiffeId) => {
            if (spiffeId !== `spiffe://${this.domain}/agent/prativedan`)
              throw new PrativedanAtomicRefused();
            const registration = z
              .strictObject({
                id: uuid,
                tenant_id: uuid,
                agent_name: z.literal(AgentName.PRATIVEDAN),
                spiffe_id: z.literal(`spiffe://${this.domain}/agent/prativedan`),
                status: z.literal('active'),
                version: z.number().int().positive().max(2147483647),
              })
              .parse(await this.ports.registrations.find(tenantId, spiffeId));
            version = registration.version;
            const { version: _version, ...row } = registration;
            return row;
          },
        });
        const identity = await auth.authenticate(
          token,
          selected.tenantId,
          AgentName.PRATIVEDAN,
          'report.write',
        );
        if (
          version === undefined ||
          (await this.ports.trust.stillCurrent(identity.trustDomain, identity.bundleRevision)) !==
            true ||
          identity.expiresAt <= Date.now()
        )
          throw new PrativedanAtomicRefused();
        return { ...identity, registrationVersion: version };
      };
      const first = await authenticate();
      // A live Workload API read renews its bounded observation deadline.
      // Compare the principal/registration/bundle facts, not the wall-clock
      // freshness deadline; each authenticate independently refuses expiry.
      const identityFacts = (value: typeof first) => {
        const { expiresAt: _expiresAt, ...facts } = value;
        return canonicalJson(facts);
      };
      const human = async () => {
        const context = prativedanAssessmentHumanContextSchema.parse(
          await this.ports.resolveCurrentHuman(selected),
        );
        if (context.tenantId !== selected.tenantId) throw new PrativedanAtomicRefused();
        await this.ports.authorizeCurrentHuman(context);
        if (await this.ports.isKilled(selected.tenantId)) throw new PrativedanAtomicRefused();
        return context;
      };
      const context = await human();
      const original = await this.ports.loadOriginalRequestedJournal(selected, context);
      prepared = preparePrativedanAssessmentDraftSource(
        original.journal,
        original.reviewedRequestText,
      );
      const journal = prepared.journal;
      if (
        journal.tenant_id !== selected.tenantId ||
        journal.actor_id !== context.actorId ||
        journal.operation_key !== selected.operationKey ||
        journal.run_id !== selected.runId ||
        journal.request_sha256 !== selected.requestSha256 ||
        journal.source_sha256 !== selected.sourceSha256
      )
        throw new PrativedanAtomicRefused();
      if (command.kind === 'claim' || command.kind === 'accounted-start') {
        const input = prativedanAssessmentRendererInputSchema.parse(
          parsePrativedanAssessmentJson(command.inputText),
        );
        if (
          Buffer.byteLength(command.inputText, 'utf8') > 1048576 ||
          canonicalJson(input) !== canonicalJson(prepared.rendererInput)
        )
          throw new PrativedanAtomicRefused();
      }
      if (
        !['load', 'claim', 'accounted-start', 'accounted-read', 'accounting-witness'].includes(
          command.kind,
        ) &&
        journal.state === 'requested'
      )
        throw new PrativedanAtomicRefused();
      if (
        command.kind === 'phase' &&
        (command.phase === 'started') !== (command.outputHash === null)
      )
        throw new PrativedanAtomicRefused();
      if (canonicalJson(context) !== canonicalJson(await human()))
        throw new PrativedanAtomicRefused();
      const final = await authenticate();
      if (identityFacts(first) !== identityFacts(final)) throw new PrativedanAtomicRefused();
      authority = {
        actor_id: context.actorId,
        session_id: context.sessionId,
        workload_id: final.workloadId,
        registration_version: final.registrationVersion,
        subject: final.spiffeId,
        svid_expires_at: new Date(final.expiresAt).toISOString(),
      };
      beforeCall = async () => {
        if (canonicalJson(context) !== canonicalJson(await human()))
          throw new PrativedanAtomicRefused();
        if (identityFacts(first) !== identityFacts(await authenticate()))
          throw new PrativedanAtomicRefused();
      };
    } catch {
      throw new PrativedanAtomicRefused();
    }
    const journal = prepared.journal;
    const scope = {
      t: journal.tenant_id,
      k: journal.operation_key,
      r: journal.run_id,
      rh: journal.request_sha256,
      authority,
    };
    const matchesOriginal = (retained: ReturnType<typeof preparePrativedanAssessmentDraftSource>) =>
      retained.journal.tenant_id === journal.tenant_id &&
      retained.journal.operation_key === journal.operation_key &&
      retained.journal.actor_id === journal.actor_id &&
      retained.journal.run_id === journal.run_id &&
      retained.journal.request_sha256 === journal.request_sha256 &&
      retained.journal.source_sha256 === journal.source_sha256 &&
      retained.journal.source_text === journal.source_text &&
      retained.journal.renderer_config_text === journal.renderer_config_text &&
      canonicalJson(retained.rendererInput) === canonicalJson(prepared.rendererInput);
    const rpc = async (name: string, args: Record<string, unknown>) => {
      try {
        await beforeCall();
      } catch {
        throw new PrativedanAtomicRefused();
      }
      const result = await this.ports
        .controllerWriterFactory()
        .rpc(name, args)
        .abortSignal(AbortSignal.timeout(15000));
      if (result.error) throw new PrativedanAtomicOutcomeUnknown();
      return result.data;
    };
    try {
      if (command.kind === 'accounting-witness')
        return rpc('prativedan_read_model_accounting_result', scope);
      if (command.kind === 'accounted-read') return rpc('read_prativedan_accounted_draft', scope);
      if (command.kind === 'accounted-start') {
        const admitted = await rpc('start_prativedan_accounted_draft', {
          ...scope,
          input_text: command.inputText,
          task_sha256: command.taskSha256,
        });
        // Private controller custody only. This original authority is never sent
        // to a browser/worker and cannot authorize a new task or model start.
        return { admitted, originalAuthority: authority };
      }
      if (command.kind === 'load') {
        const value = prativedanAssessmentJournalSchema.parse(
          await rpc('load_prativedan_assessment_dispatch', scope),
        );
        const retained = preparePrativedanAssessmentDraftSource(
          value,
          prepared.reviewedRequestText,
        );
        if (!matchesOriginal(retained)) throw new PrativedanAtomicOutcomeUnknown();
        return value;
      }
      if (command.kind === 'claim') {
        const value = prativedanAssessmentClaimSchema.parse(
          await rpc('claim_prativedan_assessment_draft', {
            ...scope,
            input_text: command.inputText,
          }),
        );
        const retained = preparePrativedanAssessmentDraftSource(
          value.readback,
          prepared.reviewedRequestText,
        );
        if (
          !matchesOriginal(retained) ||
          !('normalized_input_text' in retained.journal) ||
          retained.journal.normalized_input_text !== command.inputText
        )
          throw new PrativedanAtomicOutcomeUnknown();
        return value;
      }
      if (command.kind === 'phase')
        return z.strictObject({ id: receiptId, entry_hash: digest }).parse(
          await rpc('record_prativedan_assessment_phase', {
            ...scope,
            phase_name: command.phase,
            output_hash: command.outputHash,
          }),
        );
      const envelope = command.kind === 'settle' ? command.envelope : undefined;
      const started =
        envelope?.started_receipt.id ?? (command.kind === 'receipts' ? command.started : '');
      const completed =
        envelope?.completed_receipt.id ?? (command.kind === 'receipts' ? command.completed : '');
      const witness = verifyPrativedanAssessmentReceiptWitness(
        prepared,
        await rpc('read_prativedan_assessment_runtime_receipts', { ...scope, started, completed }),
      );
      if (command.kind === 'receipts') {
        if (witness.started_receipt.id !== started || witness.completed_receipt.id !== completed)
          throw new PrativedanAtomicOutcomeUnknown();
        return witness;
      }
      if (!envelope) throw new PrativedanAtomicOutcomeUnknown();
      const verified = verifyPrativedanAssessmentDraftOutput(prepared, envelope, witness);
      const value = prativedanAssessmentSettlementSchema.parse(
        await rpc('settle_prativedan_assessment_draft', {
          ...scope,
          input_hash: verified.runtimeNormalizedInputSha256,
          config_text: envelope.renderer_config_text,
          output_text: envelope.runtime_output_text,
          response_text: verified.responseOutputText,
          started,
          completed,
        }),
      );
      const { replayed, ...retained } = value;
      verifyPrativedanAssessmentDraftOutput(
        preparePrativedanAssessmentDraftSource(retained, prepared.reviewedRequestText),
        envelope,
        witness,
      );
      return { ...retained, replayed };
    } catch (error) {
      if (error instanceof PrativedanAtomicRefused) throw error;
      throw new PrativedanAtomicOutcomeUnknown();
    }
  }
}
