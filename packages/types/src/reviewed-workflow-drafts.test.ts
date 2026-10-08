import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/reviewed-workflow-drafts.json';
import {
  reviewedWorkflowInputSchema,
  reviewedWorkflowOutputSchema,
  validateReviewedWorkflowOutput,
} from './reviewed-workflow-drafts.js';

const copy = () => structuredClone(fixture);
describe('reviewed source draft contracts', () => {
  it('accepts the real Python generator projection with human origins and unverified reported time', () => {
    const output = validateReviewedWorkflowOutput(fixture.input, fixture.output);
    expect(output.processing_reviews[0]!.declarations).toEqual(fixture.input.records[0]!.payload);
    expect(output.processing_reviews[0]!.declarations.crossBorder).toBe(false);
    expect(output.processing_reviews[0]!.declarations.processors).toEqual([]);
    expect(output.processing_reviews[0]!.declarations.purpose).toBeNull();
    expect(output.policy_drafts.map((draft) => draft.category)).toEqual([
      'privacy_notice',
      'consent_notice',
      'retention',
      'dpa_template',
    ]);
    expect(output.playbook_reviews.map((review) => review.reported_total_minutes)).toEqual([
      100, 10, 0,
    ]);
    output.playbook_reviews.forEach((review) => {
      expect(review.measurement_status).toBe('not_verified');
      expect(review.ranking_basis).toBe('human_reported_time_only');
      expect(review.time_horizon).toBe('not_recorded');
      expect(review.automation_candidate).toBe(false);
    });
    expect(output.persistence).toBe('not_saved');
    expect(output.execution_allowed).toBe(false);
    expect(output.publication_allowed).toBe(false);
  });

  it.each(['0', 'abc', '9223372036854775808', '00', '-1'])(
    'refuses malformed original human receipt %s without throwing non-schema errors',
    (receipt) => {
      const { input } = copy();
      input.records[0]!.receipt_id = receipt;
      expect(reviewedWorkflowInputSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each([
    'tenant',
    'engagement',
    'id',
    'key',
    'receipt',
    'empty',
    'wrong_kind',
    'too_many',
    'extra',
  ])('refuses inconsistent source register: %s', (change) => {
    const { input } = copy();
    if (change === 'tenant') input.records[0]!.tenant_id = input.records[0]!.created_by;
    if (change === 'engagement')
      input.records[0]!.payload.engagementId = input.records[0]!.created_by;
    if (change === 'id') input.records[1]!.id = input.records[0]!.id;
    if (change === 'key') input.records[1]!.operation_key = input.records[0]!.operation_key;
    if (change === 'receipt') input.records[1]!.receipt_id = input.records[0]!.receipt_id;
    if (change === 'empty') input.records = [];
    if (change === 'wrong_kind') Object.assign(input.records[0]!, { kind: 'policy_review' });
    if (change === 'too_many') input.records = Array.from({ length: 21 }, () => input.records[0]!);
    if (change === 'extra') Object.assign(input, { authoritative: true });
    expect(reviewedWorkflowInputSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    'digest',
    'processing_partition',
    'delivery_partition',
    'policy_partition',
    'declarations',
    'unresolved',
    'source_actor',
    'source_receipt',
    'policy_actor',
    'policy_id',
    'policy_category',
    'policy_content',
    'reported_duration',
    'reported_cost',
    'reported_order',
  ])('refuses source/output mismatch: %s', (change) => {
    const { input, output } = copy();
    if (change === 'digest') output.source_records_sha256 = 'b'.repeat(64);
    if (change === 'processing_partition') output.processing_reviews = [];
    if (change === 'delivery_partition') output.playbook_reviews.pop();
    if (change === 'policy_partition') output.policy_drafts.pop();
    if (change === 'declarations') output.processing_reviews[0]!.declarations.crossBorder = true;
    if (change === 'unresolved') output.processing_reviews[0]!.unresolved_fields.push('processors');
    if (change === 'source_actor')
      output.processing_reviews[0]!.source.created_by = input.tenant_id;
    if (change === 'source_receipt') output.processing_reviews[0]!.source.human_receipt_id = '19';
    if (change === 'policy_actor') output.policy_drafts[0]!.source.created_by = input.tenant_id;
    if (change === 'policy_id') output.policy_drafts[0]!.source_ropa_id = input.tenant_id;
    if (change === 'policy_category') output.policy_drafts[0]!.category = 'consent_notice';
    if (change === 'policy_content')
      output.policy_drafts[0]!.content = 'Caller supplied substitute content';
    if (change === 'reported_duration') output.playbook_reviews[0]!.reported_task.durationMinutes++;
    if (change === 'reported_cost') output.playbook_reviews[0]!.reported_total_minutes++;
    if (change === 'reported_order') output.playbook_reviews.reverse();
    expect(() => validateReviewedWorkflowOutput(input, output)).toThrow();
  });

  it.each(['execution_allowed', 'publication_allowed', 'review_required', 'persistence'])(
    'cannot turn a draft into authority: %s',
    (field) => {
      const { output } = copy();
      Object.assign(output, { [field]: field === 'review_required' ? false : true });
      expect(reviewedWorkflowOutputSchema.safeParse(output).success).toBe(false);
    },
  );

  it('rejects fabricated observation authority, confirmed measurements and automatic eligibility', () => {
    const { output } = copy();
    Object.assign(output.playbook_reviews[0]!, {
      measurement_status: 'verified',
      ranking_basis: 'measured',
      automation_candidate: true,
    });
    expect(reviewedWorkflowOutputSchema.safeParse(output).success).toBe(false);
  });

  it('bounds source and expanded output bytes without dropping declarations', () => {
    const { input, output } = copy();
    input.records = Array.from({ length: 20 }, (_, index) => {
      const record = structuredClone(input.records[0]!);
      record.id = `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      record.operation_key = `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      record.receipt_id = String(index + 1);
      Object.assign(record.payload, {
        purpose: 'p'.repeat(2000),
        transferSafeguards: 's'.repeat(2000),
        securityMeasures: 'm'.repeat(2000),
        sourceNote: 'n'.repeat(2000),
        dataCategories: Array.from({ length: 50 }, () => 'c'.repeat(200)),
        processors: Array.from({ length: 50 }, () => 'c'.repeat(200)),
        dataPrincipals: Array.from({ length: 50 }, () => 'c'.repeat(200)),
      });
      return record;
    });
    expect(reviewedWorkflowInputSchema.safeParse(input).success).toBe(false);
    output.policy_drafts = Array.from({ length: 8 }, () => ({
      ...output.policy_drafts[0]!,
      content: 'x'.repeat(99_999),
    }));
    expect(reviewedWorkflowOutputSchema.safeParse(output).success).toBe(false);
  });
});
