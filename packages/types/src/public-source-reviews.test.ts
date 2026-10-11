import { describe, it, expect } from 'vitest';
import {
  createPublicSourceReviewSchema,
  publicSourceReviewSchema,
  publicSourceReviewRecordedResponseSchema,
  publicSourceReviewOperationKeySchema,
  publicSourceReviewRecordedSqlSchema,
  publicSourceReviewPageSqlSchema,
  publicSourceReviewRequestSqlSchema,
} from './public-source-reviews';
export const review = {
  review_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  engagement_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  binding_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  observation_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  agent: 'vibhaag',
  dispatch_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  run_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  source_observation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  source_observation_sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  estate_id: null,
  check_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projection_version: 1,
  root_content_sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  projection_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  output_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  source_request_sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  source_creation_receipt: '1',
  completion_receipt: '2',
  settlement_receipt: '3',
  target_kind: 'whole_observation',
  page: null,
  form_ordinal: null,
  control_ordinal: null,
  content_sha256: null,
  source_indicator: null,
  decision: 'acknowledged',
  justification: '  Retained public structure reviewed.  ',
  reviewed_by: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  operation_key: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  previous_review_id: null,
  review_receipt: '4',
  is_current: true,
  created_at: '2026-10-05T12:00:00.123456Z',
};
export const body = {
  engagementId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  expectedOutputSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  expectedProjectionSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  target: {
    kind: 'whole_observation',
  },
  decision: 'acknowledged',
  justification: '  Retained public structure reviewed.  ',
  expectedPreviousReviewId: null,
};

describe('strict structural source review contracts', () => {
  it('preserves exact raw justification', () =>
    expect(createPublicSourceReviewSchema.parse(body).justification).toBe(body.justification));
  it.each([
    'tenant_id',
    'actor_id',
    'private_facts',
    'confidenceScore',
    'categories',
    'originalOutput',
  ])('rejects caller facts %s', (field) =>
    expect(createPublicSourceReviewSchema.safeParse({ ...body, [field]: 'invented' }).success).toBe(
      false,
    ),
  );
  it.each(['', ' ', '\n\t', 'x'.repeat(2001)])(
    'refuses blank or oversized raw justification %s',
    (justification) =>
      expect(createPublicSourceReviewSchema.safeParse({ ...body, justification }).success).toBe(
        false,
      ),
  );
  it('counts PostgreSQL characters rather than UTF16 units', () => {
    expect(
      createPublicSourceReviewSchema.safeParse({ ...body, justification: '😀'.repeat(2000) })
        .success,
    ).toBe(true);
    expect(
      createPublicSourceReviewSchema.safeParse({ ...body, justification: '😀'.repeat(2001) })
        .success,
    ).toBe(false);
  });
  it('requires nullable predecessor', () => {
    const { expectedPreviousReviewId, ...missing } = body;
    expect(expectedPreviousReviewId).toBeNull();
    expect(createPublicSourceReviewSchema.safeParse(missing).success).toBe(false);
  });
  it('whole scope rejects injected locator', () =>
    expect(
      createPublicSourceReviewSchema.safeParse({
        ...body,
        target: { kind: 'whole_observation', page: 'contact' },
      }).success,
    ).toBe(false));
  it('indicator scope accepts exact locator', () =>
    expect(
      createPublicSourceReviewSchema.safeParse({
        ...body,
        target: {
          kind: 'vibhaag_indicator',
          page: 'contact',
          formOrdinal: 1,
          controlOrdinal: 524288,
          expectedContentSha256: 'a'.repeat(64),
        },
      }).success,
    ).toBe(true));
  it.each([0, 4, 1.5])('refuses form ordinal %s', (formOrdinal) =>
    expect(
      createPublicSourceReviewSchema.safeParse({
        ...body,
        target: {
          kind: 'vibhaag_indicator',
          page: 'contact',
          formOrdinal,
          controlOrdinal: 1,
          expectedContentSha256: 'a'.repeat(64),
        },
      }).success,
    ).toBe(false),
  );
  it.each([0, 524289, 1.5])('refuses control ordinal %s', (controlOrdinal) =>
    expect(
      createPublicSourceReviewSchema.safeParse({
        ...body,
        target: {
          kind: 'vibhaag_indicator',
          page: 'contact',
          formOrdinal: 1,
          controlOrdinal: controlOrdinal,
          expectedContentSha256: 'a'.repeat(64),
        },
      }).success,
    ).toBe(false),
  );
  it.each(['confirmed', 'adjusted', 'overridden', 'dismissed'])(
    'refuses nonstructural decision %s',
    (decision) =>
      expect(createPublicSourceReviewSchema.safeParse({ ...body, decision }).success).toBe(false),
  );
  it('accepts strict retained metadata', () =>
    expect(publicSourceReviewSchema.parse(review)).toEqual(review));
  it.each(Object.keys(review))('requires retained field %s', (key) => {
    const value = { ...review };
    delete value[key as keyof typeof value];
    expect(publicSourceReviewSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    'source_creation_receipt',
    'completion_receipt',
    'settlement_receipt',
    'review_receipt',
  ])('bounds positive receipt %s', (key) => {
    for (const value of ['0', '-1', '1.5', '9223372036854775808', 'invalid'])
      expect(publicSourceReviewSchema.safeParse({ ...review, [key]: value }).success).toBe(false);
  });
  it.each([
    'root_content_sha256',
    'projection_sha256',
    'output_sha256',
    'source_request_sha256',
    'source_observation_sha256',
  ])('rejects false digest %s', (key) =>
    expect(publicSourceReviewSchema.safeParse({ ...review, [key]: 'invented' }).success).toBe(
      false,
    ),
  );
  it('rejects Drishti with invented predecessor output', () =>
    expect(publicSourceReviewSchema.safeParse({ ...review, agent: 'drishti' }).success).toBe(
      false,
    ));
  it('accepts Drishti with absent original source observation', () =>
    expect(
      publicSourceReviewSchema.safeParse({
        ...review,
        agent: 'drishti',
        source_observation_id: null,
        source_observation_sha256: null,
      }).success,
    ).toBe(true));
  it('rejects whole record carrying private fields', () =>
    expect(
      publicSourceReviewSchema.safeParse({ ...review, private_facts: { hosting: 'known' } })
        .success,
    ).toBe(false));
  it('rejects whole record with a locator', () =>
    expect(publicSourceReviewSchema.safeParse({ ...review, page: 'root' }).success).toBe(false));
  it('requires indicator parity and truthful source shape', () => {
    const indicator = {
      page: 'contact',
      content_sha256: 'f'.repeat(64),
      form_ordinal: 1,
      control_ordinal: 2,
      input_type: 'email',
      indicator: 'potential_contact_collection',
      requires_human_review: true,
    };
    const row = {
      ...review,
      target_kind: 'vibhaag_indicator',
      page: 'contact',
      form_ordinal: 1,
      control_ordinal: 2,
      content_sha256: indicator.content_sha256,
      source_indicator: indicator,
    };
    expect(publicSourceReviewSchema.safeParse(row).success).toBe(true);
    for (const mutation of [
      { page: 'root' },
      { form_ordinal: 2 },
      { control_ordinal: 3 },
      { content_sha256: 'c'.repeat(64) },
      { source_indicator: null },
      { agent: 'drishti' },
    ])
      expect(publicSourceReviewSchema.safeParse({ ...row, ...mutation }).success).toBe(false);
  });
  it('rejects self supersession', () =>
    expect(
      publicSourceReviewSchema.safeParse({ ...review, previous_review_id: review.review_id })
        .success,
    ).toBe(false));
  it('retains superseded replay with current false', () =>
    expect(
      publicSourceReviewRecordedResponseSchema.safeParse({
        data: { ...review, is_current: false },
        created: false,
        replayed: true,
      }).success,
    ).toBe(true));
  it.each([
    { created: true, replayed: true },
    { created: false, replayed: false },
    { created: 1, replayed: false },
  ])('rejects false replay flags %o', (flags) =>
    expect(
      publicSourceReviewRecordedResponseSchema.safeParse({ data: review, ...flags }).success,
    ).toBe(false),
  );
  it('requires UUID operation key', () => {
    expect(publicSourceReviewOperationKeySchema.safeParse('not-a-uuid').success).toBe(false);
    expect(publicSourceReviewOperationKeySchema.parse(review.operation_key)).toBe(
      review.operation_key,
    );
  });
});

const scope = {
  tenant_id: review.tenant_id,
  engagement_id: review.engagement_id,
  binding_id: review.binding_id,
  observation_id: review.observation_id,
};
const sqlRecorded = { ...scope, data: review, created: true, replayed: false };
const sqlPage = { ...scope, data: [review], limit: 1, has_more: false, next_cursor: null };
const sqlRequest = {
  ...scope,
  actor_id: review.reviewed_by,
  operation_key: review.operation_key,
  outcome: { state: 'retained', review },
};
describe('source review envelopes preserve authority and provenance', () => {
  it('accepts consistent SQL envelopes', () => {
    expect(publicSourceReviewRecordedSqlSchema.safeParse(sqlRecorded).success).toBe(true);
    expect(publicSourceReviewPageSqlSchema.safeParse(sqlPage).success).toBe(true);
    expect(publicSourceReviewRequestSqlSchema.safeParse(sqlRequest).success).toBe(true);
  });
  it.each(['tenant_id', 'engagement_id', 'binding_id', 'observation_id'] as const)(
    'rejects nested foreign %s in every SQL envelope',
    (key) => {
      const foreign = { ...review, [key]: '99999999-9999-4999-8999-999999999999' };
      expect(
        publicSourceReviewRecordedSqlSchema.safeParse({ ...sqlRecorded, data: foreign }).success,
      ).toBe(false);
      expect(
        publicSourceReviewPageSqlSchema.safeParse({ ...sqlPage, data: [foreign] }).success,
      ).toBe(false);
      expect(
        publicSourceReviewRequestSqlSchema.safeParse({
          ...sqlRequest,
          outcome: { state: 'retained', review: foreign },
        }).success,
      ).toBe(false);
    },
  );
  it.each(['reviewed_by', 'operation_key'] as const)(
    'refuses foreign retained request %s',
    (key) => {
      expect(
        publicSourceReviewRequestSqlSchema.safeParse({
          ...sqlRequest,
          outcome: {
            state: 'retained',
            review: { ...review, [key]: '99999999-9999-4999-8999-999999999999' },
          },
        }).success,
      ).toBe(false);
    },
  );
  it('a newly recorded review is current while an old replay can be superseded', () => {
    expect(
      publicSourceReviewRecordedSqlSchema.safeParse({
        ...sqlRecorded,
        data: { ...review, is_current: false },
      }).success,
    ).toBe(false);
    expect(
      publicSourceReviewRecordedResponseSchema.safeParse({
        data: { ...review, is_current: false },
        created: true,
        replayed: false,
      }).success,
    ).toBe(false);
    expect(
      publicSourceReviewRecordedSqlSchema.safeParse({
        ...sqlRecorded,
        data: { ...review, is_current: false },
        created: false,
        replayed: true,
      }).success,
    ).toBe(true);
  });
  it('not_found exposes no other actor review', () => {
    expect(
      publicSourceReviewRequestSqlSchema.safeParse({
        ...sqlRequest,
        outcome: { state: 'not_found' },
      }).success,
    ).toBe(true);
    expect(
      publicSourceReviewRequestSqlSchema.safeParse({
        ...sqlRequest,
        outcome: { state: 'not_found', review },
      }).success,
    ).toBe(false);
  });
  it('cursor must identify the last retained row only when another page exists', () => {
    const cursor = { created_at: review.created_at, id: review.review_id };
    expect(
      publicSourceReviewPageSqlSchema.safeParse({ ...sqlPage, has_more: true, next_cursor: cursor })
        .success,
    ).toBe(true);
    expect(
      publicSourceReviewPageSqlSchema.safeParse({ ...sqlPage, has_more: true, next_cursor: null })
        .success,
    ).toBe(false);
    expect(
      publicSourceReviewPageSqlSchema.safeParse({ ...sqlPage, next_cursor: cursor }).success,
    ).toBe(false);
    expect(
      publicSourceReviewPageSqlSchema.safeParse({
        ...sqlPage,
        has_more: true,
        next_cursor: { ...cursor, id: '99999999-9999-4999-8999-999999999999' },
      }).success,
    ).toBe(false);
    expect(
      publicSourceReviewPageSqlSchema.safeParse({
        ...sqlPage,
        data: [],
        has_more: true,
        next_cursor: cursor,
      }).success,
    ).toBe(false);
  });
  it('refuses duplicate retained records within a page', () => {
    expect(
      publicSourceReviewPageSqlSchema.safeParse({ ...sqlPage, limit: 2, data: [review, review] })
        .success,
    ).toBe(false);
  });
});
