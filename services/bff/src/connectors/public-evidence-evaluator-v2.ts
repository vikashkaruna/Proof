import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyPublicControlSourceV2 } from './public-evidence-codec-v2.js';
import {
  publicControlCatalogueManifestText,
  publicControlCatalogueV2Manifest,
  publicEvidenceCatalogueRowsMatchV2,
} from '@axiom/control-library';
import {
  publicControlSourceV2Schema,
  publicControlAssessmentV2Schema,
  type PublicControlSourceV2,
  type PublicControlAssessmentV2,
} from '@axiom/types';

const manifestSchema = z
  .object({
    text: z.string().min(2).max(1048576),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const inputSchema = z
  .object({
    source: publicControlSourceV2Schema,
    catalogueManifestText: z.string().min(2).max(1048576),
    catalogueManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;
type Disposition = PublicControlAssessmentV2['controls'][number]['questions'][number]['evidence'];
type PageKind = PublicControlSourceV2['pages'][number]['page'];
const noticePages: readonly PageKind[] = ['root', 'privacy', 'terms', 'consent'];
const formPages: readonly PageKind[] = ['root', 'contact', 'consent'];
const relevantPages: Readonly<Record<string, readonly PageKind[]>> = {
  privacy_notice: ['root', 'privacy'],
  consent_ui: formPages,
  notice_at_collection: ['root', 'privacy', 'contact', 'consent'],
  parental_consent_ui: formPages,
  privacy_contact: ['root', 'privacy', 'contact', 'consent'],
  grievance_contact: ['root', 'privacy', 'contact', 'consent'],
  dpo_contact: ['root', 'privacy', 'contact', 'consent'],
};

function disposition(source: PublicControlSourceV2, facets: readonly string[]): Disposition {
  if (facets.length === 0)
    return { state: 'internal_unknown', candidateOrdinals: [], requiresHumanReview: true };
  const candidates = source.candidates.filter((candidate) => facets.includes(candidate.facet));
  if (candidates.length > 0) {
    const kinds = new Set(candidates.map((candidate) => candidate.kind));
    return {
      state:
        kinds.size === 2
          ? 'mixed_public_evidence'
          : kinds.has('static_observation')
            ? 'public_candidate'
            : 'declared_only',
      candidateOrdinals: candidates.map((candidate) => candidate.ordinal),
      requiresHumanReview: true,
    };
  }
  const expected = new Set(facets.flatMap((facet) => relevantPages[facet] ?? noticePages));
  const pages = source.pages.filter((page) => expected.has(page.page));
  // Missing/unexamined pages never establish universal absence. A qualified
  // non-observation means only the complete bounded relevant page set below.
  const state =
    source.candidatesTruncated || pages.some((page) => page.truncated)
      ? 'source_truncated'
      : pages.some((page) => page.state === 'unavailable')
        ? 'source_unavailable'
        : pages.length !== expected.size || pages.some((page) => page.state !== 'examined')
          ? 'internal_unknown'
          : 'not_observed_in_scope';
  return { state, candidateOrdinals: [], requiresHumanReview: true };
}

function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
}

/** Pure deterministic evaluator. The SECOND parameter must come from a trusted
 * server publication verifier, never a client assertion. This function compares
 * exact bytes/hash but does not authenticate publication custody or source hashes.
 * The caller must authenticate the tenant-owned retained check/projection and
 * publication before calling. A read-only control-evidence preview must remain
 * explicitly unreviewed; an agent result or released assessment additionally
 * requires its own durable settlement and human review workflow.
 * Validation failures are sanitized: no supplied notice text or secret is echoed.
 */
export function evaluatePublicEvidenceV2(
  input: unknown,
  retainedPublishedManifest: unknown,
): DeepReadonly<PublicControlAssessmentV2> {
  const request = inputSchema.safeParse(input);
  const retained = manifestSchema.safeParse(retainedPublishedManifest);
  if (!request.success || !retained.success) throw new Error('public_evidence_input_refused');
  let libraryVersion: string;
  try {
    const parsed = JSON.parse(retained.data.text) as { provenance?: { libraryVersion?: unknown } };
    if (typeof parsed.provenance?.libraryVersion !== 'string') throw Error();
    libraryVersion = parsed.provenance.libraryVersion;
  } catch {
    throw new Error('public_evidence_catalogue_refused');
  }
  let canonicalText: string;
  try {
    canonicalText = publicControlCatalogueManifestText(libraryVersion);
  } catch {
    throw new Error('public_evidence_catalogue_refused');
  }
  const canonicalHash = createHash('sha256').update(canonicalText, 'utf8').digest('hex');
  if (
    request.data.catalogueManifestText !== retained.data.text ||
    request.data.catalogueManifestSha256 !== retained.data.sha256 ||
    retained.data.text !== canonicalText ||
    retained.data.sha256 !== canonicalHash
  )
    throw new Error('public_evidence_catalogue_refused');
  const source = verifyPublicControlSourceV2(request.data.source);
  const manifest = publicControlCatalogueV2Manifest(libraryVersion);
  const result = publicControlAssessmentV2Schema.parse({
    version: 2,
    source,
    catalogue: {
      libraryVersion: manifest.provenance.libraryVersion,
      baseline: manifest.provenance.baseline,
      manifestSha256: canonicalHash,
      mappingVersion: manifest.mappingVersion,
      defaultEffectiveFrom: manifest.provenance.defaultEffectiveFrom,
      perControlEffectiveDates: manifest.provenance.perControlEffectiveDates,
      effectiveStatus: manifest.provenance.effectiveStatus,
    },
    controls: manifest.controls.map((control) => ({
      controlId: control.control.id,
      applicability: control.applicability === 'general' ? 'general' : 'conditional_unknown',
      questions: control.questions.map((question) => ({
        questionId: question.questionId,
        evidence: disposition(source, question.publicCandidateFacets),
      })),
      evidenceRequirements: control.evidenceRequirements.map((requirement) => ({
        index: requirement.index,
        evidence: disposition(source, requirement.publicCandidateFacets),
        internalVerificationRequired: true,
      })),
      requiresHumanReview: true,
    })),
    requiresHumanReview: true,
  });
  if (!publicEvidenceCatalogueRowsMatchV2(result.controls, libraryVersion))
    throw new Error('public_evidence_catalogue_refused');
  freeze(result);
  return result;
}
