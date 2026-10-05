import { canonicalJson } from '@axiom/ledger';
import {
  createPublicSourceReviewSchema,
  publicSourceReviewSchema,
  type CreatePublicSourceReview,
  type PublicSourceReview,
  type PublicAgentObservation,
} from '@axiom/types';
import { SourceWorkflowError } from './source-request';
import type { ReviewOperation } from './source-review-request';
export type ReviewTarget = CreatePublicSourceReview['target'];
export function observationBinding(observation: PublicAgentObservation) {
  return observation.agent === 'drishti'
    ? observation.output.observation.binding
    : observation.output.source_binding;
}
export function reviewTargetKey(target: ReviewTarget) {
  return target.kind === 'whole_observation'
    ? 'whole_observation'
    : `${target.page}/${target.formOrdinal}/${target.controlOrdinal}/${target.expectedContentSha256}`;
}
export function reviewTargets(
  observation: PublicAgentObservation,
): { target: ReviewTarget; label: string }[] {
  return [
    { target: { kind: 'whole_observation' }, label: 'Whole observation' },
    ...(observation.agent === 'vibhaag'
      ? observation.output.indicators.map((item) => ({
          target: {
            kind: 'vibhaag_indicator' as const,
            page: item.page,
            formOrdinal: item.form_ordinal,
            controlOrdinal: item.control_ordinal,
            expectedContentSha256: item.content_sha256,
          },
          label: `${item.page} · form ${item.form_ordinal}, control ${item.control_ordinal} · ${item.input_type} input`,
        }))
      : []),
  ];
}
export function reviewRowTarget(row: PublicSourceReview): ReviewTarget {
  return row.target_kind === 'whole_observation'
    ? { kind: 'whole_observation' }
    : {
        kind: 'vibhaag_indicator',
        page: row.page!,
        formOrdinal: row.form_ordinal!,
        controlOrdinal: row.control_ordinal!,
        expectedContentSha256: row.content_sha256!,
      };
}
/** A leaf flag is authoritative for this read. Timestamp order is never a chain head. */
export function currentReviewTarget(
  rows: PublicSourceReview[],
  target: ReviewTarget,
  hasMore: boolean,
) {
  const matches = rows.filter(
    (row) => reviewTargetKey(reviewRowTarget(row)) === reviewTargetKey(target),
  );
  const heads = matches.filter((row) => row.is_current);
  if (heads.length === 1)
    return { resolved: true, head: heads[0]!, previousId: heads[0]!.review_id };
  if (heads.length > 1 || matches.length || hasMore)
    return { resolved: false, head: null, previousId: null };
  return { resolved: true, head: null, previousId: null };
}
/** The human judgment must refer to the immutable selected output and target. */
export function validateReviewContext(
  value: unknown,
  observation: PublicAgentObservation,
  tenantId: string,
  operation?: ReviewOperation,
): PublicSourceReview {
  const row = publicSourceReviewSchema.parse(value),
    binding = observationBinding(observation);
  if (
    binding.tenant_id !== tenantId.toLowerCase() ||
    row.tenant_id !== binding.tenant_id ||
    row.engagement_id !== binding.engagement_id ||
    row.binding_id !== observation.binding_id ||
    row.observation_id !== observation.observation_id ||
    row.agent !== observation.agent ||
    row.check_id !== binding.check_id ||
    row.root_content_sha256 !== binding.root_content_sha256 ||
    row.projection_sha256 !== binding.projection_sha256 ||
    row.output_sha256 !== observation.output_sha256 ||
    row.run_id !== observation.run_id ||
    row.dispatch_id !== observation.dispatch_id ||
    row.completion_receipt !== observation.completion_receipt
  )
    throw new SourceWorkflowError('The human review differs from the selected source and result.');
  if (row.target_kind === 'vibhaag_indicator') {
    const expected =
      observation.agent === 'vibhaag'
        ? observation.output.indicators.find(
            (item) =>
              reviewTargetKey(reviewRowTarget(row)) ===
              reviewTargetKey({
                kind: 'vibhaag_indicator',
                page: item.page,
                formOrdinal: item.form_ordinal,
                controlOrdinal: item.control_ordinal,
                expectedContentSha256: item.content_sha256,
              }),
          )
        : undefined;
    if (!expected || canonicalJson(expected) !== canonicalJson(row.source_indicator))
      throw new SourceWorkflowError(
        'The human review target differs from the retained structural indicator.',
      );
  }
  if (operation) {
    const body = createPublicSourceReviewSchema.parse(JSON.parse(operation.bodyUtf8));
    if (
      row.reviewed_by !== operation.actorId ||
      row.operation_key !== operation.operationKey ||
      row.decision !== body.decision ||
      row.justification !== body.justification ||
      row.previous_review_id !== body.expectedPreviousReviewId ||
      reviewTargetKey(reviewRowTarget(row)) !== reviewTargetKey(body.target)
    )
      throw new SourceWorkflowError(
        'The retained human review differs from this original request.',
      );
  }
  return row;
}
