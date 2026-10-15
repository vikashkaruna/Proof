import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
  publicControlCatalogueV2Manifest,
  publicEvidenceCatalogueRowsMatchV2,
} from '@axiom/control-library';
import { publicControlAssessmentV2Schema } from '@axiom/types';
import { encodePublicEvidencePayloadV2 } from './public-evidence-codec-v2';
import { evaluatePublicEvidenceV2 } from './public-evidence-evaluator-v2';
const digest = 'a'.repeat(64);
const text = PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT;
const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
function source() {
  return {
    version: 2,
    tenantId: '11111111-1111-4111-8111-111111111111',
    engagementId: '22222222-2222-4222-8222-222222222222',
    checkId: '33333333-3333-4333-8333-333333333333',
    projectionSha256: digest,
    assessmentDate: '2026-10-15',
    extractorVersion: 'static-public-2',
    pages: [
      {
        page: 'root',
        state: 'examined',
        contentSha256: digest,
        coverageReasons: [] as string[],
        truncated: false,
      },
      {
        page: 'privacy',
        state: 'examined',
        contentSha256: digest,
        coverageReasons: [] as string[],
        truncated: false,
      },
      {
        page: 'terms',
        state: 'examined',
        contentSha256: digest,
        coverageReasons: [] as string[],
        truncated: false,
      },
    ],
    candidates: [
      {
        ordinal: 1,
        facet: 'privacy_notice',
        kind: 'public_declaration',
        context: 'quoted',
        locator: { page: 'privacy', contentSha256: digest, elementOrdinal: 1 },
        excerpt: 'We explain our processing purposes',
        textDisposition: 'redacted_public_text',
        requiresHumanReview: true,
      },
    ],
    candidatesTruncated: false,
    scope: 'bounded_public_pages',
    requiresHumanReview: true,
  };
}
function seal(input: { source: ReturnType<typeof source> }) {
  const {
    version,
    extractorVersion,
    pages,
    candidates,
    candidatesTruncated,
    scope,
    requiresHumanReview,
  } = input.source;
  input.source.projectionSha256 = encodePublicEvidencePayloadV2({
    version,
    extractorVersion,
    pages,
    candidates,
    candidatesTruncated,
    scope,
    requiresHumanReview,
  }).payloadSha256;
  return input;
}
function request() {
  const input = { source: source(), catalogueManifestText: text, catalogueManifestSha256: sha256 };
  seal(input);
  return input;
}

const retained = () => ({ text, sha256 });
function row(result: ReturnType<typeof evaluatePublicEvidenceV2>, id: string, q = 'Q1') {
  return result.controls
    .find((c) => c.controlId === id)!
    .questions.find((question) => question.questionId === q)!.evidence;
}
describe('pure public evidence v2 evaluator', () => {
  it('derives all exact catalogue rows without operational compliance claims', () => {
    const result = evaluatePublicEvidenceV2(request(), retained());
    expect(result.controls).toHaveLength(46);
    expect(publicControlAssessmentV2Schema.safeParse(result).success).toBe(true);
    expect(publicEvidenceCatalogueRowsMatchV2(result.controls)).toBe(true);
    expect(result.controls.map((c) => c.controlId)).toEqual(
      publicControlCatalogueV2Manifest().controls.map((c) => c.control.id),
    );
    const manifest = publicControlCatalogueV2Manifest();
    for (const [index, control] of result.controls.entries()) {
      for (const [requirementIndex, requirement] of control.evidenceRequirements.entries()) {
        expect(requirement.internalVerificationRequired).toBe(true);
        if (
          manifest.controls[index]!.evidenceRequirements[requirementIndex]!.publicCandidateFacets
            .length === 0
        )
          expect(requirement.evidence.state).toBe('internal_unknown');
      }
    }
    expect(
      result.controls.find((c) => c.controlId === 'DPDPA-GOV-002')!.evidenceRequirements[0]!
        .evidence.state,
    ).toBe('declared_only');
    expect(row(result, 'DPDPA-GOV-002').state).toBe('declared_only');
    expect(result.controls.filter((c) => c.applicability === 'conditional_unknown')).toHaveLength(
      5,
    );
  });
  it.each([
    'request_hash',
    'retained_hash',
    'request_text',
    'retained_text',
    'both_text',
    'unknown_key',
    'forged_rows',
    'source_hash',
    'raw_secret',
  ])('refuses mismatched provenance or source: %s', (mode) => {
    const input = request();
    const trusted = retained();
    switch (mode) {
      case 'request_hash':
        input.catalogueManifestSha256 = 'b'.repeat(64);
        break;
      case 'retained_hash':
        trusted.sha256 = 'b'.repeat(64);
        break;
      case 'request_text':
        input.catalogueManifestText = ' ' + text.slice(1);
        break;
      case 'retained_text':
        trusted.text = ' ' + text.slice(1);
        break;
      case 'both_text':
        input.catalogueManifestText = ' ' + text.slice(1);
        trusted.text = input.catalogueManifestText;
        trusted.sha256 = createHash('sha256').update(trusted.text).digest('hex');
        input.catalogueManifestSha256 = trusted.sha256;
        break;
      case 'unknown_key':
        Object.assign(trusted, { published: true });
        break;
      case 'forged_rows':
        Object.assign(input, { controls: [{ controlId: 'DPDPA-FAKE-001', pass: true }] });
        break;
      case 'source_hash':
        input.source.candidates[0]!.locator.contentSha256 = 'b'.repeat(64);
        break;
      case 'raw_secret':
        input.source.candidates[0]!.excerpt = 'Bearer do-not-echo';
        break;
    }
    expect(() => evaluatePublicEvidenceV2(input, trusted)).toThrow(
      /^public_evidence_(input|catalogue)_refused$/,
    );
    try {
      evaluatePublicEvidenceV2(input, trusted);
    } catch (error) {
      expect(String(error)).not.toContain('do-not-echo');
    }
  });
  it('does not let an unrelated contact failure invalidate observed notice evidence or absence in complete privacy scope', () => {
    const input = request();
    input.source.pages.push({
      page: 'contact',
      state: 'unavailable',
      coverageReasons: [] as string[],
      truncated: false,
    } as (typeof input.source.pages)[number]);
    expect(
      row(evaluatePublicEvidenceV2((seal(input), input), retained()), 'DPDPA-GOV-002').state,
    ).toBe('declared_only');
    input.source.candidates = [];
    expect(
      row(evaluatePublicEvidenceV2((seal(input), input), retained()), 'DPDPA-GOV-002').state,
    ).toBe('not_observed_in_scope');
  });
  it.each(['missing', 'unexamined', 'unavailable', 'page_truncated', 'candidate_truncated'])(
    'retains incomplete relevant coverage: %s',
    (mode) => {
      const input = request();
      input.source.candidates = [];
      if (mode === 'missing')
        input.source.pages = input.source.pages.filter((p) => p.page !== 'privacy');
      if (mode === 'unexamined' || mode === 'unavailable')
        input.source.pages[1] = {
          page: 'privacy',
          state: mode,
          coverageReasons: [] as string[],
          truncated: false,
        } as (typeof input.source.pages)[number];
      if (mode === 'page_truncated') {
        input.source.pages[1]!.truncated = true;
        input.source.pages[1]!.coverageReasons = ['excerpt_limit'];
      }
      if (mode === 'candidate_truncated') input.source.candidatesTruncated = true;
      expect(
        row(evaluatePublicEvidenceV2((seal(input), input), retained()), 'DPDPA-GOV-002').state,
      ).toBe(
        mode === 'unavailable'
          ? 'source_unavailable'
          : mode.endsWith('truncated')
            ? 'source_truncated'
            : 'internal_unknown',
      );
    },
  );
  it('uses question-specific facets and preserves both kinds plus demo and quoted context', () => {
    const input = request();
    input.source.candidates = [
      {
        ...input.source.candidates[0]!,
        ordinal: 1,
        facet: 'data_items_purposes',
        kind: 'static_observation',
        context: 'demo',
      },
      {
        ...input.source.candidates[0]!,
        ordinal: 2,
        facet: 'notice_at_collection',
        kind: 'public_declaration',
        context: 'quoted',
      },
    ];
    const result = evaluatePublicEvidenceV2((seal(input), input), retained());
    expect(row(result, 'DPDPA-CNS-002').state).toBe('mixed_public_evidence');
    expect(row(result, 'DPDPA-CNS-002').candidateOrdinals).toEqual([1, 2]);
    expect(row(result, 'DPDPA-CNS-002', 'Q2').candidateOrdinals).toEqual([]);
    expect(row(result, 'DPDPA-GOV-002').candidateOrdinals).toEqual([]);
    expect(result.source.candidates.map((c) => c.context)).toEqual(['demo', 'quoted']);
    expect(result.requiresHumanReview).toBe(true);
  });
  it('never uses a wrong facet as evidence and leaves non-public questions internally unknown', () => {
    const input = request();
    input.source.candidates[0]!.facet = 'privacy_contact';
    const result = evaluatePublicEvidenceV2((seal(input), input), retained());
    expect(row(result, 'DPDPA-DPF-001').state).toBe('declared_only');
    expect(row(result, 'DPDPA-GOV-002').state).toBe('not_observed_in_scope');
    expect(row(result, 'DPDPA-SEC-003').state).toBe('internal_unknown');
    expect(row(result, 'DPDPA-DAT-003', 'Q2').state).toBe('internal_unknown');
  });
  it('is deterministic and deeply immutable without mutating inputs', () => {
    const input = request();
    const before = structuredClone(input);
    const result = evaluatePublicEvidenceV2((seal(input), input), retained());
    expect(result).toEqual(evaluatePublicEvidenceV2((seal(input), input), retained()));
    expect(input).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source.candidates[0])).toBe(true);
    expect(Object.isFrozen(result.controls[0]!.questions[0]!.evidence.candidateOrdinals)).toBe(
      true,
    );
  });
});

it('retains mapped document fragments as partial evidence and never closes a screenshot or private requirement', () => {
  const input = request();
  input.source.candidates = [
    {
      ...input.source.candidates[0]!,
      ordinal: 1,
      facet: 'data_items_purposes',
      kind: 'static_observation',
      context: 'demo',
    },
    {
      ...input.source.candidates[0]!,
      ordinal: 2,
      facet: 'notice_at_collection',
      kind: 'public_declaration',
      context: 'ambiguous',
    },
  ];
  const result = evaluatePublicEvidenceV2((seal(input), input), retained());
  const notice = result.controls.find((c) => c.controlId === 'DPDPA-CNS-002')!;
  expect(notice.evidenceRequirements[0]!.evidence).toEqual({
    state: 'mixed_public_evidence',
    candidateOrdinals: [1, 2],
    requiresHumanReview: true,
  });
  expect(notice.evidenceRequirements[0]!.internalVerificationRequired).toBe(true);
  expect(notice.evidenceRequirements[1]!.evidence.state).toBe('internal_unknown');
  expect(
    result.controls
      .find((c) => c.controlId === 'DPDPA-GOV-001')!
      .evidenceRequirements.every((r) => r.evidence.state === 'internal_unknown'),
  ).toBe(true);
});

it.each(['payload', 'hash'])('rejects a mutated actual projection %s', (mode) => {
  const input = request();
  if (mode === 'payload') input.source.candidates[0]!.excerpt = 'Changed retained notice';
  else input.source.projectionSha256 = 'b'.repeat(64);
  expect(() => evaluatePublicEvidenceV2(input, retained())).toThrow(
    'public_evidence_codec_refused',
  );
});
