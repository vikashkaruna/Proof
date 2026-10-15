import { describe, expect, it } from 'vitest';
import { controls } from './controls';
import {
  PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT,
  publicControlCatalogueV2Manifest,
  publicControlCatalogueV2ManifestSha256,
  publicEvidenceCatalogueRowsMatchV2,
} from './public-evidence-mapping-v2';

function rows() {
  return publicControlCatalogueV2Manifest().controls.map((c) => ({
    controlId: c.control.id,
    applicability: c.applicability === 'general' ? 'general' : 'conditional_unknown',
    questions: c.questions.map((q) => ({ questionId: q.questionId })),
    evidenceRequirements: c.evidenceRequirements.map((e) => ({ index: e.index })),
  }));
}
describe('frozen public evidence catalogue v2', () => {
  it('pins exact complete catalogue bytes and provenance', async () => {
    expect(await publicControlCatalogueV2ManifestSha256()).toBe(
      '3bdf816d71e132b23f849f5d5b497d8f0a8874afa124aed31be8652ec6ab31c6',
    );
    const manifest = publicControlCatalogueV2Manifest();
    expect(manifest.controls.map((c) => c.control)).toEqual(controls);
    expect(manifest.provenance).toMatchObject({
      libraryVersion: '0.1.1',
      baseline: 'IN-DPDP@2026-09-20',
      defaultEffectiveFrom: '2027-05-13',
      perControlEffectiveDates: 'not_present_in_source',
    });
    expect(JSON.stringify(manifest)).toBe(PUBLIC_CONTROL_CATALOGUE_V2_MANIFEST_TEXT);
  });
  it('returns defensive copies without mutating immutable catalogue controls', () => {
    const manifest = publicControlCatalogueV2Manifest();
    manifest.controls[0]!.control.title = 'altered';
    expect(publicControlCatalogueV2Manifest().controls[0]!.control.title).toBe(controls[0]!.title);
  });
  it('maps every actual question and evidence requirement without public sufficiency', () => {
    const manifest = publicControlCatalogueV2Manifest();
    expect(manifest.controls).toHaveLength(46);
    for (const c of manifest.controls) {
      expect(c.questions.map((q) => q.questionId)).toEqual(
        c.control.assessmentQuestions.map((q) => q.id),
      );
      expect(c.evidenceRequirements.map((e) => e.requirement)).toEqual(c.control.evidenceRequired);
      expect(
        c.evidenceRequirements.every(
          (e) =>
            e.internalVerificationRequired &&
            e.publicEvidenceSufficiency === 'never_automatically_sufficient',
        ),
      ).toBe(true);
      expect(c.requiresHumanReview).toBe(true);
    }
    expect(
      manifest.controls.filter((c) => c.applicability !== 'general').map((c) => c.control.id),
    ).toEqual([
      'DPDPA-CHD-001',
      'DPDPA-CHD-002',
      'DPDPA-SDF-001',
      'DPDPA-SDF-002',
      'DPDPA-SDF-003',
    ]);
    expect(
      manifest.controls.find((c) => c.control.id === 'DPDPA-DAT-003')!.questions[1]!
        .publicCandidateFacets,
    ).toEqual([]);
    expect(
      manifest.controls.find((c) => c.control.id === 'DPDPA-CNS-001')!.questions[1]!
        .publicCandidateFacets,
    ).toEqual(['notice_at_collection']);
  });
  it('accepts only all exact ordered question and requirement identities', () => {
    expect(publicEvidenceCatalogueRowsMatchV2(rows())).toBe(true);
    const missing = rows();
    missing.pop();
    expect(publicEvidenceCatalogueRowsMatchV2(missing)).toBe(false);
    const wrong = rows();
    wrong[0]!.controlId = 'DPDPA-BOGUS-001';
    expect(publicEvidenceCatalogueRowsMatchV2(wrong)).toBe(false);
    const q = rows();
    q[0]!.questions[0]!.questionId = 'Q99';
    expect(publicEvidenceCatalogueRowsMatchV2(q)).toBe(false);
    const e = rows();
    e[0]!.evidenceRequirements.pop();
    expect(publicEvidenceCatalogueRowsMatchV2(e)).toBe(false);
    const a = rows();
    a.find((c) => c.controlId === 'DPDPA-CHD-001')!.applicability = 'general';
    expect(publicEvidenceCatalogueRowsMatchV2(a)).toBe(false);
  });
});

it('exposes only eight individually reviewed partial-public requirement facet sets', () => {
  const mapped = publicControlCatalogueV2Manifest().controls.flatMap((control) =>
    control.evidenceRequirements.flatMap((requirement) =>
      requirement.publicCandidateFacets.length
        ? [
            {
              id: control.control.id,
              index: requirement.index,
              facets: requirement.publicCandidateFacets,
            },
          ]
        : [],
    ),
  );
  expect(mapped).toEqual([
    { id: 'DPDPA-GOV-002', index: 0, facets: ['privacy_notice'] },
    { id: 'DPDPA-CNS-002', index: 0, facets: ['notice_at_collection', 'data_items_purposes'] },
    { id: 'DPDPA-CNS-005', index: 0, facets: ['data_items_purposes'] },
    { id: 'DPDPA-DAT-003', index: 0, facets: ['grievance_contact'] },
    { id: 'DPDPA-DAT-004', index: 1, facets: ['nomination'] },
    { id: 'DPDPA-CHD-001', index: 1, facets: ['children_statement'] },
    { id: 'DPDPA-SDF-001', index: 1, facets: ['dpo_contact'] },
    { id: 'DPDPA-RTN-001', index: 0, facets: ['retention_statement'] },
  ]);
  for (const control of publicControlCatalogueV2Manifest().controls) {
    expect(
      control.evidenceRequirements
        .filter((r) => r.requirement.type === 'screenshot')
        .every((r) => r.publicCandidateFacets.length === 0),
    ).toBe(true);
  }
});
