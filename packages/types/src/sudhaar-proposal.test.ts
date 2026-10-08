import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  sudhaarInputSchema,
  sudhaarProposalRequestSchema,
  sudhaarReviewReason,
  validateSudhaarProposal,
  type SudhaarInput,
} from './sudhaar-proposal';
function input(): SudhaarInput {
  return {
    tenant_id: '11111111-1111-4111-8111-111111111111',
    engagement_id: '22222222-2222-4222-8222-222222222222',
    title: 'Review',
    source: {
      assessmentRunId: '33333333-3333-4333-8333-333333333333',
      libraryVersion: 'v1',
      libraryDigest: 'a'.repeat(64),
      resultDigest: 'b'.repeat(64),
      finalizedReceipt: '119',
    },
    findings: [
      {
        finding_id: '44444444-4444-4444-8444-444444444444',
        control_id: 'C',
        title: 'Control',
        severity: 'critical',
        score_decimal: '30',
        risk_points_decimal: '7.5',
        answer_state: 'unknown',
        applicability_state: 'unconditional',
        answer_counts: { known: 2, affirmed: 0, denied: 0, unknown: 2 },
      },
    ],
  };
}
function proposal(v = input()) {
  return {
    schema_version: 1,
    kind: 'remediation_proposal',
    title: v.title,
    source: v.source,
    persistence: 'not_saved',
    review_required: true,
    escalate: true,
    execution_allowed: false,
    review_tasks: v.findings.map((f, i) => ({
      sequence: i + 1,
      finding_id: f.finding_id,
      control_id: f.control_id,
      title: f.title,
      reason: sudhaarReviewReason(f),
      instruction:
        'Review the recorded questionnaire, applicability and supporting evidence before proposing corrective work. No finding is closed by this proposal.',
    })),
    provisional_actions: [],
    aggregate_records_affected: null,
    aggregate_systems: [],
  };
}
describe('read-only source-bound Sudhaar contract', () => {
  it('keeps uncertainty, unknown scope and no execution/closure claims', () => {
    const v = input();
    expect(validateSudhaarProposal(proposal(v), v)).toMatchObject({
      review_required: true,
      escalate: true,
      execution_allowed: false,
      persistence: 'not_saved',
      provisional_actions: [],
      aggregate_records_affected: null,
    });
  });
  it.each([
    'source',
    'id',
    'control',
    'reason',
    'sequence',
    'extra',
    'action',
    'scope',
    'closed',
    'review',
    'execution',
    'duplicate',
    'missing',
  ])('refuses malformed or unbound output %s', (mode) => {
    const v = input(),
      p = proposal(v) as Record<string, unknown>,
      tasks = p.review_tasks as Record<string, unknown>[];
    if (mode === 'source') p.source = { ...v.source, resultDigest: 'f'.repeat(64) };
    if (mode === 'id') tasks[0]!.finding_id = v.engagement_id;
    if (mode === 'control') tasks[0]!.control_id = 'foreign';
    if (mode === 'reason') tasks[0]!.reason = 'declarations_unverified';
    if (mode === 'sequence') tasks[0]!.sequence = 500;
    if (mode === 'extra') p.saved_plan_id = v.engagement_id;
    if (mode === 'action') p.provisional_actions = [{ action_type: 'data.delete' }];
    if (mode === 'scope') p.aggregate_records_affected = 0;
    if (mode === 'closed') tasks[0]!.closes_finding_id = v.findings[0]!.finding_id;
    if (mode === 'review') p.review_required = false;
    if (mode === 'execution') p.execution_allowed = true;
    if (mode === 'duplicate') tasks.push({ ...tasks[0]! });
    if (mode === 'missing') tasks.pop();
    expect(() => validateSudhaarProposal(p, v)).toThrow();
  });
  it.each(['unknown', 'partial', 'no_boolean', 'declared', 'conditional', 'unavailable'])(
    'routes each honest source state to review: %s',
    (mode) => {
      const v = input(),
        f = v.findings[0]!;
      if (mode === 'partial') {
        f.answer_state = 'partially_answered';
        f.answer_counts = { known: 2, affirmed: 1, denied: 0, unknown: 1 };
      }
      if (mode === 'no_boolean') {
        f.answer_state = 'not_boolean_assessable';
        f.answer_counts = { known: 0, affirmed: 0, denied: 0, unknown: 0 };
      }
      if (mode === 'declared') {
        f.answer_state = 'caller_declared_unverified';
        f.answer_counts = { known: 2, affirmed: 0, denied: 2, unknown: 0 };
      }
      if (mode === 'conditional') f.applicability_state = 'caller_declared_applicable_unverified';
      if (mode === 'unavailable') {
        f.answer_state = 'unavailable';
        f.applicability_state = 'unavailable';
        f.answer_counts = null;
      }
      expect(validateSudhaarProposal(proposal(v), v).review_tasks).toHaveLength(1);
    },
  );
  it.each(['scope', 'cap', 'proof', 'credentials', 'caller_findings'])(
    'browser cannot supply %s',
    (field) => {
      expect(
        sudhaarProposalRequestSchema.safeParse({
          operationKey: input().tenant_id,
          engagementId: input().engagement_id,
          assessmentRunId: input().source.assessmentRunId,
          [field]: {},
        }).success,
      ).toBe(false);
    },
  );
  it.each(['duplicate', 'count', 'state', 'NaN', 'boolean', 'size', 'receipt'])(
    'refuses corrupt source structure %s',
    (mode) => {
      const v = input();
      if (mode === 'duplicate') v.findings.push({ ...v.findings[0]! });
      if (mode === 'count') v.findings[0]!.answer_counts!.unknown = 1;
      if (mode === 'state') v.findings[0]!.answer_state = 'caller_declared_unverified';
      if (mode === 'NaN') v.findings[0]!.score_decimal = 'NaN';
      if (mode === 'boolean')
        (v.findings[0]!.answer_counts! as unknown as Record<string, unknown>).unknown = true;
      if (mode === 'size')
        v.findings = Array.from({ length: 6 }, (_, i) => ({
          ...v.findings[0]!,
          control_id: `C${i}`,
          finding_id: `44444444-4444-4444-8444-44444444444${i}`,
          answer_counts: { known: 1000, affirmed: 0, denied: 0, unknown: 1000 },
        }));
      if (mode === 'receipt') v.source.finalizedReceipt = '9999999999999999999';
      expect(sudhaarInputSchema.safeParse(v).success).toBe(false);
    },
  );
});

it('validates the shared synthetic 46-row output partition without score-derived failures', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../tests/contracts/sudhaar-source.v1.json', import.meta.url),
      'utf8',
    ),
  );
  const result = validateSudhaarProposal(fixture.expectedOutput, fixture.input);
  expect(result.review_tasks).toHaveLength(46);
  expect(new Set(result.review_tasks.map((t) => t.finding_id)).size).toBe(46);
  expect(result.execution_allowed).toBe(false);
  expect(result.aggregate_records_affected).toBeNull();
});
