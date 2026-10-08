import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  sudhaarInputSchema,
  validateQuestionnaireProvenance,
  type SudhaarInput,
} from '@axiom/types';
import { canonicalJson } from '@axiom/ledger';
import { assessmentResult } from '../workloads/assessment-tools.js';
import type { EvidenceDatabase } from './evidence-ingestion.js';
const uuid = z.uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const numeric = z
  .union([z.number(), z.string().min(1)])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
const control = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
});
const packetSchema = z.object({
  tenant_id: uuid,
  engagement_id: uuid,
  run_id: uuid,
  library_version: z.string().min(1).max(200),
  library_digest: digest,
  result_digest: digest,
  controls: z.array(control).min(1).max(500),
  result: assessmentResult,
  finalized_receipt: z
    .union([z.string().regex(/^[1-9][0-9]{0,18}$/), z.number().int().positive().safe()])
    .transform(String),
  finalized_at: z.iso.datetime({ offset: true }),
});
const findingSchema = z.object({
  id: uuid,
  tenant_id: uuid,
  engagement_id: uuid,
  library_version: z.string(),
  control_id: z.string(),
  score: numeric.pipe(z.number().max(100)),
  risk_points: numeric,
  rationale: z.string().min(1).max(4000),
});
export class PlanningSourceRefused extends Error {
  constructor(readonly code: 'planning_source_unavailable' | 'planning_source_conflict') {
    super(code);
  }
}
/** Uses existing PostgreSQL finalization/digest verifier; never confirms or mutates a task. */
export async function readSudhaarSource(
  db: EvidenceDatabase,
  tenantId: string,
  engagementId: string,
  runId: string,
  title: string,
): Promise<SudhaarInput> {
  const signal = AbortSignal.timeout(10000);
  try {
    const { data: owned, error: ownedError } = await db
      .from('engagements')
      .select('id,tenant_id,library_version')
      .eq('tenant_id', tenantId)
      .eq('id', engagementId)
      .abortSignal(signal)
      .maybeSingle();
    const engagement = z
      .object({ id: uuid, tenant_id: uuid, library_version: z.string() })
      .parse(owned);
    if (ownedError || engagement.id !== engagementId || engagement.tenant_id !== tenantId)
      throw new PlanningSourceRefused('planning_source_unavailable');
    const { data: proof, error: proofError } = await db
      .rpc('board_assessment_source_valid', {
        p_tenant_id: tenantId,
        p_run_id: runId,
        p_engagement_id: engagementId,
      })
      .abortSignal(signal);
    if (proofError || proof !== true)
      throw new PlanningSourceRefused('planning_source_unavailable');
    const [packetResult, findingsResult, libraryResult] = await Promise.all([
      db
        .from('workload_assessment_packets')
        .select(
          'tenant_id,engagement_id,run_id,library_version,library_digest,result_digest,controls,result,finalized_receipt,finalized_at',
        )
        .eq('tenant_id', tenantId)
        .eq('engagement_id', engagementId)
        .eq('run_id', runId)
        .abortSignal(signal)
        .single(),
      db
        .from('findings')
        .select(
          'id,tenant_id,engagement_id,library_version,control_id,score,risk_points,rationale',
          { count: 'exact' },
        )
        .eq('tenant_id', tenantId)
        .eq('engagement_id', engagementId)
        .eq('library_version', engagement.library_version)
        .limit(501)
        .abortSignal(signal),
      db
        .from('control_libraries')
        .select('version,status,control_count')
        .eq('version', engagement.library_version)
        .abortSignal(signal)
        .single(),
    ]);
    if (packetResult.error || findingsResult.error || libraryResult.error)
      throw new PlanningSourceRefused('planning_source_unavailable');
    const packet = packetSchema.parse(packetResult.data),
      findings = z.array(findingSchema).min(1).max(500).parse(findingsResult.data);
    const library = z
      .object({
        version: z.string(),
        status: z.enum(['published', 'deprecated']),
        control_count: z.number().int().min(1).max(500),
      })
      .parse(libraryResult.data);
    if (
      packet.tenant_id !== tenantId ||
      packet.engagement_id !== engagementId ||
      packet.run_id !== runId ||
      packet.library_version !== engagement.library_version ||
      packet.result.library_version !== packet.library_version ||
      library.version !== packet.library_version ||
      library.control_count !== packet.controls.length ||
      findingsResult.count !== findings.length ||
      findings.length !== packet.controls.length ||
      packet.result.findings.length !== findings.length ||
      new Set(findings.map((f) => f.id)).size !== findings.length ||
      new Set(findings.map((f) => f.control_id)).size !== findings.length ||
      new Set(packet.controls.map((c) => c.id)).size !== findings.length
    )
      throw new PlanningSourceRefused('planning_source_conflict');
    const provenance = validateQuestionnaireProvenance(
      (packetResult.data as { result: unknown }).result,
      (packetResult.data as { controls: unknown }).controls,
      packet.library_digest,
    ).provenance;
    const declarations = new Map(provenance?.controls.map((c) => [c.control_id, c]));
    const resultRows = new Map(packet.result.findings.map((f) => [f.control_id, f]));
    const controls = new Map(packet.controls.map((c) => [c.id, c]));
    const bound = findings
      .map((f) => {
        const scored = resultRows.get(f.control_id),
          definition = controls.get(f.control_id),
          declared = declarations.get(f.control_id);
        if (
          !scored ||
          !definition ||
          f.tenant_id !== tenantId ||
          f.engagement_id !== engagementId ||
          f.library_version !== packet.library_version ||
          f.score !== scored.score ||
          f.risk_points !== scored.risk_points ||
          f.rationale !== scored.rationale
        )
          throw new PlanningSourceRefused('planning_source_conflict');
        return {
          finding_id: f.id.toLowerCase(),
          control_id: f.control_id,
          title: definition.title,
          severity: definition.severity,
          score_decimal: String(f.score),
          risk_points_decimal: String(f.risk_points),
          answer_state: declared?.answer_state ?? 'unavailable',
          applicability_state: declared?.applicability_state ?? 'unavailable',
          answer_counts: declared
            ? {
                known: declared.known_boolean_question_count,
                affirmed: declared.caller_affirmed_count,
                denied: declared.caller_denied_count,
                unknown: declared.unknown_count,
              }
            : null,
        };
      })
      .sort((a, b) => a.control_id.localeCompare(b.control_id));
    return sudhaarInputSchema.parse({
      tenant_id: tenantId,
      engagement_id: engagementId,
      title,
      source: {
        assessmentRunId: runId,
        libraryVersion: packet.library_version,
        libraryDigest: packet.library_digest,
        resultDigest: packet.result_digest,
        finalizedReceipt: packet.finalized_receipt,
      },
      findings: bound,
    });
  } catch (error) {
    if (error instanceof PlanningSourceRefused) throw error;
    throw new PlanningSourceRefused('planning_source_conflict');
  }
}
export function signSudhaarDispatch(
  context: { runId: string; requestHash: string; wireInput: string; correlationId: string },
  secret: string,
  peerSecret: string,
  now = Date.now(),
) {
  if (Buffer.byteLength(secret) < 32 || secret === peerSecret)
    throw new Error('Planning transport secret unavailable');
  const payload = {
    version: 1,
    input_text: context.wireInput,
    correlation_id: context.correlationId,
    dispatch_context: { run_id: context.runId, request_hash: context.requestHash },
    expires_at: Math.floor(now / 1000) + 90,
  };
  const signed_text = canonicalJson(payload);
  return {
    signed_text,
    signature: createHmac('sha256', secret)
      .update('axiom-sudhaar-source-v1\0')
      .update(signed_text, 'utf8')
      .digest('hex'),
  };
}
