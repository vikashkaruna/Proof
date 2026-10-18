import { z } from 'zod';

/**
 * Control-library versions approved for public-control review, assessment and
 * report provenance. Mirrors public.approved_catalogue_versions (0159): the
 * database refuses any other version, and these schemas refuse to parse one.
 * Approving a version (item 8b, founder-only) adds it in both places; until
 * then 0.2.0 is not accepted anywhere.
 */
export const APPROVED_LIBRARY_VERSIONS = ['0.1.1'] as const;
export const ApprovedLibraryVersionSchema = z.enum(APPROVED_LIBRARY_VERSIONS);
export type ApprovedLibraryVersion = z.infer<typeof ApprovedLibraryVersionSchema>;
