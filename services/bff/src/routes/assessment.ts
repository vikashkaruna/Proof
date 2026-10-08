import { Hono } from 'hono';
import { z } from 'zod';
import { createSupabaseAdmin } from '@axiom/supabase';
import { AssessmentSnapshotSchema, Capability, type AssessmentControl } from '@axiom/types';
import { requireCapability } from '../middleware/authorize.js';
import type { Variables } from '../types.js';
import { canonicalJson } from '@axiom/ledger';
import { assessmentResult, validateAssessmentProvenance } from '../workloads/assessment-tools.js';
import { assessmentQuestionnaireRoutes } from './assessment-questionnaire.js';

const nullableNumber = z
  .union([z.number(), z.string().min(1)])
  .transform(Number)
  .pipe(z.number().finite().nonnegative())
  .nullable();
const engagementSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  library_version: z.string(),
  status: z.string(),
  estimated_exposure_inr: nullableNumber.pipe(
    z.number().int().max(Number.MAX_SAFE_INTEGER).nullable(),
  ),
});
const controlSchema = z.object({
  id: z.string(),
  title: z.string(),
  domain: z.string(),
  citations: z.array(z.object({ instrument: z.string(), reference: z.string() })),
  library_version: z.string().optional(),
  assessment_questions: z.array(z.record(z.string(), z.unknown())).optional(),
  sdf_only: z.boolean().optional(),
  children_only: z.boolean().optional(),
});
const findingSchema = z.object({
  control_id: z.string(),
  score: nullableNumber.pipe(z.number().min(0).max(100)),
  evidence_ids: z.array(z.uuid()),
});
const evidenceSchema = z.object({ id: z.uuid() });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z
  .union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z
      .string()
      .max(19)
      .regex(/^[1-9][0-9]*$/),
  ])
  .transform(String);
const packetSchema = z.object({
  tenant_id: z.uuid(),
  engagement_id: z.uuid(),
  run_id: z.uuid(),
  library_version: z.string(),
  library_digest: digestSchema,
  result_digest: digestSchema,
  controls: z.array(controlSchema).min(1).max(500),
  result: assessmentResult,
  started_receipt: receiptSchema,
  completed_receipt: receiptSchema,
  finalized_receipt: receiptSchema,
  completed_at: z.iso.datetime({ offset: true }),
  finalized_at: z.iso.datetime({ offset: true }),
});
const runSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  engagement_id: z.uuid(),
  agent: z.literal('parikshan'),
  status: z.literal('succeeded'),
  output_redacted_hash: digestSchema,
  completed_at: z.iso.datetime({ offset: true }),
  error: z.null(),
});
const unavailableProvenance = {
  status: 'unavailable' as const,
  runId: null,
  libraryDigest: null,
  estimates: 'provenance_unavailable' as const,
};
const unavailable = {
  error: {
    code: 'assessment_unavailable',
    message: 'Saved assessment results are unavailable. Try again.',
  },
};

/** Read projection only: never starts an assessment, recomputes scores or seals evidence. */
export function assessmentRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.route('/', assessmentQuestionnaireRoutes());
  app.get('/assessment', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const denied = requireCapability(c, Capability.POSTURE_READ);
    if (denied) return denied;
    const rawWanted = c.req.query('engagementId');
    if (rawWanted !== undefined && !z.uuid().safeParse(rawWanted).success)
      return c.json({ error: { code: 'invalid_engagement' } }, 400);
    const wanted = rawWanted?.toLowerCase();
    const tenantId = c.get('tenantId').toLowerCase();
    try {
      const db = createSupabaseAdmin();
      const readSignal = AbortSignal.timeout(10000);
      let engagementQuery = db
        .from('engagements')
        .select('id, title, library_version, status, estimated_exposure_inr')
        .eq('tenant_id', tenantId)
        .abortSignal(readSignal);
      if (wanted) engagementQuery = engagementQuery.eq('id', wanted);
      const [engagementResult, tenantResult] = await Promise.all([
        engagementQuery.order('created_at', { ascending: false }).limit(1).maybeSingle(),
        db.from('tenants').select('is_sdf').eq('id', tenantId).abortSignal(readSignal).single(),
      ]);
      if (engagementResult.error || tenantResult.error) return c.json(unavailable, 503);
      const tenant = z.object({ is_sdf: z.boolean() }).parse(tenantResult.data);
      if (!engagementResult.data) {
        if (wanted) return c.json({ error: { code: 'engagement_not_found' } }, 404);
        return c.json(
          AssessmentSnapshotSchema.parse({
            tenantId,
            engagement: null,
            isSdf: tenant.is_sdf,
            exposureInr: null,
            provenance: unavailableProvenance,
            controls: [],
            summary: { pass: 0, partial: 0, fail: 0, unassessed: 0 },
          }),
        );
      }
      const engagement = engagementSchema.parse(engagementResult.data);
      const [libraryResult, controlResult, findingResult, evidenceResult, packetResult] =
        await Promise.all([
          db
            .from('control_libraries')
            .select('control_count, status')
            .eq('version', engagement.library_version)
            .abortSignal(readSignal)
            .single(),
          db
            .from('controls')
            .select(
              'id, title, domain, citations, library_version, assessment_questions, sdf_only, children_only',
              { count: 'exact' },
            )
            .eq('library_version', engagement.library_version)
            .order('id')
            .abortSignal(readSignal)
            .limit(1000),
          db
            .from('findings')
            .select('control_id, score, evidence_ids', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .eq('engagement_id', engagement.id)
            .eq('library_version', engagement.library_version)
            .abortSignal(readSignal)
            .limit(1000),
          db
            .from('evidence')
            .select('id', { count: 'exact' })
            .eq('tenant_id', tenantId)
            .eq('engagement_id', engagement.id)
            .abortSignal(readSignal)
            .limit(1000),
          db
            .from('workload_assessment_packets')
            .select(
              'tenant_id, engagement_id, run_id, library_version, library_digest, result_digest, controls, result, started_receipt, completed_receipt, finalized_receipt, completed_at, finalized_at',
              { count: 'exact' },
            )
            .eq('tenant_id', tenantId)
            .eq('engagement_id', engagement.id)
            .abortSignal(readSignal)
            .limit(2),
        ]);
      if (
        libraryResult.error ||
        controlResult.error ||
        findingResult.error ||
        evidenceResult.error ||
        packetResult.error
      )
        return c.json(unavailable, 503);
      if (
        [controlResult, findingResult, evidenceResult, packetResult].some(
          (result) => result.count !== result.data?.length,
        )
      )
        return c.json(unavailable, 503);
      const library = z
        .object({
          control_count: z.number().int().positive(),
          status: z.enum(['published', 'deprecated']),
        })
        .parse(libraryResult.data);
      if (library.control_count !== controlResult.data?.length) return c.json(unavailable, 503);
      const definitions = z.array(controlSchema).min(1).max(999).parse(controlResult.data);
      const findings = z.array(findingSchema).max(999).parse(findingResult.data);
      const evidence = new Set(
        z
          .array(evidenceSchema)
          .max(999)
          .parse(evidenceResult.data)
          .map((row) => row.id),
      );
      // Refuse ambiguous/corrupt snapshots instead of presenting one arbitrary row.
      if (
        new Set(definitions.map((row) => row.id)).size !== definitions.length ||
        new Set(findings.map((row) => row.control_id)).size !== findings.length
      )
        return c.json(unavailable, 503);
      const byControl = new Map(findings.map((row) => [row.control_id, row]));
      if (findings.some((row) => !definitions.some((control) => control.id === row.control_id)))
        return c.json(unavailable, 503);
      let provenance: NonNullable<z.infer<typeof AssessmentSnapshotSchema>['provenance']> =
        unavailableProvenance;
      let structured: ReturnType<typeof validateAssessmentProvenance>['provenance'] = null;
      if (packetResult.data.length > 1) return c.json(unavailable, 503);
      if (packetResult.data.length === 1) {
        const packet = packetSchema.parse(packetResult.data[0]);
        if (
          packet.tenant_id !== tenantId ||
          packet.engagement_id !== engagement.id ||
          packet.library_version !== engagement.library_version ||
          packet.result.library_version !== engagement.library_version ||
          new Set([packet.started_receipt, packet.completed_receipt, packet.finalized_receipt])
            .size !== 3 ||
          BigInt(packet.started_receipt) >= BigInt(packet.completed_receipt) ||
          BigInt(packet.completed_receipt) >= BigInt(packet.finalized_receipt) ||
          Date.parse(packet.finalized_at) < Date.parse(packet.completed_at) ||
          new Set(packet.controls.map((row) => row.id)).size !== packet.controls.length ||
          canonicalJson([...packet.controls].sort((a, b) => a.id.localeCompare(b.id))) !==
            canonicalJson([...definitions].sort((a, b) => a.id.localeCompare(b.id)))
        )
          return c.json(unavailable, 503);
        const { data: runData, error: runError } = await db
          .from('agent_runs')
          .select('id,tenant_id,engagement_id,agent,status,output_redacted_hash,completed_at,error')
          .eq('tenant_id', tenantId)
          .eq('id', packet.run_id)
          .abortSignal(readSignal)
          .single();
        if (runError) return c.json(unavailable, 503);
        const run = runSchema.parse(runData);
        if (
          run.id !== packet.run_id ||
          run.tenant_id !== tenantId ||
          run.engagement_id !== engagement.id ||
          run.output_redacted_hash !== packet.result_digest ||
          Date.parse(run.completed_at) !== Date.parse(packet.completed_at) ||
          packet.result.estimated_exposure_inr !== engagement.estimated_exposure_inr ||
          packet.result.findings.length !== packet.controls.length ||
          new Set(packet.result.findings.map((row) => row.control_id)).size !==
            packet.result.findings.length ||
          findings.length !== packet.result.findings.length ||
          packet.result.findings.some((row) => byControl.get(row.control_id)?.score !== row.score)
        )
          return c.json(unavailable, 503);
        // PostgreSQL hashes JSONB text. We validate retained relationships, not
        // claim to recompute that digest from a different JS serialization.
        const checked = validateAssessmentProvenance(
          packet.result,
          packet.controls,
          packet.library_digest,
        );
        structured = checked.provenance;
        provenance = {
          ...unavailableProvenance,
          runId: packet.run_id,
          libraryDigest: packet.library_digest,
        };
        if (structured)
          provenance = {
            status: 'caller_declared_unverified',
            runId: packet.run_id,
            libraryDigest: packet.library_digest,
            estimates: 'provisional',
            applicability: {
              sdfSelfAttested: structured.applicability.sdf_self_attested,
              processesChildren: structured.applicability.processes_children,
              processesHealth: structured.applicability.processes_health,
            },
          };
      }
      const questionnaire = new Map(structured?.controls.map((row) => [row.control_id, row]) ?? []);
      const controls: AssessmentControl[] = definitions.map((control) => {
        const finding = byControl.get(control.id);
        const score = finding?.score ?? null;
        const answers = questionnaire.get(control.id);
        const scoreBand =
          score === null ? null : score >= 80 ? 'pass' : score >= 40 ? 'partial' : 'fail';
        const answerState = answers?.answer_state ?? 'unavailable';
        const applicabilityState = answers?.applicability_state ?? 'unavailable';
        return {
          id: control.id,
          name: control.title,
          domain: control.domain,
          cite: control.citations.map((cite) => `${cite.instrument} ${cite.reference}`).join(' · '),
          score,
          scoreBand,
          answerState,
          applicabilityState,
          ...(answers
            ? {
                answerCounts: {
                  knownBooleanQuestions: answers.known_boolean_question_count,
                  callerAffirmed: answers.caller_affirmed_count,
                  callerDenied: answers.caller_denied_count,
                  unknown: answers.unknown_count,
                },
              }
            : {}),
          status:
            score === null
              ? 'unassessed'
              : applicabilityState === 'caller_declared_not_applicable_unverified'
                ? 'not_applicable'
                : applicabilityState === 'unknown' ||
                    answerState === 'unknown' ||
                    answerState === 'partially_answered' ||
                    answerState === 'not_boolean_assessable'
                  ? 'unknown'
                  : scoreBand!,
          evidenceIds: [...new Set(finding?.evidence_ids ?? [])].filter((id) => evidence.has(id)),
        };
      });
      const summary = {
        pass: 0,
        partial: 0,
        fail: 0,
        unassessed: 0,
        unknown: 0,
        not_applicable: 0,
      };
      for (const control of controls) summary[control.status] += 1;
      return c.json(
        AssessmentSnapshotSchema.parse({
          tenantId,
          engagement: {
            id: engagement.id,
            title: engagement.title,
            libraryVersion: engagement.library_version,
            status: engagement.status,
          },
          isSdf: tenant.is_sdf,
          exposureInr: engagement.estimated_exposure_inr,
          provenance,
          controls,
          summary,
        }),
      );
    } catch {
      return c.json(unavailable, 503);
    }
  });
  return app;
}
