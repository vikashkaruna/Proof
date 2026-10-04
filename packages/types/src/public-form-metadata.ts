import { z } from 'zod';

export const PUBLIC_FORM_MAX_FORMS = 3;
export const PUBLIC_FORM_MAX_CONTROLS = 12;
// The checker accepts at most 512KiB of HTML; no count can exceed its byte bound.
export const PUBLIC_FORM_MAX_COUNT = 512 * 1024;
export const PUBLIC_FORM_INPUT_TYPES = [
  'text',
  'email',
  'tel',
  'url',
  'search',
  'number',
  'date',
  'datetime-local',
  'time',
  'month',
  'week',
  'color',
  'range',
  'checkbox',
  'radio',
] as const;
const count = z.number().int().min(0).max(PUBLIC_FORM_MAX_COUNT);
const controlSchema = z
  .object({
    ordinal: z.number().int().min(1).max(PUBLIC_FORM_MAX_COUNT),
    element: z.enum(['input', 'select', 'textarea']),
    inputType: z.enum(PUBLIC_FORM_INPUT_TYPES).optional(),
    requiredAttribute: z.boolean(),
    disabledAttribute: z.boolean(),
  })
  .strict()
  .refine((control) => (control.element === 'input') === (control.inputType !== undefined));
const formSchema = z
  .object({
    ordinal: z.number().int().min(1).max(PUBLIC_FORM_MAX_FORMS),
    method: z.enum(['get', 'post', 'dialog']),
    observedControlCount: count,
    excludedControlCount: count,
    controlsTruncated: z.boolean(),
    controls: z.array(controlSchema).max(PUBLIC_FORM_MAX_CONTROLS),
  })
  .strict()
  .refine((form) => {
    const eligible = form.observedControlCount - form.excludedControlCount;
    return (
      eligible >= 0 &&
      form.controls.length === Math.min(eligible, PUBLIC_FORM_MAX_CONTROLS) &&
      form.controlsTruncated === eligible > PUBLIC_FORM_MAX_CONTROLS &&
      form.controls.every(
        (control, i) =>
          control.ordinal <= form.observedControlCount &&
          (i === 0 || control.ordinal > form.controls[i - 1]!.ordinal),
      )
    );
  });

/** Only source-bound static attributes; never values, labels, identifiers or submission targets. */
export const publicFormMetadataSchema = z
  .object({
    version: z.literal(1),
    scope: z.literal('static_html_form_descendants'),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    observedFormCount: count,
    formsTruncated: z.boolean(),
    forms: z.array(formSchema).max(PUBLIC_FORM_MAX_FORMS),
  })
  .strict()
  .refine(
    (metadata) =>
      metadata.forms.length === Math.min(metadata.observedFormCount, PUBLIC_FORM_MAX_FORMS) &&
      metadata.formsTruncated === metadata.observedFormCount > PUBLIC_FORM_MAX_FORMS &&
      metadata.forms.every((form, index) => form.ordinal === index + 1),
  );
export type PublicFormMetadata = z.infer<typeof publicFormMetadataSchema>;
