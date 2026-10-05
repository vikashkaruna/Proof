import { describe, expect, it } from 'vitest';
import { workflowRequestSchema, workflowRecordedResponseSchema } from './operator-workflows';
const key = '99111000-0000-4000-8000-000000000001';
const unknowns = {
  engagementId: null,
  sourceNote: 'Human capture, no observed private processing facts.',
  system: 'Public website',
  purpose: null,
  legalBasis: null,
  retentionMonths: null,
  dataCategories: null,
  dataPrincipals: null,
  processors: null,
  recipients: null,
  destinationCountries: null,
  transferSafeguards: null,
  dpiaRequired: null,
  region: null,
  crossBorder: null,
  securityMeasures: null,
};
describe('operator workflow contracts', () => {
  it('keeps every unsupported processing fact explicitly unknown', () => {
    const value = workflowRequestSchema.parse({
      operationKey: key,
      kind: 'ropa',
      payload: unknowns,
    });
    expect(value.payload).toEqual(unknowns);
    expect(value.payload).not.toHaveProperty('status');
  });
  it.each(['legalBasis', 'region', 'crossBorder', 'retentionMonths', 'dpiaRequired'])(
    'refuses an omitted %s rather than inventing a default',
    (field) => {
      const payload: Record<string, unknown> = { ...unknowns };
      delete payload[field];
      expect(
        workflowRequestSchema.safeParse({ operationKey: key, kind: 'ropa', payload }).success,
      ).toBe(false);
    },
  );
  it('preserves explicit false and a human confirmed retention value', () => {
    expect(
      workflowRequestSchema.parse({
        operationKey: key,
        kind: 'ropa',
        payload: { ...unknowns, crossBorder: false, dpiaRequired: false, retentionMonths: 12 },
      }).payload,
    ).toMatchObject({ crossBorder: false, dpiaRequired: false, retentionMonths: 12 });
  });
  it.each([0, -1, 1.5, 1201])('refuses invalid retention %s', (retentionMonths) => {
    expect(
      workflowRequestSchema.safeParse({
        operationKey: key,
        kind: 'ropa',
        payload: { ...unknowns, retentionMonths },
      }).success,
    ).toBe(false);
  });
  it('requires a source digest with the retained observation identifier', () => {
    expect(
      workflowRequestSchema.safeParse({
        operationKey: key,
        kind: 'ropa',
        payload: { ...unknowns, source: { observationId: key } },
      }).success,
    ).toBe(false);
  });
  it('refuses caller claims of verified legal status', () => {
    expect(
      workflowRequestSchema.safeParse({
        operationKey: key,
        kind: 'ropa',
        payload: { ...unknowns, verified: true },
      }).success,
    ).toBe(false);
  });
  it('captures zero minutes rather than losing a legitimate zero measurement', () => {
    expect(
      workflowRequestSchema.parse({
        operationKey: key,
        kind: 'delivery_task',
        payload: {
          engagementId: null,
          taskName: 'Review',
          source: 'Stopwatch',
          durationMinutes: 0,
          repetitions: 2,
          notes: '',
        },
      }).payload,
    ).toMatchObject({ durationMinutes: 0 });
  });
  it.each([0, -1, 1.5, 1_000_001])('bounds delivery repetition %s', (repetitions) => {
    expect(
      workflowRequestSchema.safeParse({
        operationKey: key,
        kind: 'delivery_task',
        payload: {
          engagementId: null,
          taskName: 'Review',
          source: 'Stopwatch',
          durationMinutes: 20,
          repetitions,
          notes: '',
        },
      }).success,
    ).toBe(false);
  });
  it.each(['privacy_notice', 'consent_notice', 'retention', 'dpa_template'])(
    'preserves exact %s draft bytes',
    (category) => {
      const content = ' Draft text  \n\tHuman review required.\n';
      expect(
        workflowRequestSchema.parse({
          operationKey: key,
          kind: 'policy_draft',
          payload: {
            engagementId: null,
            sourceNote: 'Manual template',
            sourceRopaId: null,
            title: 'Notice',
            category,
            content,
          },
        }).payload,
      ).toMatchObject({ content });
    },
  );
  it('bounds UTF-8 policy bytes separately from character count', () => {
    expect(
      workflowRequestSchema.safeParse({
        operationKey: key,
        kind: 'policy_draft',
        payload: {
          engagementId: null,
          sourceNote: 'Manual',
          sourceRopaId: null,
          title: 'Notice',
          category: 'privacy_notice',
          content: 'अ'.repeat(33334),
        },
      }).success,
    ).toBe(false);
  });
  it('requires a meaningful reason and exact content digest for decisions', () => {
    const payload = {
      draftId: key,
      expectedHash: 'a'.repeat(64),
      decision: 'approved',
      reason: 'Reviewed retained content',
    };
    expect(
      workflowRequestSchema.safeParse({ operationKey: key, kind: 'policy_review', payload })
        .success,
    ).toBe(true);
    expect(
      workflowRequestSchema.safeParse({
        operationKey: key,
        kind: 'policy_review',
        payload: { ...payload, reason: ' ' },
      }).success,
    ).toBe(false);
    expect(
      workflowRequestSchema.safeParse({
        operationKey: key,
        kind: 'policy_review',
        payload: { ...payload, expectedHash: 'bad' },
      }).success,
    ).toBe(false);
  });
  it('does not accept a claimed human result without a durable receipt', () => {
    expect(
      workflowRecordedResponseSchema.safeParse({
        replayed: false,
        data: {
          id: key,
          tenant_id: key,
          created_by: key,
          operation_key: key,
          created_at: '2026-10-05T00:00:00Z',
          content_sha256: null,
          kind: 'ropa',
          payload: unknowns,
        },
      }).success,
    ).toBe(false);
  });
});

it.each([' \n ', '\ud800', '\udc00', 'x\u0000y'])(
  'refuses empty or PostgreSQL-incompatible draft text before journaling',
  (content) => {
    expect(
      workflowRequestSchema.safeParse({
        operationKey: key,
        kind: 'policy_draft',
        payload: {
          title: 'Draft',
          category: 'privacy_notice',
          engagementId: null,
          sourceNote: 'Human',
          sourceRopaId: null,
          content,
        },
      }).success,
    ).toBe(false);
  },
);
it.each(['\ud800', 'a\u0000b'])(
  'refuses PostgreSQL-incompatible human processing facts',
  (system) => {
    expect(
      workflowRequestSchema.safeParse({
        operationKey: key,
        kind: 'ropa',
        payload: { ...unknowns, system },
      }).success,
    ).toBe(false);
  },
);
