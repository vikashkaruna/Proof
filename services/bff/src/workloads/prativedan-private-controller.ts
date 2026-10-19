import { z } from 'zod';
import { sessionIdFromAccessToken } from '@axiom/supabase';
import type { User } from '@supabase/supabase-js';
import { JwtSvidVerifier, type JwtTrustSource } from './jwt-svid.js';
import { PrativedanAssessmentAtomicController } from './prativedan-assessment-atomic-controller.js';
import { PrativedanAccountedRuntime } from './prativedan-accounted-runtime.js';
import type { AssessmentProcessFactory } from './assessment-channel.js';
import type { PrativedanAssessmentRpcClient } from '../services/prativedan-assessment-draft-store.js';
import type { PrativedanAssessmentAdmissionSelection } from './prativedan-assessment-admission.js';
import type { PrativedanAssessmentRuntimeBinding } from '../services/prativedan-assessment-draft-controller.js';
import { prativedanTextHash } from '../services/prativedan-draft-source.js';

export const prativedanPrivateRequestSchema = z.strictObject({
  // Never persist/log this bearer; private Unix transport only, independently
  // checked against GoTrue on every fresh operation inside this controller.
  humanBearer: z.string().min(32).max(16384),
  binding: z.strictObject({
    tenant_id: z.uuid(),
    actor_id: z.uuid(),
    operation_key: z.uuid(),
    engagement_id: z.uuid(),
    assessment_run_id: z.uuid(),
    source_id: z.uuid(),
    run_id: z.uuid(),
    request_text: z.string().min(1).max(4096),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  command: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('invoke') }),
    z.strictObject({ kind: z.literal('recover') }),
    z.strictObject({ kind: z.literal('atomic'), command: z.unknown() }),
  ]),
});
const registrationSchema = z.strictObject({
  id: z.uuid(),
  tenant_id: z.uuid(),
  agent_name: z.literal('prativedan'),
  spiffe_id: z.string(),
  status: z.literal('active'),
  version: z.number().int().positive(),
});

/** Concrete private request composition. No caller-supplied actor assertions,
 * table SELECT, service writer, peer shared secret or fallback authority. */
export class PrativedanPrivateController {
  constructor(
    private readonly config: {
      trustDomain: string;
      tenantId: string;
      trust: JwtTrustSource;
      token(): Promise<string>;
      currentUser(bearer: string): Promise<User>;
      writer: PrativedanAssessmentRpcClient;
      computation: AssessmentProcessFactory;
      renderer: AssessmentProcessFactory;
    },
  ) {}
  async handle(raw: unknown) {
    const request = prativedanPrivateRequestSchema.parse(raw);
    const b: PrativedanAssessmentRuntimeBinding = request.binding;
    if (b.tenant_id !== this.config.tenantId) throw new Error('prativedan_private_scope_refused');
    const subject = `spiffe://${this.config.trustDomain}/agent/prativedan`;
    const verifier = new JwtSvidVerifier(
      {
        audience: 'axiom-prativedan-assessment-tools',
        trustDomains: [this.config.trustDomain],
        maxLifetimeSeconds: 300,
      },
      this.config.trust,
    );
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const reply = await this.config.writer
        .rpc(name, args)
        .abortSignal(AbortSignal.timeout(15000));
      if (reply.error) throw new Error('prativedan_controller_unavailable');
      return reply.data;
    };
    const registration = async () => {
      const row = registrationSchema.parse(
        await rpc('read_prativedan_accounted_registration', { t: b.tenant_id, subject }),
      );
      if (row.tenant_id !== b.tenant_id || row.spiffe_id !== subject) throw new Error();
      return row;
    };
    const human = async () => {
      const user = await this.config.currentUser(request.humanBearer);
      const sessionId = sessionIdFromAccessToken(request.humanBearer);
      if (user.id !== b.actor_id || !sessionId) throw new Error('prativedan_current_human_refused');
      return { tenantId: b.tenant_id, actorId: user.id, sessionId };
    };
    const authority = async () => {
      const token = await this.config.token();
      const identity = await verifier.verify(token);
      const row = await registration();
      if (
        identity.spiffeId !== subject ||
        !(await this.config.trust.stillCurrent(identity.trustDomain, identity.bundleRevision))
      )
        throw new Error();
      const actor = await human();
      return {
        actor_id: actor.actorId,
        session_id: actor.sessionId,
        workload_id: row.id,
        registration_version: row.version,
        subject,
        svid_expires_at: new Date(identity.expiresAt).toISOString(),
      };
    };
    const journal = async (selected: PrativedanAssessmentAdmissionSelection) => {
      if (
        selected.tenantId !== b.tenant_id ||
        selected.operationKey !== b.operation_key ||
        selected.runId !== b.run_id ||
        selected.requestSha256 !== prativedanTextHash(b.request_text) ||
        selected.sourceSha256 !== b.source_sha256
      )
        throw new Error();
      return rpc('read_prativedan_accounted_context', {
        t: b.tenant_id,
        k: b.operation_key,
        r: b.run_id,
        rh: selected.requestSha256,
        authority: await authority(),
      });
    };
    const atomic = new PrativedanAssessmentAtomicController(
      { trustDomain: this.config.trustDomain },
      {
        trust: this.config.trust,
        registrations: {
          find: async (t, s) => {
            if (t !== b.tenant_id || s !== subject) throw new Error();
            return registration();
          },
        },
        resolveCurrentHuman: human,
        authorizeCurrentHuman: async (context) => {
          if (JSON.stringify(context) !== JSON.stringify(await human())) throw new Error();
          await journal({
            tenantId: b.tenant_id,
            operationKey: b.operation_key,
            runId: b.run_id,
            requestSha256: prativedanTextHash(b.request_text),
            sourceSha256: b.source_sha256,
          });
        },
        // The current SQL context independently checks both global and tenant
        // kill state; no false fallback when that read is unavailable.
        isKilled: async () => {
          await journal({
            tenantId: b.tenant_id,
            operationKey: b.operation_key,
            runId: b.run_id,
            requestSha256: prativedanTextHash(b.request_text),
            sourceSha256: b.source_sha256,
          });
          return false;
        },
        loadOriginalRequestedJournal: async (selected) => ({
          journal: await journal(selected),
          reviewedRequestText: b.request_text,
        }),
        controllerWriterFactory: () => this.config.writer,
      },
    );
    const runtime = new PrativedanAccountedRuntime({
      atomic,
      token: this.config.token,
      controllerWriterFactory: () => this.config.writer,
      computation: this.config.computation,
      renderer: this.config.renderer,
      requireOriginalWorkload: async (original) => {
        const identity = await verifier.verify(await this.config.token());
        const row = await registration();
        if (
          identity.spiffeId !== original.subject ||
          row.id !== original.workload_id ||
          row.version !== original.registration_version ||
          !(await this.config.trust.stillCurrent(identity.trustDomain, identity.bundleRevision))
        )
          throw new Error('prativedan_original_workload_refused');
      },
    });
    if (request.command.kind === 'invoke') return runtime.invoke(b);
    if (request.command.kind === 'recover') return runtime.recover(b);
    // Only fixed AtomicController commands parse here. High-entropy task proof
    // and terminal writer remain local and cannot be called over this channel.
    const command = z
      .strictObject({
        kind: z.enum(['load', 'receipts', 'settle', 'accounting-witness']),
        started: z.string().optional(),
        completed: z.string().optional(),
        envelope: z.unknown().optional(),
      })
      .parse(request.command.command);
    return atomic.perform(
      await this.config.token(),
      {
        tenantId: b.tenant_id,
        operationKey: b.operation_key,
        runId: b.run_id,
        requestSha256: prativedanTextHash(b.request_text),
        sourceSha256: b.source_sha256,
      },
      command,
    );
  }
}
