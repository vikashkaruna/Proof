import { canonicalJson, sha256 } from '@axiom/ledger';
import { publicAgentObservationSchema, publicSourceReviewSchema } from '@axiom/types';
export const reviewIds = {
  tenant: '11111111-1111-4111-8111-111111111111',
  actor: '22222222-2222-4222-8222-222222222222',
  engagement: '33333333-3333-4333-8333-333333333333',
  check: '44444444-4444-4444-8444-444444444444',
  binding: '55555555-5555-4555-8555-555555555555',
  observation: '66666666-6666-4666-8666-666666666666',
  review: '77777777-7777-4777-8777-777777777777',
  run: '88888888-8888-4888-8888-888888888888',
  dispatch: '99999999-9999-4999-8999-999999999999',
};
export async function reviewFixture() {
  const i = reviewIds;
  const binding = {
    tenant_id: i.tenant,
    engagement_id: i.engagement,
    check_id: i.check,
    root_content_sha256: 'a'.repeat(64),
    projection_sha256: 'b'.repeat(64),
    projection_version: 1,
  };
  const output = {
    mode: 'public_website',
    source_binding: binding,
    indicators: [
      {
        page: 'root',
        content_sha256: 'a'.repeat(64),
        form_ordinal: 1,
        control_ordinal: 2,
        input_type: 'email',
        indicator: 'potential_contact_collection',
        requires_human_review: true,
      },
    ],
    private_facts: {
      hosting_region: 'unknown',
      backend_personal_data: 'unknown',
      cross_border_processing: 'unknown',
    },
    unexamined_pages: [],
    unavailable_pages: [],
    scope_limited: true,
  };
  const observation = publicAgentObservationSchema.parse({
    observation_id: i.observation,
    dispatch_id: i.dispatch,
    binding_id: i.binding,
    run_id: i.run,
    output_sha256: await sha256(canonicalJson(output)),
    completion_receipt: '12',
    agent: 'vibhaag',
    output,
  });
  const row = publicSourceReviewSchema.parse({
    review_id: i.review,
    tenant_id: i.tenant,
    engagement_id: i.engagement,
    binding_id: i.binding,
    observation_id: i.observation,
    agent: 'vibhaag',
    dispatch_id: i.dispatch,
    run_id: i.run,
    source_observation_id: i.check,
    source_observation_sha256: 'c'.repeat(64),
    estate_id: null,
    check_id: i.check,
    projection_version: 1,
    root_content_sha256: binding.root_content_sha256,
    projection_sha256: binding.projection_sha256,
    output_sha256: observation.output_sha256,
    source_request_sha256: 'd'.repeat(64),
    source_creation_receipt: '3',
    completion_receipt: '12',
    settlement_receipt: '13',
    target_kind: 'whole_observation',
    page: null,
    form_ordinal: null,
    control_ordinal: null,
    content_sha256: null,
    source_indicator: null,
    decision: 'acknowledged',
    justification: '  Saved attributes reviewed.  ',
    reviewed_by: i.actor,
    operation_key: i.check,
    previous_review_id: null,
    review_receipt: '14',
    is_current: true,
    created_at: '2026-10-05T01:00:00Z',
  });
  return { observation, row };
}
