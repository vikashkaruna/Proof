import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AgentName } from '@axiom/types';
import { z } from 'zod';
import { WorkloadTaskAuthority, WorkloadTaskRefused } from './tasks.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const authorization = z
  .object({
    tenantId: z.uuid(),
    runId: z.uuid(),
    workloadProof: z.string().min(1).max(16384),
    taskProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const finding = z
  .object({
    control_id: z.string().min(1).max(200),
    score: z.number().min(0).max(100),
    risk_points: z.number().min(0).max(99999.99),
    rationale: z.string().min(1).max(4000),
  })
  .strict();
const declaration = z
  .object({
    value: z.boolean().nullable(),
    provenance: z.enum(['unknown', 'caller_declared_unverified']),
  })
  .strict()
  .refine((v) => v.provenance === (v.value === null ? 'unknown' : 'caller_declared_unverified'));
const questionDeclaration = z
  .object({
    question_id: z.string().min(1).max(200),
    declaration: z.enum(['unknown', 'caller_affirmed', 'caller_denied']),
  })
  .strict();
const provenanceControl = z
  .object({
    control_id: z.string().min(1).max(200),
    questions: z.array(questionDeclaration).max(1000),
    known_boolean_question_count: z.number().int().min(0).max(1000),
    caller_affirmed_count: z.number().int().min(0).max(1000),
    caller_denied_count: z.number().int().min(0).max(1000),
    unknown_count: z.number().int().min(0).max(1000),
    answer_state: z.enum([
      'unknown',
      'partially_answered',
      'caller_declared_unverified',
      'not_boolean_assessable',
    ]),
    applicability_state: z.enum([
      'unconditional',
      'unknown',
      'caller_declared_applicable_unverified',
      'caller_declared_not_applicable_unverified',
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const total = value.questions.length;
    const yes = value.questions.filter((q) => q.declaration === 'caller_affirmed').length;
    const no = value.questions.filter((q) => q.declaration === 'caller_denied').length;
    const unknown = total - yes - no;
    const state =
      total === 0
        ? 'not_boolean_assessable'
        : unknown === total
          ? 'unknown'
          : unknown
            ? 'partially_answered'
            : 'caller_declared_unverified';
    if (
      new Set(value.questions.map((q) => q.question_id)).size !== total ||
      value.known_boolean_question_count !== total ||
      value.caller_affirmed_count !== yes ||
      value.caller_denied_count !== no ||
      value.unknown_count !== unknown ||
      value.answer_state !== state
    )
      ctx.addIssue({ code: 'custom', message: 'Question declaration binding refused' });
  });
export const questionnaireProvenanceSchema = z
  .object({
    version: z.literal(1),
    source_library_version: z.string().min(1).max(200),
    source_library_digest: digest.nullable(),
    estimates: z.literal('provisional'),
    review_required: z.literal(true),
    controls: z.array(provenanceControl).min(1).max(500),
    applicability: z
      .object({
        sdf_self_attested: declaration,
        processes_children: declaration,
        processes_health: declaration,
      })
      .strict(),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 262144, {
    message: 'Questionnaire provenance size limit exceeded',
  });
export type QuestionnaireProvenance = z.infer<typeof questionnaireProvenanceSchema>;
export const assessmentResult = z
  .object({
    library_version: z.string().min(1).max(200),
    posture_score: z.number().min(0).max(100),
    estimated_exposure_inr: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    findings: z.array(finding).min(1).max(500),
    questionnaire_provenance: questionnaireProvenanceSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const provenance = value.questionnaire_provenance;
    if (!provenance) return;
    const ids = provenance.controls.map((c) => c.control_id);
    if (
      provenance.source_library_version !== value.library_version ||
      new Set(ids).size !== ids.length ||
      new Set(value.findings.map((f) => f.control_id)).size !== value.findings.length ||
      ids.length !== value.findings.length ||
      value.findings.some((f) => !ids.includes(f.control_id))
    )
      ctx.addIssue({ code: 'custom', message: 'Control provenance binding refused' });
  });
const pinnedControls = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      library_version: z.string().min(1).max(200),
      sdf_only: z.boolean(),
      children_only: z.boolean(),
      assessment_questions: z
        .array(z.object({ id: z.string().min(1).max(200), type: z.string().min(1).max(100) }))
        .max(1000),
    }),
  )
  .min(1)
  .max(500)
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 262144, {
    message: 'Pinned questionnaire source size limit exceeded',
  });

/** Validate against an actual trusted immutable packet; no rationale parsing,
 * caller-provided library substitute or legacy inference is permitted. */
export function validateAssessmentProvenance(
  result: unknown,
  controls: unknown,
  expectedLibraryDigest: string,
) {
  const parsed = assessmentResult.parse(result);
  const provenance = parsed.questionnaire_provenance;
  if (!provenance) return { status: 'unavailable' as const, provenance: null };
  if (provenance.source_library_digest !== digest.parse(expectedLibraryDigest))
    throw new WorkloadTaskRefused();
  const library = pinnedControls.parse(controls);
  if (
    new Set(library.map((c) => c.id)).size !== library.length ||
    library.length !== provenance.controls.length
  )
    throw new WorkloadTaskRefused();
  for (const control of library) {
    const declared = provenance.controls.find((c) => c.control_id === control.id);
    const questions = control.assessment_questions
      .filter((q) => q.type === 'boolean')
      .map((q) => q.id);
    if (
      !declared ||
      control.library_version !== parsed.library_version ||
      new Set(questions).size !== questions.length ||
      declared.questions.length !== questions.length ||
      declared.questions.some((q) => !questions.includes(q.question_id))
    )
      throw new WorkloadTaskRefused();
    const required = [];
    if (control.sdf_only) required.push(provenance.applicability.sdf_self_attested.value);
    if (control.children_only) required.push(provenance.applicability.processes_children.value);
    const applicable = !required.length
      ? 'unconditional'
      : required.some((v) => v === false)
        ? 'caller_declared_not_applicable_unverified'
        : required.some((v) => v === null)
          ? 'unknown'
          : 'caller_declared_applicable_unverified';
    if (declared.applicability_state !== applicable) throw new WorkloadTaskRefused();
  }
  return { status: 'available_unverified' as const, provenance };
}
const startRequest = z.object({ authorization, inputHash: digest }).strict();
const completeRequest = z
  .object({
    authorization,
    libraryDigest: digest,
    result: assessmentResult,
  })
  .strict();
const packetSchema = z
  .object({
    engagement_id: z.uuid(),
    library_version: z.string().min(1).max(200),
    library_digest: digest,
    controls: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
    started_receipt: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
const receiptSchema = z
  .object({
    completed_receipt: z.string().regex(/^[1-9][0-9]*$/),
    result_digest: digest,
  })
  .strict();

/** Private, fixed-purpose tools. Each call authenticates the current SVID,
 * registration and delegated task. SQL repeats live context checks and locks
 * through the atomic write. No caller may select an agent, RPC or database table.
 * Neither credentials nor raw adapter errors leave this boundary. */
export class AssessmentTools {
  readonly #packets = new Map<
    string,
    {
      inputHash: string;
      workloadId: string;
      expiresAt: number;
      libraryDigest: string;
      libraryVersion: string;
      engagementId: string;
      controls: z.infer<typeof pinnedControls>;
    }
  >();
  constructor(
    private readonly authority: Pick<WorkloadTaskAuthority, 'authorize'>,
    private readonly db: SupabaseClient,
  ) {}
  async start(request: unknown) {
    try {
      const input = startRequest.parse(request);
      const task = await this.authority.authorize(
        { ...input.authorization, agentName: AgentName.PARIKSHAN },
        'control_library.read',
      );
      if (!task.engagementId || task.inputHash !== input.inputHash) throw new WorkloadTaskRefused();
      for (const [key, cached] of this.#packets)
        if (cached.expiresAt <= Date.now()) this.#packets.delete(key);
      const key = `${task.tenantId}:${task.runId}`;
      if (!this.#packets.has(key) && this.#packets.size >= 32) throw new WorkloadTaskRefused();
      const { data, error } = await this.db.rpc('start_workload_assessment', {
        ...this.arguments(input.authorization.taskProof, task),
        p_input_hash: task.inputHash,
      });
      if (error) throw new WorkloadTaskRefused();
      const packet = packetSchema.parse(data);
      if (packet.engagement_id !== task.engagementId) throw new WorkloadTaskRefused();
      const source = pinnedControls.safeParse(packet.controls);
      if (source.success)
        this.#packets.set(key, {
          inputHash: task.inputHash,
          workloadId: task.workloadId,
          expiresAt: task.expiresAt,
          libraryDigest: packet.library_digest,
          libraryVersion: packet.library_version,
          engagementId: task.engagementId,
          controls: source.data,
        });
      else this.#packets.delete(key);
      return packet;
    } catch {
      throw new WorkloadTaskRefused();
    }
  }
  async complete(request: unknown) {
    try {
      const input = completeRequest.parse(request);
      const task = await this.authority.authorize(
        { ...input.authorization, agentName: AgentName.PARIKSHAN },
        'findings.write',
      );
      if (!task.engagementId) throw new WorkloadTaskRefused();
      if (input.result.questionnaire_provenance) {
        const packet = this.#packets.get(`${task.tenantId}:${task.runId}`);
        if (
          !packet ||
          packet.expiresAt <= Date.now() ||
          packet.inputHash !== task.inputHash ||
          packet.workloadId !== task.workloadId ||
          packet.libraryDigest !== input.libraryDigest ||
          packet.libraryVersion !== input.result.library_version ||
          packet.engagementId !== task.engagementId
        )
          throw new WorkloadTaskRefused();
        validateAssessmentProvenance(input.result, packet.controls, packet.libraryDigest);
      }
      const { data, error } = await this.db.rpc('complete_workload_assessment', {
        ...this.arguments(input.authorization.taskProof, task),
        p_library_digest: input.libraryDigest,
        p_result: input.result,
      });
      if (error) throw new WorkloadTaskRefused();
      return receiptSchema.parse(data);
    } catch {
      throw new WorkloadTaskRefused();
    }
  }
  private arguments(proof: string, task: Awaited<ReturnType<WorkloadTaskAuthority['authorize']>>) {
    if (task.expiresAt <= Date.now()) throw new WorkloadTaskRefused();
    return {
      p_tenant_id: task.tenantId,
      p_run_id: task.runId,
      p_workload_id: task.workloadId,
      p_proof_hash: createHash('sha256').update(proof, 'ascii').digest('hex'),
      p_identity_expires_at: new Date(task.expiresAt).toISOString(),
    };
  }
}
