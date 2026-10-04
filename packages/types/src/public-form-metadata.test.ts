import { expect, it } from 'vitest';
import {
  publicFormMetadataSchema,
  PUBLIC_FORM_INPUT_TYPES,
  PUBLIC_FORM_MAX_COUNT,
  type PublicFormMetadata,
} from './public-form-metadata';

const control = {
  ordinal: 2,
  element: 'input' as const,
  inputType: 'email' as const,
  requiredAttribute: true,
  disabledAttribute: false,
};
const form = {
  ordinal: 1,
  method: 'post' as const,
  observedControlCount: 2,
  excludedControlCount: 1,
  controlsTruncated: false,
  controls: [control],
};
const metadata: PublicFormMetadata = {
  version: 1,
  scope: 'static_html_form_descendants',
  sourceSha256: 'a'.repeat(64),
  observedFormCount: 1,
  formsTruncated: false,
  forms: [form],
};

it('accepts bounded static attributes and a genuinely observed zero without coercion', () => {
  expect(publicFormMetadataSchema.parse(metadata)).toEqual(metadata);
  expect(
    publicFormMetadataSchema.parse({ ...metadata, observedFormCount: 0, forms: [] }).forms,
  ).toEqual([]);
});

it.each(PUBLIC_FORM_INPUT_TYPES)('accepts eligible input type %s', (inputType) => {
  expect(
    publicFormMetadataSchema.safeParse({
      ...metadata,
      forms: [{ ...form, controls: [{ ...control, inputType }] }],
    }).success,
  ).toBe(true);
});

it.each(['select', 'textarea'] as const)('accepts %s without an input type', (element) => {
  const { inputType: _inputType, ...attributes } = control;
  expect(
    publicFormMetadataSchema.safeParse({
      ...metadata,
      forms: [{ ...form, controls: [{ ...attributes, element }] }],
    }).success,
  ).toBe(true);
});

const truncated: PublicFormMetadata = {
  ...metadata,
  observedFormCount: 4,
  formsTruncated: true,
  forms: [1, 2, 3].map((ordinal) => ({
    ...form,
    ordinal,
    observedControlCount: 14,
    excludedControlCount: 1,
    controlsTruncated: true,
    controls: Array.from({ length: 12 }, (_, index) => ({ ...control, ordinal: index + 2 })),
  })),
};
it('accepts complete capped projections while retaining larger observed counts', () => {
  expect(publicFormMetadataSchema.parse(truncated)).toEqual(truncated);
});

it.each([
  { ...metadata, rawValue: 'withheld-value' },
  { ...metadata, sourceSha256: 'bad' },
  { ...metadata, version: 2 },
  { ...metadata, scope: 'executed_forms' },
  { ...metadata, observedFormCount: PUBLIC_FORM_MAX_COUNT + 1 },
  { ...metadata, observedFormCount: -1 },
  { ...metadata, observedFormCount: 0 },
  { ...metadata, formsTruncated: true },
  { ...truncated, formsTruncated: false },
  { ...truncated, forms: [...truncated.forms, { ...form, ordinal: 4 }] },
  { ...metadata, forms: [{ ...form, ordinal: 2 }] },
  { ...metadata, forms: [{ ...form, method: 'put' }] },
  { ...metadata, forms: [{ ...form, target: '/private-submit' }] },
  { ...metadata, forms: [{ ...form, excludedControlCount: 3 }] },
  { ...metadata, forms: [{ ...form, controls: [] }] },
  { ...metadata, forms: [{ ...form, controlsTruncated: true }] },
  { ...metadata, forms: [{ ...form, controls: [{ ...control, ordinal: 3 }] }] },
  { ...metadata, forms: [{ ...form, controls: [{ ...control, name: 'private-name' }] }] },
  { ...metadata, forms: [{ ...form, controls: [{ ...control, inputType: 'password' }] }] },
  { ...metadata, forms: [{ ...form, controls: [{ ...control, inputType: undefined }] }] },
  { ...metadata, forms: [{ ...form, controls: [{ ...control, element: 'select' }] }] },
  { ...metadata, forms: [{ ...form, controls: [{ ...control, requiredAttribute: 'false' }] }] },
  {
    ...truncated,
    forms: [{ ...truncated.forms[0]!, controlsTruncated: false }, ...truncated.forms.slice(1)],
  },
  {
    ...truncated,
    forms: [
      {
        ...truncated.forms[0]!,
        controls: truncated.forms[0]!.controls.map((item) => ({ ...item, ordinal: 2 })),
      },
      ...truncated.forms.slice(1),
    ],
  },
])('refuses malformed, unsafe or misleading metadata %#', (invalid) => {
  expect(publicFormMetadataSchema.safeParse(invalid).success).toBe(false);
});
