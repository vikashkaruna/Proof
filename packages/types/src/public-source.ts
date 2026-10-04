import { z } from 'zod';
import { publicFormMetadataSchema } from './public-form-metadata.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receipt = z.string().regex(/^[1-9][0-9]*$/);

/** Database projection hashes use UTF-8 PostgreSQL JSONB::text, codec version 1.
 * They are opaque authority tokens, not TS/Python canonical JSON hashes. */
export const publicSourceBindingSchema = z
  .object({
    tenant_id: uuid,
    engagement_id: uuid,
    check_id: uuid,
    root_content_sha256: digest,
    projection_sha256: digest,
    projection_version: z.literal(1),
  })
  .strict();

const pageSchema = z
  .object({
    page: z.enum(['root', 'privacy', 'contact', 'terms']),
    status: z.enum(['checked', 'unavailable']),
    content_sha256: digest.optional(),
    form_metadata: publicFormMetadataSchema.optional(),
  })
  .strict()
  .refine((page) =>
    page.status === 'checked'
      ? page.content_sha256 !== undefined &&
        (!page.form_metadata || page.form_metadata.sourceSha256 === page.content_sha256)
      : page.content_sha256 === undefined && page.form_metadata === undefined,
  );

export const publicSourceProjectionSchema = z
  .object({ version: z.literal(1), pages: z.array(pageSchema).min(1).max(4) })
  .strict()
  .refine(
    ({ pages }) =>
      pages[0]?.page === 'root' &&
      pages[0]?.status === 'checked' &&
      new Set(pages.map((page) => page.page)).size === pages.length,
  );

export const publicSourcePreviewSchema = z
  .object({
    runtime_binding: publicSourceBindingSchema,
    projection: publicSourceProjectionSchema,
    binding_id: uuid.optional(),
    creation_receipt: receipt.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.runtime_binding.root_content_sha256 === value.projection.pages[0]?.content_sha256 &&
      (value.binding_id === undefined) === (value.creation_receipt === undefined),
  );

export const createPublicSourceBindingSchema = z
  .object({
    checkId: uuid,
    engagementId: uuid,
    expectedRootSha256: digest,
    expectedProjectionSha256: digest,
  })
  .strict();

export const recordedPublicSourceBindingSchema = z
  .object({
    runtime_binding: publicSourceBindingSchema,
    projection: publicSourceProjectionSchema,
    binding_id: uuid,
    creation_receipt: receipt,
    created: z.boolean(),
    replayed: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.created !== value.replayed &&
      value.runtime_binding.root_content_sha256 === value.projection.pages[0]?.content_sha256,
  );

export type PublicSourceBinding = z.infer<typeof publicSourceBindingSchema>;
export type PublicSourceProjection = z.infer<typeof publicSourceProjectionSchema>;
export type PublicSourcePreview = z.infer<typeof publicSourcePreviewSchema>;
