import { z } from 'zod';
import { publicSourceBindingSchema, publicSourceProjectionSchema } from './public-source';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const pageKind = z.enum(['root', 'privacy', 'contact', 'terms']);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePage = publicSourceProjectionSchema.shape.pages.element;
const privateFacts = z
  .object({
    hosting_region: z.literal('unknown'),
    backend_personal_data: z.literal('unknown'),
    cross_border_processing: z.literal('unknown'),
  })
  .strict();

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
    );
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equalJson(a[key], b[key]))
  );
}

const source = publicSourceProjectionSchema
  .safeExtend({ binding: publicSourceBindingSchema })
  .refine((value) => value.binding.root_content_sha256 === value.pages[0]?.content_sha256);

const observationPage = sourcePage
  .safeExtend({ form_state: z.enum(['observed', 'unexamined', 'unavailable']) })
  .refine(
    (page) =>
      page.form_state ===
      (page.status === 'unavailable'
        ? 'unavailable'
        : page.form_metadata === undefined
          ? 'unexamined'
          : 'observed'),
  );

export const publicWebsiteObservationSchema = z
  .object({
    version: z.literal(1),
    binding: publicSourceBindingSchema,
    pages: z.array(observationPage).min(1).max(4),
    private_facts: privateFacts,
    requires_human_review: z.literal(true),
  })
  .strict()
  .refine(
    ({ binding, pages }) =>
      pages[0]?.page === 'root' &&
      pages[0]?.status === 'checked' &&
      binding.root_content_sha256 === pages[0]?.content_sha256 &&
      new Set(pages.map((page) => page.page)).size === pages.length,
  );

export const drishtiPublicInputSchema = z
  .object({
    mode: z.literal('public_website'),
    tenant_id: uuid,
    engagement_id: uuid,
    source,
  })
  .strict()
  .refine(
    (value) =>
      value.tenant_id === value.source.binding.tenant_id &&
      value.engagement_id === value.source.binding.engagement_id,
  );

export const drishtiPublicOutputSchema = z
  .object({ mode: z.literal('public_website'), observation: publicWebsiteObservationSchema })
  .strict();

export const vibhaagPublicInputSchema = z
  .object({
    mode: z.literal('public_website'),
    tenant_id: uuid,
    engagement_id: uuid,
    source_binding: publicSourceBindingSchema,
    observation: publicWebsiteObservationSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.tenant_id === value.source_binding.tenant_id &&
      value.engagement_id === value.source_binding.engagement_id &&
      equalJson(value.source_binding, value.observation.binding),
  );

export const vibhaagPublicOutputSchema = z
  .object({
    mode: z.literal('public_website'),
    source_binding: publicSourceBindingSchema,
    indicators: z
      .array(
        z
          .object({
            page: pageKind,
            content_sha256: digest,
            form_ordinal: z.number().int().min(1).max(3),
            control_ordinal: z
              .number()
              .int()
              .min(1)
              .max(512 * 1024),
            input_type: z.enum(['email', 'tel']),
            indicator: z.literal('potential_contact_collection'),
            requires_human_review: z.literal(true),
          })
          .strict(),
      )
      .max(4 * 3 * 12),
    private_facts: privateFacts,
    unexamined_pages: z.array(pageKind).max(4),
    unavailable_pages: z.array(pageKind).max(4),
    scope_limited: z.literal(true),
  })
  .strict()
  .refine((value) => {
    const locators = value.indicators.map(
      (indicator) => `${indicator.page}/${indicator.form_ordinal}/${indicator.control_ordinal}`,
    );
    const states = [...value.unexamined_pages, ...value.unavailable_pages];
    return (
      new Set(locators).size === locators.length &&
      new Set(states).size === states.length &&
      value.indicators.every((indicator) => !states.includes(indicator.page))
    );
  });

/** Validate actual output against its stored input, not only its standalone shape. */
export const drishtiPublicResultSchema = z
  .object({ input: drishtiPublicInputSchema, output: drishtiPublicOutputSchema })
  .strict()
  .refine(({ input, output }) => {
    const pages = input.source.pages.map((page) => ({
      ...page,
      form_state:
        page.status === 'unavailable'
          ? 'unavailable'
          : page.form_metadata === undefined
            ? 'unexamined'
            : 'observed',
    }));
    return (
      equalJson(input.source.binding, output.observation.binding) &&
      equalJson(pages, output.observation.pages)
    );
  });

export const vibhaagPublicResultSchema = z
  .object({ input: vibhaagPublicInputSchema, output: vibhaagPublicOutputSchema })
  .strict()
  .refine(({ input, output }) => {
    const indicators = input.observation.pages.flatMap((page) =>
      page.status !== 'checked'
        ? []
        : (page.form_metadata?.forms ?? []).flatMap((form) =>
            form.controls
              .filter(
                (control) =>
                  control.element === 'input' &&
                  (control.inputType === 'email' || control.inputType === 'tel'),
              )
              .map((control) => ({
                page: page.page,
                content_sha256: page.content_sha256,
                form_ordinal: form.ordinal,
                control_ordinal: control.ordinal,
                input_type: control.inputType,
                indicator: 'potential_contact_collection',
                requires_human_review: true,
              })),
          ),
    );
    return (
      equalJson(input.source_binding, output.source_binding) &&
      equalJson(indicators, output.indicators) &&
      equalJson(
        input.observation.pages
          .filter((page) => page.form_state === 'unexamined')
          .map((p) => p.page),
        output.unexamined_pages,
      ) &&
      equalJson(
        input.observation.pages
          .filter((page) => page.form_state === 'unavailable')
          .map((p) => p.page),
        output.unavailable_pages,
      )
    );
  });

export type DrishtiPublicInput = z.infer<typeof drishtiPublicInputSchema>;
export type DrishtiPublicOutput = z.infer<typeof drishtiPublicOutputSchema>;
export type VibhaagPublicInput = z.infer<typeof vibhaagPublicInputSchema>;
export type VibhaagPublicOutput = z.infer<typeof vibhaagPublicOutputSchema>;

export const createPublicAgentRunSchema = z
  .object({
    engagementId: uuid,
    expectedProjectionSha256: digest,
    observationId: uuid.optional(),
  })
  .strict();

const observationIdentity = z.object({
  observation_id: uuid,
  dispatch_id: uuid,
  binding_id: uuid,
  run_id: uuid,
  output_sha256: digest,
  completion_receipt: z.string().regex(/^[1-9][0-9]{0,18}$/),
});

export const publicAgentObservationSchema = z.discriminatedUnion('agent', [
  observationIdentity
    .extend({ agent: z.literal('drishti'), output: drishtiPublicOutputSchema })
    .strict(),
  observationIdentity
    .extend({ agent: z.literal('vibhaag'), output: vibhaagPublicOutputSchema })
    .strict(),
]);

export type PublicAgentObservation = z.infer<typeof publicAgentObservationSchema>;
