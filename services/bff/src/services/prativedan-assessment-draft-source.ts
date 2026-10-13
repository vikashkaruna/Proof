import { parsePrativedanAssessmentJson } from './prativedan-assessment-json.js';
/** Pure dedicated-assessment source verification. The caller must load the
 * journal independently through a scoped trusted store; parsing grants no
 * access, claim, invocation or publication authority.
 */
import { z } from 'zod';
import { interpretAssessmentReport } from '@axiom/report-kit/assessment-interpretation';
import {
  PRATIVEDAN_RENDERER_CONFIG_TEXT,
  PRATIVEDAN_RENDERER_CONFIG_SHA256,
  prativedanAssessmentReadbackSchema,
  prativedanAssessmentSourceSchema,
  prativedanAssessmentDraftRequestSchema,
  prativedanAssessmentRendererInputSchema,
} from '@axiom/types';
import { prativedanTextHash, PrativedanDraftRefused } from './prativedan-draft-source.js';

const shortText = (limit: number) =>
  z
    .string()
    .min(1)
    .refine((value) => [...value].length <= limit);
const controlsSchema = z
  .array(
    z.object({
      id: shortText(100),
      title: shortText(300),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      library_version: shortText(200),
    }),
  )
  .min(1)
  .max(500);
const resultSchema = z
  .object({
    questionnaire_provenance: z.unknown(),
    library_version: shortText(200),
    posture_score: z.number().finite().min(0).max(100),
    estimated_exposure_inr: z.number().int().safe().nonnegative(),
    findings: z
      .array(
        z
          .object({
            control_id: shortText(100),
            score: z.number().finite().min(0).max(100),
            risk_points: z.number().finite().min(0).max(99999.99).optional(),
            rationale: shortText(4000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export function preparePrativedanAssessmentDraftSource(
  rawJournal: unknown,
  reviewedRequestText: string,
) {
  try {
    const journal = prativedanAssessmentReadbackSchema.parse(rawJournal);
    if (
      'missing' in journal ||
      journal.request_text !== reviewedRequestText ||
      prativedanTextHash(journal.request_text) !== journal.request_sha256 ||
      prativedanTextHash(journal.source_text) !== journal.source_sha256 ||
      prativedanTextHash(PRATIVEDAN_RENDERER_CONFIG_TEXT) !== PRATIVEDAN_RENDERER_CONFIG_SHA256
    )
      throw new PrativedanDraftRefused();
    const request = prativedanAssessmentDraftRequestSchema.parse(
      parsePrativedanAssessmentJson(reviewedRequestText),
    );
    const source = prativedanAssessmentSourceSchema.parse(
      parsePrativedanAssessmentJson(journal.source_text),
    );
    if (
      source.tenant_id !== journal.tenant_id ||
      source.engagement_id !== journal.engagement_id ||
      source.source_id !== journal.source_id ||
      source.assessment_run_id !== journal.assessment_run_id ||
      request.operationKey !== journal.operation_key ||
      request.engagementId !== source.engagement_id ||
      request.assessmentRunId !== source.assessment_run_id ||
      request.expectedSourceSha256 !== journal.source_sha256 ||
      BigInt(source.receipts.finalized.id) >= BigInt(journal.requested_receipt.id) ||
      prativedanTextHash(source.controls_text) !== source.controls_sha256 ||
      prativedanTextHash(source.result_text) !== source.result_sha256
    )
      throw new PrativedanDraftRefused();
    const rawControls = parsePrativedanAssessmentJson(source.controls_text);
    const rawResult = parsePrativedanAssessmentJson(source.result_text);
    const controls = controlsSchema.parse(rawControls);
    const result = resultSchema.parse(rawResult);
    const ids = new Set(controls.map((control) => control.id));
    if (
      ids.size !== controls.length ||
      result.findings.length !== controls.length ||
      new Set(result.findings.map((finding) => finding.control_id)).size !== controls.length ||
      result.findings.some((finding) => !ids.has(finding.control_id)) ||
      result.library_version !== source.library_version ||
      controls.some((control) => control.library_version !== source.library_version)
    )
      throw new PrativedanDraftRefused();
    const interpretation = interpretAssessmentReport(
      rawResult,
      rawControls,
      source.controls_sha256,
      source.title,
    );
    if (interpretation.interpretation.provenance !== 'caller_declared_unverified')
      throw new PrativedanDraftRefused();
    const byId = new Map(controls.map((control) => [control.id, control]));
    const states = new Map(interpretation.findings.map((finding) => [finding.control_id, finding]));
    const rendererInput = prativedanAssessmentRendererInputSchema.parse({
      tenant_id: source.tenant_id,
      engagement_id: source.engagement_id,
      kind: 'board',
      title: source.title,
      findings: result.findings.map((finding) => {
        const control = byId.get(finding.control_id);
        const state = states.get(finding.control_id);
        if (!control || !state) throw new PrativedanDraftRefused();
        return {
          control_id: finding.control_id,
          title: control.title,
          severity: control.severity,
          score: finding.score,
          rationale: `${finding.rationale} [Draft assessment declaration: answer=${state.answer_state}; applicability=${state.applicability_state}; evidence unverified.]`,
        };
      }),
      posture_score: result.posture_score,
      estimated_exposure_inr: result.estimated_exposure_inr,
      library_version: source.library_version,
      library_control_ids: controls.map((control) => control.id),
      reviewer_id: null,
    });
    return { journal, request, source, rendererInput, interpretation, reviewedRequestText };
  } catch {
    throw new PrativedanDraftRefused();
  }
}
export type PreparedPrativedanAssessmentDraftSource = ReturnType<
  typeof preparePrativedanAssessmentDraftSource
>;
