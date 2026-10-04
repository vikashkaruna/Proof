import { describe, expect, it } from 'vitest';
import {
  drishtiPublicInputSchema,
  drishtiPublicOutputSchema,
  drishtiPublicResultSchema,
  publicWebsiteObservationSchema,
  vibhaagPublicInputSchema,
  vibhaagPublicOutputSchema,
  vibhaagPublicResultSchema,
} from './public-source-agents.js';

const binding = {
  tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  engagement_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  check_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  root_content_sha256: 'a'.repeat(64),
  projection_sha256: 'b'.repeat(64),
  projection_version: 1,
};
const privateFacts = {
  hosting_region: 'unknown',
  backend_personal_data: 'unknown',
  cross_border_processing: 'unknown',
};
const emptyMetadata = {
  version: 1,
  scope: 'static_html_form_descendants',
  sourceSha256: 'a'.repeat(64),
  observedFormCount: 0,
  formsTruncated: false,
  forms: [],
};
const contact = {
  page: 'contact',
  status: 'checked',
  content_sha256: 'c'.repeat(64),
  form_metadata: {
    ...emptyMetadata,
    sourceSha256: 'c'.repeat(64),
    observedFormCount: 1,
    forms: [
      {
        ordinal: 1,
        method: 'post',
        observedControlCount: 2,
        excludedControlCount: 0,
        controlsTruncated: false,
        controls: [
          {
            ordinal: 1,
            element: 'input',
            inputType: 'email',
            requiredAttribute: true,
            disabledAttribute: false,
          },
          {
            ordinal: 2,
            element: 'textarea',
            requiredAttribute: false,
            disabledAttribute: false,
          },
        ],
      },
    ],
  },
};
const pages = [
  { page: 'root', status: 'checked', content_sha256: 'a'.repeat(64), form_metadata: emptyMetadata },
  { page: 'privacy', status: 'checked', content_sha256: 'd'.repeat(64) },
  contact,
  { page: 'terms', status: 'unavailable' },
];
const input = {
  mode: 'public_website',
  tenant_id: binding.tenant_id,
  engagement_id: binding.engagement_id,
  source: { version: 1, binding, pages },
};
const observation = {
  version: 1,
  binding,
  pages: pages.map((page) => ({
    ...page,
    form_state:
      page.status === 'unavailable'
        ? 'unavailable'
        : 'form_metadata' in page && page.form_metadata
          ? 'observed'
          : 'unexamined',
  })),
  private_facts: privateFacts,
  requires_human_review: true,
};
const discovery = { mode: 'public_website', observation };
const classificationInput = {
  mode: 'public_website',
  tenant_id: binding.tenant_id,
  engagement_id: binding.engagement_id,
  source_binding: binding,
  observation,
};
const indicator = {
  page: 'contact',
  content_sha256: 'c'.repeat(64),
  form_ordinal: 1,
  control_ordinal: 1,
  input_type: 'email',
  indicator: 'potential_contact_collection',
  requires_human_review: true,
};
const classification = {
  mode: 'public_website',
  source_binding: binding,
  indicators: [indicator],
  private_facts: privateFacts,
  unexamined_pages: ['privacy'],
  unavailable_pages: ['terms'],
  scope_limited: true,
};

describe('stored public agent input/output consistency', () => {
  it('preserves the source, explicit unknowns and all three form states', () => {
    expect(drishtiPublicResultSchema.parse({ input, output: discovery }).output).toEqual(discovery);
    expect(
      vibhaagPublicResultSchema.parse({ input: classificationInput, output: classification })
        .output,
    ).toEqual(classification);
  });

  it.each(['tenant_id', 'engagement_id'])('rejects a different envelope %s', (key) => {
    const foreign = { ...input, [key]: binding.check_id };
    expect(drishtiPublicInputSchema.safeParse(foreign).success).toBe(false);
    expect(
      vibhaagPublicInputSchema.safeParse({ ...classificationInput, [key]: binding.check_id })
        .success,
    ).toBe(false);
  });

  it.each(['check_id', 'root_content_sha256', 'projection_sha256'])(
    'refuses a changed observation binding %s',
    (key) => {
      const value = key.endsWith('sha256') ? 'e'.repeat(64) : binding.engagement_id;
      const changed = { ...observation, binding: { ...binding, [key]: value } };
      expect(
        vibhaagPublicInputSchema.safeParse({ ...classificationInput, observation: changed })
          .success,
      ).toBe(false);
      expect(
        drishtiPublicResultSchema.safeParse({
          input,
          output: { ...discovery, observation: changed },
        }).success,
      ).toBe(false);
    },
  );

  it.each(['hosting_region', 'backend_personal_data', 'cross_border_processing'])(
    'cannot claim a private fact %s',
    (key) => {
      const invented = { ...privateFacts, [key]: key === 'hosting_region' ? 'ap-south-1' : false };
      expect(
        drishtiPublicOutputSchema.safeParse({
          ...discovery,
          observation: { ...observation, private_facts: invented },
        }).success,
      ).toBe(false);
      expect(
        vibhaagPublicOutputSchema.safeParse({ ...classification, private_facts: invented }).success,
      ).toBe(false);
    },
  );

  it.each([false, 1, 'true'])('requires actual human review boolean, refusing %j', (value) => {
    expect(
      publicWebsiteObservationSchema.safeParse({ ...observation, requires_human_review: value })
        .success,
    ).toBe(false);
    expect(
      vibhaagPublicOutputSchema.safeParse({ ...classification, scope_limited: value }).success,
    ).toBe(false);
    expect(
      vibhaagPublicOutputSchema.safeParse({
        ...classification,
        indicators: [{ ...indicator, requires_human_review: value }],
      }).success,
    ).toBe(false);
  });

  it.each(['observed', 'unavailable'])(
    'rejects false form state %s for unexamined privacy',
    (form_state) => {
      const changed = observation.pages.map((page) =>
        page.page === 'privacy' ? { ...page, form_state } : page,
      );
      expect(
        publicWebsiteObservationSchema.safeParse({ ...observation, pages: changed }).success,
      ).toBe(false);
    },
  );

  it('cannot omit or replace checked page facts with another valid observation', () => {
    const rootOnly = { ...observation, pages: observation.pages.slice(0, 1) };
    expect(publicWebsiteObservationSchema.safeParse(rootOnly).success).toBe(true);
    expect(
      drishtiPublicResultSchema.safeParse({
        input,
        output: { ...discovery, observation: rootOnly },
      }).success,
    ).toBe(false);
  });

  it.each(['page', 'content_sha256', 'form_ordinal', 'control_ordinal', 'input_type'])(
    'rejects a substituted indicator %s against its actual source',
    (key) => {
      const replacement: Record<string, unknown> = {
        page: 'root',
        content_sha256: 'd'.repeat(64),
        form_ordinal: 2,
        control_ordinal: 2,
        input_type: 'tel',
      };
      const changed = {
        ...classification,
        indicators: [{ ...indicator, [key]: replacement[key] }],
      };
      expect(vibhaagPublicOutputSchema.safeParse(changed).success).toBe(true);
      expect(
        vibhaagPublicResultSchema.safeParse({ input: classificationInput, output: changed })
          .success,
      ).toBe(false);
    },
  );

  it.each([{ indicators: [] }, { indicators: [indicator, { ...indicator, control_ordinal: 2 }] }])(
    'refuses omitted or invented indicators',
    ({ indicators }) => {
      expect(
        vibhaagPublicResultSchema.safeParse({
          input: classificationInput,
          output: { ...classification, indicators },
        }).success,
      ).toBe(false);
    },
  );

  it('refuses duplicated indicators and inconsistent state arrays', () => {
    expect(
      vibhaagPublicOutputSchema.safeParse({ ...classification, indicators: [indicator, indicator] })
        .success,
    ).toBe(false);
    for (const patch of [
      { unexamined_pages: [] },
      { unavailable_pages: ['contact'] },
      { unavailable_pages: ['privacy'] },
      { unexamined_pages: ['privacy', 'privacy'] },
    ]) {
      expect(
        vibhaagPublicResultSchema.safeParse({
          input: classificationInput,
          output: { ...classification, ...patch },
        }).success,
      ).toBe(false);
    }
  });

  it('cannot put an indicator on a page explicitly marked unexamined or unavailable', () => {
    expect(
      vibhaagPublicOutputSchema.safeParse({
        ...classification,
        unexamined_pages: ['privacy', 'contact'],
      }).success,
    ).toBe(false);
    expect(
      vibhaagPublicOutputSchema.safeParse({
        ...classification,
        unavailable_pages: ['terms', 'contact'],
      }).success,
    ).toBe(false);
  });

  it('refuses empty or duplicate observations without throwing', () => {
    for (const pages of [[], [observation.pages[0], observation.pages[0]]]) {
      expect(publicWebsiteObservationSchema.safeParse({ ...observation, pages }).success).toBe(
        false,
      );
    }
  });

  it('rejects legacy hints, raw HTML and stronger classification claims', () => {
    for (const patch of [{ systems: [] }, { source: { ...input.source, html: '<input>' } }])
      expect(drishtiPublicInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(
      vibhaagPublicInputSchema.safeParse({ ...classificationInput, field_hints: {} }).success,
    ).toBe(false);
    for (const patch of [
      { category: 'contact' },
      { confidence: 0.99 },
      { value: 'person@example.invalid' },
    ])
      expect(
        vibhaagPublicOutputSchema.safeParse({
          ...classification,
          indicators: [{ ...indicator, ...patch }],
        }).success,
      ).toBe(false);
  });
});
