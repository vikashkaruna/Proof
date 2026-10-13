/** Unmounted pure source preparation. No caller declaration or digest grants authority.
 * The future controller must obtain the witness from its scoped trusted SQL read.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@axiom/ledger';
import { interpretAssessmentReport } from '@axiom/report-kit/assessment-interpretation';
import {
  PRATIVEDAN_RENDERER_CONFIG_VERSION,
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
  prativedanDraftRequestSchema,
  prativedanFrozenSourceSchema,
  prativedanSourceWitnessSchema,
  prativedanRendererInputSchema,
} from '@axiom/types';

export class PrativedanDraftRefused extends Error {
  constructor() {
    super('prativedan_draft_contract_refused');
  }
}

/** Reject lossy UTF-8 conversion (including isolated UTF-16 surrogates). */
export function prativedanTextHash(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) throw new PrativedanDraftRefused();
  return createHash('sha256').update(bytes).digest('hex');
}

const controlsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(100),
      title: z.string().min(1).max(300),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      library_version: z.string().min(1).max(200),
    }),
  )
  .min(1)
  .max(500);
const resultSchema = z
  .object({
    questionnaire_provenance: z.unknown(),
    library_version: z.string().min(1).max(200),
    posture_score: z.number().finite().min(0).max(100),
    estimated_exposure_inr: z.number().int().safe().nonnegative(),
    findings: z
      .array(
        z
          .object({
            control_id: z.string().min(1).max(100),
            score: z.number().finite().min(0).max(100),
            risk_points: z.number().finite().min(0).max(99999.99).optional(),
            rationale: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export function preparePrativedanDraftSource(rawWitness: unknown, rawRequest: unknown) {
  try {
    if (prativedanTextHash(PRATIVEDAN_RENDERER_CONFIG_TEXT) !== PRATIVEDAN_RENDERER_CONFIG_SHA256)
      throw new PrativedanDraftRefused();
    const witness = prativedanSourceWitnessSchema.parse(rawWitness);
    const request = prativedanDraftRequestSchema.parse(rawRequest);
    if (
      request.engagementId !== witness.engagement_id ||
      request.assessmentRunId !== witness.assessment_run_id ||
      request.expectedSourceSha256 !== witness.source_sha256 ||
      prativedanTextHash(witness.source_text) !== witness.source_sha256
    )
      throw new PrativedanDraftRefused();
    const source = prativedanFrozenSourceSchema.parse(JSON.parse(witness.source_text));
    if (
      source.request_id !== witness.source_id ||
      source.tenant_id !== witness.tenant_id ||
      source.engagement_id !== witness.engagement_id ||
      source.assessment_run_id !== witness.assessment_run_id ||
      source.library_version !== witness.library_version ||
      source.controls_sha256 !== witness.controls_sha256 ||
      source.result_sha256 !== witness.result_sha256 ||
      prativedanTextHash(source.controls_text) !== witness.controls_sha256 ||
      prativedanTextHash(source.result_text) !== witness.result_sha256 ||
      canonicalJson(source.receipts) !== canonicalJson(witness.receipts)
    )
      throw new PrativedanDraftRefused();
    const rawControls: unknown = JSON.parse(source.controls_text);
    const rawResult: unknown = JSON.parse(source.result_text);
    const controls = controlsSchema.parse(rawControls);
    const result = resultSchema.parse(rawResult);
    if (
      result.library_version !== witness.library_version ||
      controls.some((control) => control.library_version !== witness.library_version)
    )
      throw new PrativedanDraftRefused();
    const interpretation = interpretAssessmentReport(
      rawResult,
      rawControls,
      witness.controls_sha256,
      witness.title,
    );
    // Legacy reports can remain readable, but cannot approve this new named source.
    if (interpretation.interpretation.provenance !== 'caller_declared_unverified')
      throw new PrativedanDraftRefused();
    const byId = new Map(controls.map((control) => [control.id, control]));
    const states = new Map(interpretation.findings.map((finding) => [finding.control_id, finding]));
    const rendererInput = prativedanRendererInputSchema.parse({
      tenant_id: witness.tenant_id,
      engagement_id: witness.engagement_id,
      kind: 'board',
      title: witness.title,
      findings: result.findings.map((finding) => {
        const control = byId.get(finding.control_id);
        if (!control) throw new PrativedanDraftRefused();
        const state = states.get(finding.control_id);
        if (!state) throw new PrativedanDraftRefused();
        return {
          control_id: finding.control_id,
          score: finding.score,
          title: control.title,
          severity: control.severity,
          rationale: `${finding.rationale} [Draft assessment declaration: answer=${state.answer_state}; applicability=${state.applicability_state}; evidence unverified.]`,
        };
      }),
      posture_score: result.posture_score,
      estimated_exposure_inr: result.estimated_exposure_inr,
      library_version: witness.library_version,
      library_control_ids: controls.map((control) => control.id),
      reviewer_id: null,
    });
    const requestText = canonicalJson(request);
    const rendererInputText = canonicalJson(rendererInput);
    return {
      witness,
      request,
      source,
      interpretation,
      rendererInput,
      requestText,
      requestSha256: prativedanTextHash(requestText),
      rendererInputText,
      // Trusted local renderer commitment for future recorded dispatch/claim binding.
      rendererConfigVersion: PRATIVEDAN_RENDERER_CONFIG_VERSION,
      rendererConfigText: PRATIVEDAN_RENDERER_CONFIG_TEXT,
      rendererConfigSha256: PRATIVEDAN_RENDERER_CONFIG_SHA256,
    };
  } catch {
    throw new PrativedanDraftRefused();
  }
}
export type PreparedPrativedanDraftSource = ReturnType<typeof preparePrativedanDraftSource>;
